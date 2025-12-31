import WebSocket from "ws";
import { jito } from "./jito.js";
import { buildUnsignedBuyLikeTxBase64, buildUnsignedJitoTipTxBase64, randomTipLamports } from "./txBuilder.js";
import { getWsUrl } from "../utils/env.js";
import type { BotConfig, Cluster } from "../state/store.js";
import { pushLog, state } from "../state/store.js";

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

export async function startMonitoring(config: BotConfig) {
  const cluster = config.cluster;
  const runtime = state[cluster];
  if (runtime.running) return;

  runtime.running = true;
  runtime.config = config;
  runtime.pendingAction = null;

  const wsUrl = getWsUrl(cluster);
  pushLog(cluster, "info", `Connecting WebSocket: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  runtime.ws = ws;

  ws.on("open", () => {
    pushLog(cluster, "info", "WebSocket connected; subscribing to Raydium AMM logs...");
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
      pushLog(cluster, "info", `Subscribed. subscriptionId=${runtime.wsSubId}`);
      return;
    }

    if (msg.method !== "logsNotification") return;

    const value = msg.params?.result?.value;
    const signature = value?.signature as string | undefined;
    const logs = (value?.logs as string[]) ?? [];

    if (!signature || logs.length === 0) return;
    if (!looksLikeRaydiumPoolInit(logs)) return;

    // One-at-a-time: require user signature before preparing another action.
    if (runtime.pendingAction) return;

    pushLog(cluster, "info", `Detected potential Raydium pool init. sig=${signature}`);

    // NOTE:
    // - Proper liquidity filtering requires parsing pool accounts and reading reserves.
    // - This template logs the event and prepares a keyless "buy intent" transaction that the
    //   frontend wallet signs. Replace txBuilder with real Raydium swap instructions in production.
    if (config.minLiquiditySol > 0) {
      pushLog(
        cluster,
        "warn",
        "Liquidity filter is a template placeholder. Implement Raydium pool state parsing to enforce it."
      );
    }

    const ownerHint = "WALLET_WILL_SET_OWNER";
    runtime.pendingAction = {
      type: "SIGN_AND_BUNDLE",
      reason: `Pool detected (${signature}). Sign to submit an atomic Jito bundle (buy + tip).`,
      unsignedTxsBase64: []
    };

    // The backend cannot know the user's public key unless the frontend supplies it.
    // We generate unsigned txs on-demand from the /api/status-driven flow.
    // Here we store only the signature marker; /api/status endpoint will convert it.
    // (See routes/api.ts pendingAction synthesis.)
    runtime.pendingAction.reason = `Pool detected (${signature}). Click "Sign & submit pending bundle".`;
    (runtime.pendingAction as any).poolSignature = signature;
    (runtime.pendingAction as any).needsUnsignedTxs = true;
  });

  ws.on("close", () => {
    pushLog(cluster, "warn", "WebSocket closed");
    runtime.ws = undefined;
    runtime.wsSubId = undefined;
    runtime.running = false;
  });

  ws.on("error", (err) => {
    pushLog(cluster, "error", `WebSocket error: ${String(err)}`);
  });
}

export async function stopMonitoring(cluster: Cluster) {
  const runtime = state[cluster];
  runtime.running = false;
  runtime.config = null;
  runtime.pendingAction = null;

  if (runtime.ws) {
    try {
      runtime.ws.close();
    } catch {
      // ignore
    }
  }
  runtime.ws = undefined;
  runtime.wsSubId = undefined;
  pushLog(cluster, "info", "Monitoring stopped");
}

/**
 * Called by the status API when the frontend provides an owner public key.
 * We materialize unsigned txs only when we know the owner, keeping the backend keyless.
 */
export async function materializePendingUnsignedTxs(opts: {
  cluster: Cluster;
  owner: string;
}): Promise<string[] | null> {
  const runtime = state[opts.cluster];
  const cfg = runtime.config;
  const pa: any = runtime.pendingAction;
  if (!runtime.pendingAction || !pa?.needsUnsignedTxs) return null;
  if (!cfg) return null;

  const poolSig = String(pa.poolSignature ?? "unknown");

  const unsigned: string[] = [];

  // In a real bot, you'd build a Raydium swap here (buy), and optionally a sell tx.
  const buyTx = await buildUnsignedBuyLikeTxBase64({
    cluster: opts.cluster,
    owner: opts.owner,
    amountSol: cfg.buyAmountSol,
    memo: `raydium_pool_sig=${poolSig}`
  });
  unsigned.push(buyTx);

  if (cfg.mevEnabled) {
    if (opts.cluster === "devnet") {
      pushLog(opts.cluster, "warn", "MEV enabled but cluster=devnet; skipping tip tx (Jito mainnet-only).");
    } else {
      const tipAccounts = await jito.getTipAccounts(opts.cluster);
      const tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
      const tipLamports = randomTipLamports(1000);
      const tipTx = await buildUnsignedJitoTipTxBase64({
        cluster: opts.cluster,
        owner: opts.owner,
        tipAccount,
        tipLamports,
        memo: `Jito tip | pool=${poolSig}`
      });
      unsigned.push(tipTx);
    }
  }

  return unsigned;
}

