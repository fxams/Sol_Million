import WebSocket from "ws";
import { Connection } from "@solana/web3.js";
import { jito } from "./jito.js";
import { buildUnsignedBuyLikeTxBase64, buildUnsignedJitoTipTxBase64, randomTipLamports } from "./txBuilder.js";
import { env, getRpcUrl, getWsUrl } from "../utils/env.js";
import type { BotConfig, Cluster, WalletSession } from "../state/store.js";
import { getOrCreateSession, pushClusterLog, pushSessionLog, state } from "../state/store.js";

// Raydium AMM program ID (mainnet): required by spec.
export const RAYDIUM_AMM_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1dvX";
export const PUMPFUN_PROGRAM_ID = env.pumpfunProgramId;

type SourceKey = "raydium" | "pumpfun";

type JsonRpcMsg = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

function looksLikeRaydiumPoolInit(logs: string[]) {
  // Heuristic: Raydium pool init commonly includes "initialize2".
  return logs.some((l) => /initialize2|initialize/i.test(l));
}

function looksLikePumpfunTradeSignal(logs: string[]) {
  // Heuristic only. Real Pump.fun parsing should read the transaction and decode instructions.
  return logs.some((l) => /buy|sell|create|initialize/i.test(l));
}

async function txMentionsAnyOfMints(opts: {
  cluster: Cluster;
  signature: string;
  mintSet: Set<string>;
}): Promise<string[]> {
  if (opts.mintSet.size === 0) return [];
  const connection = new Connection(getRpcUrl(opts.cluster), "confirmed");
  const tx = await connection.getTransaction(opts.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0
  });
  const keys = tx?.transaction.message.getAccountKeys().staticAccountKeys ?? [];
  const matches: string[] = [];
  for (const k of keys) {
    const b58 = k.toBase58();
    if (opts.mintSet.has(b58)) matches.push(b58);
  }
  return matches;
}

function anySessionsRunning(cluster: Cluster) {
  const runtime = state[cluster];
  for (const s of runtime.sessions.values()) if (s.running) return true;
  return false;
}

function markSeenSignature(cluster: Cluster, signature: string) {
  const runtime = state[cluster];
  const seen = runtime.seenSignatures;
  if (!seen) return false;
  if (seen.has(signature)) return true;
  seen.add(signature);
  // cap memory
  if (seen.size > 3000) {
    // remove oldest-ish by recreating
    const keep = Array.from(seen).slice(-2000);
    runtime.seenSignatures = new Set(keep);
  }
  return false;
}

function subscribeLogs(runtime: any, ws: WebSocket, key: SourceKey, programId: string) {
  const reqId = Date.now() + Math.floor(Math.random() * 1000);
  runtime.wsPendingReqIdToKey?.set(reqId, key);
  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method: "logsSubscribe",
      params: [{ mentions: [programId] }, { commitment: "processed" }]
    })
  );
}

