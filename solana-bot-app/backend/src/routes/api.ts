import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { VersionedTransaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import {
  getOrCreateSession,
  getRecentVizEvents,
  pushClusterLog,
  pushSessionLog,
  state,
  subscribeVizEvents
} from "../state/store.js";
import {
  materializePendingUnsignedTxsForSession,
  startWalletSession,
  stopWalletSession
} from "../services/heliusMonitor.js";
import { buildUnsignedBuyLikeTxBase64, buildUnsignedSellLikeTxBase64 } from "../services/txBuilder.js";
import { base64ToBytes, bytesToBase58 } from "../utils/encoding.js";
import { jito } from "../services/jito.js";
import { getWalletMetricsBatch } from "../services/walletMetrics.js";
import {
  ensureTokenMonitoring,
  getRecentTokens,
  subscribeTokenDeployments,
  type PumpFunTokenInfo
} from "../services/pumpfunTokenMonitor.js";

const router = Router();

const clusterSchema = z.enum(["mainnet-beta", "devnet"]);
const ownerSchema = z.string().min(32).max(64);

const configSchema = z.object({
  cluster: clusterSchema.default("mainnet-beta"),
  mode: z.enum(["snipe", "volume"]).default("snipe"),
  pumpFunPhase: z.enum(["pre", "post"]).default("post"),
  snipeTargetMode: z.enum(["list", "auto"]).default("list"),
  autoSnipe: z
    .object({
      maxTxAgeSec: z.number().finite().min(1).max(300).default(20),
      windowSec: z.number().finite().min(1).max(120).default(8),
      minSignalsInWindow: z.number().int().min(1).max(100).default(3),
      minUniqueFeePayersInWindow: z.number().int().min(1).max(100).default(3),
      requireMintAuthorityDisabled: z.boolean().default(true),
      requireFreezeAuthorityDisabled: z.boolean().default(true),
      allowToken2022: z.boolean().default(true),
      maxTop1HolderPct: z.number().finite().min(0).max(100).default(20),
      maxTop10HolderPct: z.number().finite().min(0).max(100).default(60)
    })
    .default({}),
  mevEnabled: z.boolean().default(true),
  buyAmountSol: z.number().finite().positive().max(10_000),
  volumeEnabled: z.boolean().default(true),
  volumeIntervalSec: z.number().finite().min(2).max(3600).default(20),
  // Default: USDC mint (mainnet). User can override for a specific token.
  volumeTokenMint: z.string().min(32).max(64).default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  volumeSlippageBps: z.number().int().min(1).max(5000).default(150),
  volumeRoundtrip: z.boolean().default(true),
  takeProfitPct: z.number().finite().min(0).max(10_000).default(0),
  stopLossPct: z.number().finite().min(0).max(10_000).default(0),
  minLiquiditySol: z.number().finite().min(0).max(10_000).default(0),
  autoSellDelaySec: z.number().finite().min(0).max(86_400).default(0),
  snipeList: z.array(z.string().min(32).max(64)).default([])
});

router.post("/start-monitoring", async (req, res) => {
  const parsed = configSchema.extend({ owner: ownerSchema }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { owner, ...config } = parsed.data;

  pushSessionLog(config.cluster, owner, "info", `Start requested. mode=${config.mode} mev=${config.mevEnabled}`);
  await startWalletSession(owner, config);

  return res.json({ ok: true });
});

router.post("/start-monitoring-batch", async (req, res) => {
  const parsed = configSchema
    .extend({ owners: z.array(ownerSchema).min(1).max(200) })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { owners, ...config } = parsed.data;

  for (const owner of owners) {
    pushSessionLog(config.cluster, owner, "info", `Start requested (batch). mode=${config.mode} mev=${config.mevEnabled}`);
    // sequential to avoid burst load on upstream services
    // eslint-disable-next-line no-await-in-loop
    await startWalletSession(owner, config);
  }

  return res.json({ ok: true, started: owners.length });
});

router.post("/stop-monitoring", async (req, res) => {
  const parsed = z
    .object({ cluster: clusterSchema.default("mainnet-beta"), owner: ownerSchema })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  await stopWalletSession(parsed.data.cluster, parsed.data.owner);
  return res.json({ ok: true });
});

router.post("/stop-monitoring-batch", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owners: z.array(ownerSchema).min(1).max(200)
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { cluster, owners } = parsed.data;

  for (const owner of owners) {
    // eslint-disable-next-line no-await-in-loop
    await stopWalletSession(cluster, owner);
  }
  return res.json({ ok: true, stopped: owners.length });
});

router.get("/viz/stream", (req, res) => {
  const cluster = clusterSchema.catch("mainnet-beta").parse(req.query.cluster);
  const owner = ownerSchema.optional().parse(req.query.owner);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Hint to reverse proxies (nginx) not to buffer SSE.
  res.setHeader("X-Accel-Buffering", "no");

  const write = (eventName: string | null, data: unknown) => {
    if (eventName) res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  write("hello", { ts: Date.now(), cluster, owner: owner ?? null });

  // Send a small backlog so the UI can "warm up" instantly.
  const recent = getRecentVizEvents().filter((e) => {
    if (e.cluster !== cluster) return false;
    if (owner && e.owner !== owner) return false;
    return true;
  });
  for (const e of recent) write(null, e);

  const unsubscribe = subscribeVizEvents((e) => {
    if (e.cluster !== cluster) return;
    if (owner && e.owner !== owner) return;
    write(null, e);
  });

  const keepAlive = setInterval(() => {
    // Keep connections alive across load balancers.
    write("ping", { ts: Date.now() });
  }, 15_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

router.get("/status", async (req, res) => {
  const cluster = clusterSchema.catch("mainnet-beta").parse(req.query.cluster);
  const owner = ownerSchema.optional().parse(req.query.owner);

  const runtime = state[cluster];

  const sessions = Array.from(runtime.sessions.values()).map((s) => ({
    owner: s.owner,
    running: s.running,
    mode: s.config?.mode ?? null,
    pumpFunPhase: s.config?.pumpFunPhase ?? null,
    mevEnabled: s.config?.mevEnabled ?? null
  }));

  if (!owner) {
    // IMPORTANT: keep response shape stable so the frontend polling loop
    // doesn't "wipe" UI state during wallet reconnects (owner temporarily undefined).
    return res.json({
      ok: true,
      running: false,
      cluster,
      // Back-compat field (frontend now prefers clusterLogs/sessionLogs).
      logs: runtime.clusterLogs,
      clusterLogs: runtime.clusterLogs,
      sessionLogs: [],
      bundles: [],
      pendingAction: null,
      sessions,
      owner: null
    });
  }

  const session = getOrCreateSession(cluster, owner);

  if (session.pendingAction && (session.pendingAction as any).needsUnsignedTxs) {
    try {
      const unsignedTxsBase64 = await materializePendingUnsignedTxsForSession({ cluster, owner });
      if (unsignedTxsBase64 && session.pendingAction) {
        session.pendingAction.unsignedTxsBase64 = unsignedTxsBase64;
        delete (session.pendingAction as any).needsUnsignedTxs;
      }
    } catch (e: any) {
      pushSessionLog(cluster, owner, "error", `Failed to build unsigned txs: ${e?.message ?? String(e)}`);
      session.pendingAction = null;
      // Avoid tight retry loops in volume mode when Jupiter has no route.
      if (session.config?.mode === "volume") (session as any)._lastVolumeActionMs = Date.now();
    }
  }

  const bundles = Array.from(session.bundles.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
  const logs = [...runtime.clusterLogs, ...session.logs].sort((a, b) => a.ts - b.ts);

  return res.json({
    ok: true,
    running: session.running,
    cluster,
    owner,
    // Back-compat field (frontend now prefers clusterLogs/sessionLogs).
    logs,
    clusterLogs: runtime.clusterLogs,
    sessionLogs: session.logs,
    bundles,
    pendingAction: session.pendingAction,
    sessions
  });
});

router.post("/status-batch", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owners: z.array(ownerSchema).min(1).max(200)
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { cluster, owners } = parsed.data;
  const runtime = state[cluster];

  const items = owners.map((owner) => {
    const s = getOrCreateSession(cluster, owner);
    const lastLog = s.logs.length ? s.logs[s.logs.length - 1] : null;
    return {
      owner,
      running: s.running,
      mode: s.config?.mode ?? null,
      pumpFunPhase: s.config?.pumpFunPhase ?? null,
      mevEnabled: s.config?.mevEnabled ?? null,
      pendingAction: s.pendingAction
        ? { type: s.pendingAction.type, reason: s.pendingAction.reason }
        : null,
      lastLog
    };
  });

  return res.json({
    ok: true,
    cluster,
    clusterLogs: runtime.clusterLogs,
    items
  });
});

router.post("/fleet-metrics", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owners: z.array(ownerSchema).min(1).max(50)
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  try {
    const metrics = await getWalletMetricsBatch({
      cluster: parsed.data.cluster,
      owners: parsed.data.owners,
      ttlMs: 20_000,
      sigLimit: 100
    });
    return res.json({ ok: true, cluster: parsed.data.cluster, metrics });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "fleet-metrics failed" });
  }
});

router.post("/prepare-buy", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owner: z.string().min(32).max(64),
      amountSol: z.number().finite().positive().max(10_000),
      memo: z.string().max(200).default("manual")
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  try {
    const unsignedTxBase64 = await buildUnsignedBuyLikeTxBase64({
      cluster: parsed.data.cluster,
      owner: parsed.data.owner,
      amountSol: parsed.data.amountSol,
      memo: parsed.data.memo
    });
    return res.json({ ok: true, unsignedTxBase64 });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "Failed to build tx" });
  }
});

