import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { VersionedTransaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { pushLog, state } from "../state/store.js";
import { startMonitoring, stopMonitoring, materializePendingUnsignedTxs } from "../services/heliusMonitor.js";
import { buildUnsignedBuyLikeTxBase64, buildUnsignedSellLikeTxBase64 } from "../services/txBuilder.js";
import { base64ToBytes, bytesToBase58 } from "../utils/encoding.js";
import { jito } from "../services/jito.js";

const router = Router();

const clusterSchema = z.enum(["mainnet-beta", "devnet"]);

const configSchema = z.object({
  cluster: clusterSchema.default("mainnet-beta"),
  mode: z.enum(["snipe", "volume"]).default("snipe"),
  mevEnabled: z.boolean().default(true),
  buyAmountSol: z.number().finite().positive().max(10_000),
  takeProfitPct: z.number().finite().min(0).max(10_000).default(0),
  stopLossPct: z.number().finite().min(0).max(10_000).default(0),
  minLiquiditySol: z.number().finite().min(0).max(10_000).default(0),
  autoSellDelaySec: z.number().finite().min(0).max(86_400).default(0),
  snipeList: z.array(z.string().min(32).max(64)).default([])
});

router.post("/start-monitoring", async (req, res) => {
  const parsed = configSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const config = parsed.data;

  pushLog(config.cluster, "info", `Start requested. mode=${config.mode} mev=${config.mevEnabled}`);
  await startMonitoring(config);

  return res.json({ ok: true });
});

router.post("/stop-monitoring", async (req, res) => {
  const parsed = z.object({ cluster: clusterSchema.default("mainnet-beta") }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  await stopMonitoring(parsed.data.cluster);
  return res.json({ ok: true });
});

router.get("/status", async (req, res) => {
  const cluster = clusterSchema.catch("mainnet-beta").parse(req.query.cluster);
  const owner = z.string().optional().parse(req.query.owner);

  const runtime = state[cluster];

  // If we have a pool-triggered pending action and we now know the owner's pubkey,
  // materialize unsigned txs (buy + optional tip) to be signed client-side.
  if (owner && runtime.pendingAction && (runtime.pendingAction as any).needsUnsignedTxs) {
    try {
      const unsignedTxsBase64 = await materializePendingUnsignedTxs({ cluster, owner });
      if (unsignedTxsBase64 && runtime.pendingAction) {
        runtime.pendingAction.unsignedTxsBase64 = unsignedTxsBase64;
        delete (runtime.pendingAction as any).needsUnsignedTxs;
      }
    } catch (e: any) {
      pushLog(cluster, "error", `Failed to build unsigned txs: ${e?.message ?? String(e)}`);
      runtime.pendingAction = null;
    }
  }

  const bundles = Array.from(runtime.bundles.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);

  return res.json({
    ok: true,
    running: runtime.running,
    cluster,
    logs: runtime.logs,
    bundles,
    pendingAction: runtime.pendingAction
  });
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
      signedTxsBase64: z.array(z.string().min(10)).min(1).max(5)
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { cluster, signedTxsBase64 } = parsed.data;
  const runtime = state[cluster];

  if (cluster === "devnet") {
    return res.status(400).json({
      error: "Jito bundles are mainnet-only. Use cluster=mainnet-beta for MEV protection."
    });
  }

  try {
    const signedBytes = signedTxsBase64.map(base64ToBytes);
    const txs = signedBytes.map((b) => VersionedTransaction.deserialize(b));

    // Enforce "tip tx last" for MEV protection.
    const tipAccounts = new Set(await jito.getTipAccounts(cluster));
    const lastTx = txs[txs.length - 1];
    if (!isSystemTransferToTipAccount(lastTx, tipAccounts)) {
      return res.status(400).json({
        error:
          "Last transaction must be a SystemProgram.transfer tip to a valid Jito tip account (tip tx must be last)."
      });
    }

    const encodedTransactionsBase58 = signedBytes.map(bytesToBase58);
    const bundleId = uuidv4();

    // Simulate bundle first to reduce dropped bundles / failures.
    const sim = await jito.simulateBundle(cluster, encodedTransactionsBase58);

    runtime.preparedBundles.set(bundleId, {
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

    runtime.bundles.set(bundleId, {
      bundleId,
      state: "prepared",
      createdAtMs: Date.now(),
      lastUpdateMs: Date.now(),
      jitoStatus: sim,
      txSignatures
    });

    // Clear pending action after successful preparation (prevents repeated signing prompts)
    runtime.pendingAction = null;

    pushLog(cluster, "info", `Bundle prepared (simulated). id=${bundleId} txs=${encodedTransactionsBase58.length}`);
    return res.json({ ok: true, bundleId, simulation: sim });
  } catch (e: any) {
    pushLog(cluster, "error", `prepare-bundle failed: ${e?.message ?? String(e)}`);
    return res.status(500).json({ error: e?.message ?? "prepare-bundle failed" });
  }
});

router.post("/submit-bundle", async (req, res) => {
  const parsed = z
    .object({
      cluster: clusterSchema.default("mainnet-beta"),
      bundleId: z.string().uuid()
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

  const { cluster, bundleId } = parsed.data;
  const runtime = state[cluster];
  if (cluster === "devnet") {
    return res.status(400).json({ error: "Jito bundles are mainnet-only." });
  }

  const prepared = runtime.preparedBundles.get(bundleId);
  if (!prepared) return res.status(404).json({ error: "Unknown bundleId (not prepared)" });

  try {
    const sendResult = await jito.sendBundle(cluster, prepared.encodedTransactionsBase58);

    const status = runtime.bundles.get(bundleId);
    if (status) {
      status.state = "submitted";
      status.lastUpdateMs = Date.now();
      if (typeof sendResult === "string") status.jitoBundleId = sendResult;
      status.jitoStatus = { sendResult };
    }

    pushLog(cluster, "info", `Bundle submitted to Jito. localId=${bundleId}`);

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
    const status = runtime.bundles.get(bundleId);
    if (status) {
      status.state = "error";
      status.lastUpdateMs = Date.now();
      status.error = e?.message ?? String(e);
    }
    pushLog(cluster, "error", `sendBundle failed: ${e?.message ?? String(e)}`);
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

export default router;

