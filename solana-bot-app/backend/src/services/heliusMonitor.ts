import WebSocket from "ws";
import { jito } from "./jito.js";
import { buildUnsignedBuyLikeTxBase64, buildUnsignedJitoTipTxBase64, randomTipLamports } from "./txBuilder.js";
import { getWsUrl } from "../utils/env.js";
import type { BotConfig, Cluster, WalletSession } from "../state/store.js";
import { getOrCreateSession, pushClusterLog, pushSessionLog, state } from "../state/store.js";

// Raydium AMM program ID (mainnet): required by spec.
export const RAYDIUM_AMM_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1dvX";

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

function anySessionsRunning(cluster: Cluster) {
  const runtime = state[cluster];
  for (const s of runtime.sessions.values()) if (s.running) return true;
  return false;
}

export async function ensureClusterSubscription(cluster: Cluster) {
  const runtime = state[cluster];
  if (runtime.ws) return;

  const wsUrl = getWsUrl(cluster);
  pushClusterLog(cluster, "info", `Connecting WebSocket: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  runtime.ws = ws;

  ws.on("open", () => {
    pushClusterLog(cluster, "info", "WebSocket connected; subscribing to Raydium AMM logs...");
    const subReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: [RAYDIUM_AMM_PROGRAM_ID] }, { commitment: "processed" }]
    };
    ws.send(JSON.stringify(subReq));
  });

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString()) as JsonRpcMsg;

    if (msg.id === 1 && msg.result) {
      runtime.wsSubId = msg.result;
      pushClusterLog(cluster, "info", `Subscribed. subscriptionId=${runtime.wsSubId}`);
      return;
    }

    if (msg.method !== "logsNotification") return;

    const value = msg.params?.result?.value;
    const signature = value?.signature as string | undefined;
    const logs = (value?.logs as string[]) ?? [];

    if (!signature || logs.length === 0) return;
    if (!looksLikeRaydiumPoolInit(logs)) return;

    pushClusterLog(cluster, "info", `Raydium pool init signal. sig=${signature}`);

    // Fan out to each running wallet session (sniper/volume can be different wallets).
    for (const s of runtime.sessions.values()) {
      if (!s.running || !s.config) continue;
      if (s.pendingAction) continue; // one-at-a-time per wallet

      // NOTE: Proper snipe list / mint filtering requires parsing the pool tx/accounts.
      // This template sets a pending action as a safe prompt to sign when running.
      s.pendingAction = {
        type: "SIGN_AND_BUNDLE",
        reason: `[${s.config.mode}] Pool detected (${signature}). Click "Sign & submit pending bundle".`,
        unsignedTxsBase64: []
      };
      (s.pendingAction as any).poolSignature = signature;
      (s.pendingAction as any).needsUnsignedTxs = true;
      pushSessionLog(cluster, s.owner, "info", `Pending action created for pool sig=${signature}`);
    }
  });

  ws.on("close", () => {
    pushClusterLog(cluster, "warn", "WebSocket closed");
    runtime.ws = undefined;
    runtime.wsSubId = undefined;
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
      runtime.wsSubId = undefined;
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

  const poolSig = String(pa.poolSignature ?? "unknown");

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
    memo: `mode=${cfg.mode} raydium_pool_sig=${poolSig}`
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
        memo: `Jito tip | mode=${cfg.mode} | pool=${poolSig}`
      });
      unsigned.push(tipTx);
    }
  }

  return unsigned;
}