router.post("/prepare-sell", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owner: z.string().min(32).max(64),
      memo: z.string().max(200).default("manual")
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  try {
    const unsignedTxBase64 = await buildUnsignedSellLikeTxBase64({
      cluster: parsed.data.cluster,
      owner: parsed.data.owner,
      memo: parsed.data.memo
    });
    return res.json({ ok: true, unsignedTxBase64 });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "Failed to build tx" });
  }
});

// Used by the frontend when executing a pending action via public RPC (MEV disabled).
router.post("/ack-action", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owner: ownerSchema
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { cluster, owner } = parsed.data;
  const session = getOrCreateSession(cluster, owner);
  session.pendingAction = null;
  pushSessionLog(cluster, owner, "info", "Pending action acknowledged/cleared by client.");
  return res.json({ ok: true });
});

function isSystemTransferToTipAccount(tx: VersionedTransaction, tipAccounts: Set<string>) {
  const msg = tx.message;
  const keys = msg.getAccountKeys();
  const staticKeys = keys.staticAccountKeys;

  for (const ix of msg.compiledInstructions) {
    const programId = staticKeys[ix.programIdIndex];
    if (!programId?.equals(SystemProgram.programId)) continue;

    const data = Buffer.from(ix.data);
    if (data.length < 4 + 8) continue;
    const instruction = data.readUInt32LE(0);
    // SystemProgram.transfer = 2
    if (instruction !== 2) continue;

    const toIndex = ix.accountKeyIndexes[1];
    const to = staticKeys[toIndex];
    if (!to) continue;
    if (tipAccounts.has(to.toBase58())) return true;
  }
  return false;
}

