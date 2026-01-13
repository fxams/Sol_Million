import WebSocket from "ws";
import { Connection, PublicKey } from "@solana/web3.js";
import { env, getRpcUrl, getWsUrl } from "../utils/env.js";
import { pushClusterLog } from "../state/store.js";
import type { Cluster } from "../state/store.js";

export const PUMPFUN_PROGRAM_ID = env.pumpfunProgramId;

export type PumpFunTokenInfo = {
  mint: string;
  signature: string;
  deployer: string | null;
  timestamp: number;
  name?: string;
  symbol?: string;
  decimals?: number;
  supply?: string;
  metadataUri?: string;
};

type TokenDeploymentListener = (token: PumpFunTokenInfo) => void;

const listeners = new Set<TokenDeploymentListener>();
const recentTokens = new Map<Cluster, PumpFunTokenInfo[]>();
const MAX_RECENT_TOKENS = 500;

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function parseMintAccount(data: Buffer) {
  if (data.length < 82) return null;
  const mintAuthorityOption = data.readUInt32LE(0);
  const supply = data.readBigUInt64LE(36);
  const decimals = data.readUInt8(44);
  const isInitialized = data.readUInt8(45) === 1;
  const freezeAuthorityOption = data.readUInt32LE(46);
  return { mintAuthorityOption, freezeAuthorityOption, supply, decimals, isInitialized };
}

function getStaticAccountKeysFromTx(tx: any): PublicKey[] {
  const msg = tx?.transaction?.message;
  if (!msg) return [];
  if (Array.isArray(msg.staticAccountKeys)) return msg.staticAccountKeys as PublicKey[];
  if (Array.isArray(msg.accountKeys)) return msg.accountKeys as PublicKey[];
  return [];
}

async function withRetries<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseDelayMs?: number }): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 250;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const delay = baseDelayMs * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function getTransactionFast(connection: Connection, cluster: Cluster, signature: string) {
  const attempt = async (commitment: "confirmed" | "finalized") =>
    await connection.getTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0
    });

  const txConfirmed = await withRetries(async () => await attempt("confirmed"), { attempts: 3, baseDelayMs: 200 });
  if (txConfirmed) return txConfirmed;

  const txFinalized = await withRetries(async () => await attempt("finalized"), { attempts: 2, baseDelayMs: 250 });
  return txFinalized;
}

function isCreateLikePumpfunLogs(logs: string[]) {
  return logs.some((l) => /instruction:\s*create/i.test(l) || /\bcreate\b/i.test(l));
}

function isMintNewInTx(tx: any, mint: string) {
  const pre = new Set<string>();
  const post = new Set<string>();
  for (const b of tx?.meta?.preTokenBalances ?? []) if (b?.mint) pre.add(b.mint);
  for (const b of tx?.meta?.postTokenBalances ?? []) if (b?.mint) post.add(b.mint);
  return post.has(mint) && !pre.has(mint);
}

async function extractTokenInfo(opts: { cluster: Cluster; signature: string; logs: string[] }): Promise<PumpFunTokenInfo | null> {
  const connection = new Connection(getRpcUrl(opts.cluster), "confirmed");
  const tx = await getTransactionFast(connection, opts.cluster, opts.signature);
  if (!tx) return null;

  // Extract mint from token balances
  const mints = new Set<string>();
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint) mints.add(b.mint);
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint) mints.add(b.mint);

  if (mints.size === 0) {
    // Try to find mint in account keys
    const keys = getStaticAccountKeysFromTx(tx);
    for (const k of keys.slice(0, 25)) {
      try {
        const info = await withRetries(async () => await connection.getAccountInfo(k, "confirmed"), {
          attempts: 2,
          baseDelayMs: 200
        });
        if (!info) continue;
        if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;
        const parsed = parseMintAccount(Buffer.from(info.data));
        if (!parsed?.isInitialized) continue;
        mints.add(k.toBase58());
        break;
      } catch {
        // continue
      }
    }
  }

  if (mints.size === 0) return null;

  const mint = Array.from(mints)[0];
  const isCreate = isCreateLikePumpfunLogs(opts.logs) || isMintNewInTx(tx, mint);

  if (!isCreate) return null;

  // Extract deployer (first signer)
  const keys = getStaticAccountKeysFromTx(tx);
  const deployer = keys.length > 0 ? keys[0].toBase58() : null;

  // Get token metadata
  let decimals: number | undefined;
  let supply: string | undefined;
  try {
    const mintPk = new PublicKey(mint);
    const info = await withRetries(async () => await connection.getAccountInfo(mintPk, "confirmed"), {
      attempts: 2,
      baseDelayMs: 200
    });
    if (info) {
      const parsed = parseMintAccount(Buffer.from(info.data));
      if (parsed) {
        decimals = parsed.decimals;
        supply = parsed.supply.toString();
      }
    }

    // Try to get token supply
    try {
      const supplyResp = await connection.getTokenSupply(mintPk, "confirmed");
      if (supplyResp.value) {
        supply = supplyResp.value.amount;
        decimals = supplyResp.value.decimals;
      }
    } catch {
      // ignore
    }
  } catch {
    // ignore metadata errors
  }

  return {
    mint,
    signature: opts.signature,
    deployer,
    timestamp: Date.now(),
    decimals,
    supply
  };
}