export async function ensureClusterSubscription(cluster: Cluster) {
  const runtime = state[cluster];
  if (runtime.ws) return;

  const wsUrl = getWsUrl(cluster);
  pushClusterLog(cluster, "info", `Connecting WebSocket: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  runtime.ws = ws;

  ws.on("open", () => {
    pushClusterLog(cluster, "info", "WebSocket connected; subscribing to Raydium + Pump.fun logs...");
    subscribeLogs(runtime, ws, "raydium", RAYDIUM_AMM_PROGRAM_ID);
    if (PUMPFUN_PROGRAM_ID) {
      subscribeLogs(runtime, ws, "pumpfun", PUMPFUN_PROGRAM_ID);
    } else {
      pushClusterLog(cluster, "warn", "PUMPFUN_PROGRAM_ID not set; Pump.fun pre-migration sniping disabled.");
    }
  });

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString()) as JsonRpcMsg;

    if (typeof msg.id === "number" && msg.result) {
      const key = runtime.wsPendingReqIdToKey?.get(msg.id);
      if (key) {
        runtime.wsPendingReqIdToKey?.delete(msg.id);
        runtime.wsSubIdsByKey?.set(key, msg.result);
        runtime.wsSubKeyById?.set(msg.result, key);
        pushClusterLog(cluster, "info", `Subscribed. key=${key} subscriptionId=${msg.result}`);
        return;
      }
    }

    if (msg.method !== "logsNotification") return;

    const subId = msg.params?.subscription as number | undefined;
    const value = msg.params?.result?.value;
    const signature = value?.signature as string | undefined;
    const logs = (value?.logs as string[]) ?? [];

    if (!signature || logs.length === 0) return;
    if (markSeenSignature(cluster, signature)) return;
    const sourceKey = (subId ? runtime.wsSubKeyById?.get(subId) : undefined) as SourceKey | undefined;
    if (!sourceKey) return;

    if (sourceKey === "raydium" && !looksLikeRaydiumPoolInit(logs)) return;
    if (sourceKey === "pumpfun" && !looksLikePumpfunTradeSignal(logs)) return;

    // Fan out to each running wallet session (sniper/volume can be different wallets).
    for (const s of runtime.sessions.values()) {
      if (!s.running || !s.config) continue;
      if (s.pendingAction) continue; // one-at-a-time per wallet

      // Route signals based on selected Pump.fun phase.
      // - For "pre" we react to Pump.fun signals
      // - For "post" we react to Raydium signals
      if (s.config.mode === "snipe") {
        if (s.config.pumpFunPhase === "pre" && sourceKey !== "pumpfun") continue;
        if (s.config.pumpFunPhase === "post" && sourceKey !== "raydium") continue;
      } else {
        // volume/arb: keep Raydium-only in this template
        if (sourceKey !== "raydium") continue;
      }

      // If a snipe list is provided, only trigger on matching mints.
      const snipeSet = new Set((s.config.snipeList ?? []).map((x) => x.trim()).filter(Boolean));
      if (s.config.mode === "snipe" && snipeSet.size === 0) {
        // For real sniping you almost always want a target mint. Without it, Pump.fun is a firehose.
        const lastWarn = (s as any)._lastEmptySnipeWarnMs as number | undefined;
        const now = Date.now();
        if (!lastWarn || now - lastWarn > 60_000) {
          (s as any)._lastEmptySnipeWarnMs = now;
          pushSessionLog(cluster, s.owner, "warn", "Snipe list is empty. Add a Pump.fun mint to snipe list to trigger actions.");
        }
        continue;
      }

      if (s.config.mode === "snipe" && snipeSet.size > 0) {
        try {
          const matches = await txMentionsAnyOfMints({ cluster, signature, mintSet: snipeSet });
          if (matches.length === 0) continue;
          (s as any)._matchedMints = matches;
        } catch (e: any) {
          pushSessionLog(cluster, s.owner, "warn", `Mint filter check failed: ${e?.message ?? String(e)}`);
          continue;
        }
      }

      // Only log cluster-level signals when they matter to at least one session.
      pushClusterLog(cluster, "info", `${sourceKey} matched. sig=${signature}`);

      s.pendingAction = {
        type: "SIGN_AND_BUNDLE",
        reason:
          s.config.mode === "snipe"
            ? `[snipe/${s.config.pumpFunPhase}] Target detected (${signature}). Click "Sign & submit pending bundle".`
            : `[volume] Signal detected (${signature}). Click "Sign & submit pending bundle".`,
        unsignedTxsBase64: []
      };
      (s.pendingAction as any).triggerSignature = signature;
      (s.pendingAction as any).source = sourceKey;
      const matched = (s as any)._matchedMints as string[] | undefined;
      if (matched?.length) (s.pendingAction as any).targetMint = matched[0];
      (s.pendingAction as any).needsUnsignedTxs = true;
      pushSessionLog(cluster, s.owner, "info", `Pending action created. source=${sourceKey} sig=${signature}`);
    }
  });

  ws.on("close", () => {
    pushClusterLog(cluster, "warn", "WebSocket closed");
    runtime.ws = undefined;
    runtime.wsSubIdsByKey?.clear();
    runtime.wsSubKeyById?.clear();
    runtime.wsPendingReqIdToKey?.clear();
  });

  ws.on("error", (err) => {
    pushClusterLog(cluster, "error", `WebSocket error: ${String(err)}`);
  });
}

export async function startWalletSession(owner: string, config: BotConfig) {
  const cluster = config.cluster;
  const session = getOrCreateSession(cluster, owner);
  session.running = true;
  session.config = config;
  session.pendingAction = null;

  pushSessionLog(cluster, owner, "info", `Session started. mode=${config.mode} mev=${config.mevEnabled}`);
  await ensureClusterSubscription(cluster);
}

export async function stopWalletSession(cluster: Cluster, owner: string) {
  const session = getOrCreateSession(cluster, owner);
  session.running = false;
  session.config = null;
  session.pendingAction = null;
  pushSessionLog(cluster, owner, "info", "Session stopped");

  // If nobody is running, close WS to reduce resource usage.
  if (!anySessionsRunning(cluster)) {
    const runtime = state[cluster];
    if (runtime.ws) {
      try {
        runtime.ws.close();
      } catch {
        // ignore
      }
      runtime.ws = undefined;
      runtime.wsSubIdsByKey?.clear();
      runtime.wsSubKeyById?.clear();
      runtime.wsPendingReqIdToKey?.clear();
      pushClusterLog(cluster, "info", "Closed cluster WebSocket (no active sessions).");
    }
  }
}

/**
 * Called by the status API for a specific owner.
 * We materialize unsigned txs only when the owner is requesting it (fresh blockhash),
 * keeping the backend keyless and reducing "blockhash not found" failures.
 */
export async function materializePendingUnsignedTxsForSession(opts: {
  cluster: Cluster;
  owner: string;
}): Promise<string[] | null> {
  const session = getOrCreateSession(opts.cluster, opts.owner);
  const cfg = session.config;
  const pa: any = session.pendingAction;
  if (!session.pendingAction || !pa?.needsUnsignedTxs) return null;
  if (!cfg) return null;

  const triggerSig = String(pa.triggerSignature ?? "unknown");
  const source = String(pa.source ?? "unknown");
  const targetMint = pa.targetMint ? String(pa.targetMint) : undefined;

  // NOTE:
  // - Proper liquidity filtering requires parsing pool accounts and reading reserves.
  // - Replace txBuilder with real Raydium swap instructions in production.
  if (cfg.minLiquiditySol > 0) {
    pushSessionLog(
      opts.cluster,
      opts.owner,
      "warn",
      "Liquidity filter is a template placeholder. Implement Raydium pool state parsing to enforce it."
    );
  }

  const unsigned: string[] = [];

  const buyTx = await buildUnsignedBuyLikeTxBase64({
    cluster: opts.cluster,
    owner: opts.owner,
    amountSol: cfg.buyAmountSol,
    memo: `mode=${cfg.mode} phase=${cfg.pumpFunPhase} source=${source} sig=${triggerSig}${targetMint ? ` mint=${targetMint}` : ""}`
  });
  unsigned.push(buyTx);

  if (cfg.mevEnabled) {
    if (opts.cluster === "devnet") {
      pushSessionLog(opts.cluster, opts.owner, "warn", "MEV enabled but cluster=devnet; skipping tip tx.");
    } else {
      const tipAccounts = await jito.getTipAccounts(opts.cluster);
      const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
      const tipLamports = randomTipLamports(1000);
      const tipTx = await buildUnsignedJitoTipTxBase64({
        cluster: opts.cluster,
        owner: opts.owner,
        tipAccount,
        tipLamports,
        memo: `Jito tip | mode=${cfg.mode} phase=${cfg.pumpFunPhase} source=${source}`
      });
      unsigned.push(tipTx);
    }
  }

  return unsigned;
}