router.post("/prepare-bundle", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owner: ownerSchema,
      signedTxsBase64: z.array(z.string().min(10)).min(1).max(5)
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { cluster, owner, signedTxsBase64 } = parsed.data;
  const session = getOrCreateSession(cluster, owner);

  if (cluster === "devnet") {
    return res.status(400).json({
      error: "Jito bundles are mainnet-only. Use cluster=mainnet-beta for MEV protection."
    });
  }

  try {
    const signedBytes = signedTxsBase64.map(base64ToBytes);
    const txs = signedBytes.map((b) => VersionedTransaction.deserialize(b));

    // Tip tx is recommended but not strictly required.
    // Under network congestion, Jito RPC can be globally rate limited (HTTP 429).
    // We accept bundles without an explicit tip so the bot can keep operating.
    try {
      const tipAccounts = new Set(await jito.getTipAccounts(cluster));
      const lastTx = txs[txs.length - 1];
      if (!isSystemTransferToTipAccount(lastTx, tipAccounts)) {
        pushSessionLog(cluster, owner, "warn", "No Jito tip tx detected as last tx; submitting bundle without explicit tip.");
      }
    } catch (e: any) {
      pushSessionLog(cluster, owner, "warn", `Failed to validate Jito tip accounts; submitting bundle anyway. err=${e?.message ?? String(e)}`);
    }

    const encodedTransactionsBase58 = signedBytes.map(bytesToBase58);
    const bundleId = uuidv4();

    // Simulate bundle first to reduce dropped bundles / failures.
    const sim = await jito.simulateBundle(cluster, encodedTransactionsBase58);

    session.preparedBundles.set(bundleId, {
      bundleId,
      encodedTransactionsBase58,
      createdAtMs: Date.now()
    });

    const txSignatures = txs
      .map((t) => {
        const sig = t.signatures[0];
        return sig ? bs58.encode(Buffer.from(sig)) : null;
      })
      .filter(Boolean) as string[];

    session.bundles.set(bundleId, {
      bundleId,
      state: "prepared",
      createdAtMs: Date.now(),
      lastUpdateMs: Date.now(),
      jitoStatus: sim,
      txSignatures
    });

    // Clear pending action after successful preparation (prevents repeated signing prompts)
    session.pendingAction = null;

    pushSessionLog(
      cluster,
      owner,
      "info",
      `Bundle prepared (simulated). id=${bundleId} txs=${encodedTransactionsBase58.length}`
    );
    return res.json({ ok: true, bundleId, simulation: sim });
  } catch (e: any) {
    pushSessionLog(cluster, owner, "error", `prepare-bundle failed: ${e?.message ?? String(e)}`);
    return res.status(500).json({ error: e?.message ?? "prepare-bundle failed" });
  }
});