const seenSignatures = new Map<Cluster, Set<string>>();
const wsConnections = new Map<Cluster, WebSocket>();

function markSeenSignature(cluster: Cluster, signature: string): boolean {
  if (!seenSignatures.has(cluster)) {
    seenSignatures.set(cluster, new Set());
  }
  const seen = seenSignatures.get(cluster)!;
  if (seen.has(signature)) return true;
  seen.add(signature);
  // Cap memory
  if (seen.size > 5000) {
    const keep = Array.from(seen).slice(-3000);
    seenSignatures.set(cluster, new Set(keep));
  }
  return false;
}

export function subscribeTokenDeployments(listener: TokenDeploymentListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentTokens(cluster: Cluster): PumpFunTokenInfo[] {
  return recentTokens.get(cluster) ?? [];
}

export async function ensureTokenMonitoring(cluster: Cluster) {
  if (!PUMPFUN_PROGRAM_ID) {
    pushClusterLog(cluster, "warn", "PUMPFUN_PROGRAM_ID not set; token monitoring disabled.");
    return;
  }

  if (wsConnections.has(cluster)) return;

  const wsUrl = getWsUrl(cluster);
  pushClusterLog(cluster, "info", `Starting Pump Fun token monitoring: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  wsConnections.set(cluster, ws);

  ws.on("open", () => {
    pushClusterLog(cluster, "info", "Pump Fun token monitoring WebSocket connected");
    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "logsSubscribe",
        params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: "processed" }]
      })
    );
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString()) as any;

      if (msg.method === "logsNotification") {
        const signature = msg.params?.result?.value?.signature as string | undefined;
        const logs = (msg.params?.result?.value?.logs as string[]) ?? [];

        if (!signature || logs.length === 0) return;
        if (markSeenSignature(cluster, signature)) return;

        // Check if this looks like a token creation
        if (!isCreateLikePumpfunLogs(logs)) return;

        // Extract token info
        try {
          const tokenInfo = await extractTokenInfo({ cluster, signature, logs });
          if (!tokenInfo) return;

          // Add to recent tokens
          if (!recentTokens.has(cluster)) {
            recentTokens.set(cluster, []);
          }
          const clusterTokens = recentTokens.get(cluster)!;
          clusterTokens.unshift(tokenInfo);
          if (clusterTokens.length > MAX_RECENT_TOKENS) {
            clusterTokens.pop();
          }

          // Notify listeners
          for (const listener of listeners) {
            try {
              listener(tokenInfo);
            } catch {
              // ignore listener errors
            }
          }

          pushClusterLog(cluster, "info", `New Pump Fun token: ${tokenInfo.mint.slice(0, 8)}... (${signature.slice(0, 8)}...)`);
        } catch (e: any) {
          pushClusterLog(cluster, "warn", `Failed to extract token info: ${e?.message ?? String(e)}`);
        }
      }
    } catch (e: any) {
      pushClusterLog(cluster, "error", `Token monitoring error: ${e?.message ?? String(e)}`);
    }
  });

  ws.on("close", () => {
    pushClusterLog(cluster, "warn", "Pump Fun token monitoring WebSocket closed");
    wsConnections.delete(cluster);
  });

  ws.on("error", (err) => {
    pushClusterLog(cluster, "error", `Pump Fun token monitoring WebSocket error: ${String(err)}`);
  });
}

export function stopTokenMonitoring(cluster: Cluster) {
  const ws = wsConnections.get(cluster);
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    wsConnections.delete(cluster);
  }
}