router.post("/submit-bundle", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      owner: ownerSchema,
      bundleId: z.string().uuid()
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { cluster, owner, bundleId } = parsed.data;
  const session = getOrCreateSession(cluster, owner);
  if (cluster === "devnet") {
    return res.status(400).json({ error: "Jito bundles are mainnet-only." });
  }

  const prepared = session.preparedBundles.get(bundleId);
  if (!prepared) return res.status(404).json({ error: "Unknown bundleId (not prepared)" });

  try {
    const sendResult = await jito.sendBundle(cluster, prepared.encodedTransactionsBase58);

    const status = session.bundles.get(bundleId);
    if (status) {
      status.state = "submitted";
      status.lastUpdateMs = Date.now();
      if (typeof sendResult === "string") status.jitoBundleId = sendResult;
      status.jitoStatus = { sendResult };
    }

    pushSessionLog(cluster, owner, "info", `Bundle submitted to Jito. localId=${bundleId}`);

    // Poll once immediately (frontend can keep polling /api/status)
    try {
      const pollTarget = typeof sendResult === "string" ? sendResult : bundleId;
      const poll = await jito.getBundleStatuses(cluster, [pollTarget]);
      if (status) {
        status.lastUpdateMs = Date.now();
        status.jitoStatus = { sendResult, poll };
      }
    } catch {
      // ignore polling errors
    }

    return res.json({ ok: true, bundleId, sendResult });
  } catch (e: any) {
    const status = session.bundles.get(bundleId);
    if (status) {
      status.state = "error";
      status.lastUpdateMs = Date.now();
      status.error = e?.message ?? String(e);
    }
    pushSessionLog(cluster, owner, "error", `sendBundle failed: ${e?.message ?? String(e)}`);
    return res.status(500).json({ error: e?.message ?? "sendBundle failed" });
  }
});

router.get("/jito-tip-accounts", async (req, res) => {
  const cluster = clusterSchema.catch("mainnet-beta").parse(req.query.cluster);
  if (cluster === "devnet") return res.json({ ok: true, tipAccounts: [] });
  try {
    const tipAccounts = await jito.getTipAccounts(cluster);
    return res.json({ ok: true, tipAccounts });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? "Failed to fetch tip accounts" });
  }
});

router.get("/pumpfun-tokens/stream", (req, res) => {
  const cluster = clusterSchema.catch("mainnet-beta").parse(req.query.cluster);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const write = (eventName: string | null, data: unknown) => {
    try {
      if (eventName) res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection closed, ignore
    }
  };

  write("hello", { ts: Date.now(), cluster });

  // Start monitoring if not already started (non-blocking)
  ensureTokenMonitoring(cluster).catch(() => {});

  // Send recent tokens backlog (reduced to avoid delay, send in batch)
  const recent = getRecentTokens(cluster);
  const toSend = recent.slice(0, 10); // Further reduced for faster initial load
  for (const token of toSend) {
    write(null, token);
  }
  
  // Send remaining tokens after a short delay to avoid blocking
  if (recent.length > 10) {
    setTimeout(() => {
      for (const token of recent.slice(10, 20)) {
        write(null, token);
      }
    }, 100);
  }

  // Subscribe to new token deployments
  const unsubscribe = subscribeTokenDeployments((token) => {
    write(null, token);
  });

  const keepAlive = setInterval(() => {
    write("ping", { ts: Date.now() });
  }, 15_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

router.get("/pumpfun-tokens/recent", (req, res) => {
  const cluster = clusterSchema.catch("mainnet-beta").parse(req.query.cluster);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const tokens = getRecentTokens(cluster).slice(0, limit);
  return res.json({ ok: true, cluster, tokens, count: tokens.length });
});

export default router;

