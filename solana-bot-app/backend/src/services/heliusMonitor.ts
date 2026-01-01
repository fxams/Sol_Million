import WebSocket from "ws";
import { Connection, PublicKey } from "@solana/web3.js";
import { jito } from "./jito.js";
import { buildUnsignedBuyLikeTxBase64, buildUnsignedJitoTipTxBase64, randomTipLamports } from "./txBuilder.js";
import { jupiterQuote, jupiterSwapTxBase64, WSOL_MINT } from "./jupiter.js";
import { pumpportalTradeTxBase64 } from "./pumpportal.js";
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

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function getStaticAccountKeysFromTx(tx: any): PublicKey[] {
  // web3.js v1 can throw if you call message.getAccountKeys() on v0 messages without lookups resolved.
  // We only need static keys for payer + light heuristics.
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
      // Backoff
      const delay = baseDelayMs * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Limit concurrent RPC calls (Render/Node can hit socket exhaustion otherwise).
const rpcInFlight: Record<string, number> = {};
const rpcQueues: Record<string, Array<() => void>> = {};
async function withRpcLimit<T>(cluster: Cluster, fn: () => Promise<T>, limit = 2): Promise<T> {
  const key = cluster;
  rpcInFlight[key] = rpcInFlight[key] ?? 0;
  rpcQueues[key] = rpcQueues[key] ?? [];

  if (rpcInFlight[key] >= limit) {
    await new Promise<void>((resolve) => rpcQueues[key].push(resolve));
  }
  rpcInFlight[key] += 1;
  try {
    return await fn();
  } finally {
    rpcInFlight[key] -= 1;
    const next = rpcQueues[key].shift();
    if (next) next();
  }
}

async function getTransactionFast(connection: Connection, cluster: Cluster, signature: string) {
  // web3.js getTransaction() accepts Finality (confirmed/finalized), not "processed".
  // For freshness, we just retry confirmed a few times.
  const attempt = async (commitment: "confirmed" | "finalized") =>
    await connection.getTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0
    });

  const txConfirmed = await withRpcLimit(
    cluster,
    async () => await withRetries(async () => await attempt("confirmed"), { attempts: 3, baseDelayMs: 200 }),
    2
  );
  if (txConfirmed) return txConfirmed;

  const txFinalized = await withRpcLimit(
    cluster,
    async () => await withRetries(async () => await attempt("finalized"), { attempts: 2, baseDelayMs: 250 }),
    2
  );
  return txFinalized;
}

function u32le(buf: Buffer, off: number) {
  return buf.readUInt32LE(off);
}
function u64le(buf: Buffer, off: number) {
  const lo = BigInt(buf.readUInt32LE(off));
  const hi = BigInt(buf.readUInt32LE(off + 4));
  return (hi << 32n) + lo;
}

function parseMintAccount(data: Buffer) {
  // SPL Mint layout: 82 bytes
  if (data.length < 82) return null;
  const mintAuthorityOption = u32le(data, 0);
  const supply = u64le(data, 36);
  const decimals = data.readUInt8(44);
  const isInitialized = data.readUInt8(45) === 1;
  const freezeAuthorityOption = u32le(data, 46);
  return { mintAuthorityOption, freezeAuthorityOption, supply, decimals, isInitialized };
}

function parseToken2022ExtensionTypes(data: Buffer): number[] {
  // Best-effort TLV parse for Token-2022 mint accounts:
  // [u16 type][u16 length][length bytes]... until exhausted.
  // If the layout differs, fail open (return []).
  if (data.length <= 82) return [];
  const types: number[] = [];
  let off = 82;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    off += 4;
    if (off + len > data.length) break;
    types.push(type);
    off += len;
  }
  return types;
}

function isCreateLikePumpfunLogs(logs: string[]) {
  // Helius log lines often look like: "Program log: Instruction: Create"
  return logs.some((l) => /instruction:\s*create/i.test(l) || /\bcreate\b/i.test(l));
}

function isMintNewInTx(tx: any, mint: string) {
  // Stronger heuristic than log text:
  // if a mint shows up in postTokenBalances but not preTokenBalances,
  // this tx likely corresponds to mint creation / first relevant activity.
  const pre = new Set<string>();
  const post = new Set<string>();
  for (const b of tx?.meta?.preTokenBalances ?? []) if (b?.mint) pre.add(b.mint);
  for (const b of tx?.meta?.postTokenBalances ?? []) if (b?.mint) post.add(b.mint);
  return post.has(mint) && !pre.has(mint);
}

async function inferMintFromPumpfunTx(opts: { cluster: Cluster; signature: string }) {
  const connection = new Connection(getRpcUrl(opts.cluster), "confirmed");
  const tx = await getTransactionFast(connection, opts.cluster, opts.signature);
  if (!tx) return null;

  // Prefer token balance mints (cheap and usually correct for buys/sells)
  const mints = new Set<string>();
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint) mints.add(b.mint);
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint) mints.add(b.mint);
  if (mints.size === 1) return { mint: Array.from(mints)[0], tx };
  if (mints.size > 1) {
    // Heuristic: pick the first mint (most Pump.fun trades involve just one token mint)
    return { mint: Array.from(mints)[0], tx };
  }

  // Fallback: probe a few account keys for a mint-like account
  const keys = getStaticAccountKeysFromTx(tx);
  const probe = keys.slice(0, 25);
  for (const k of probe) {
    const info = await withRpcLimit(
      opts.cluster,
      async () =>
        await withRetries(async () => await connection.getAccountInfo(k, "confirmed"), {
          attempts: 3,
          baseDelayMs: 200
        }),
      2
    );
    if (!info) continue;
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;
    const parsed = parseMintAccount(Buffer.from(info.data));
    if (!parsed?.isInitialized) continue;
    return { mint: k.toBase58(), tx };
  }

  return { mint: null, tx };
}

async function checkMintSafety(opts: {
  cluster: Cluster;
  mint: string;
  cfg: BotConfig["autoSnipe"];
}): Promise<{ ok: boolean; reason?: string; top1Pct?: number; top10Pct?: number }> {
  const connection = new Connection(getRpcUrl(opts.cluster), "confirmed");
  const mintPk = new PublicKey(opts.mint);
  const acc = await withRpcLimit(
    opts.cluster,
    async () =>
      await withRetries(async () => await connection.getAccountInfo(mintPk, "confirmed"), {
        attempts: 3,
        baseDelayMs: 200
      }),
    2
  );
  if (!acc) return { ok: false, reason: "mint account not found" };

  const is2022 = acc.owner.equals(TOKEN_2022_PROGRAM_ID);
  const isToken = acc.owner.equals(TOKEN_PROGRAM_ID);
  if (!isToken && !is2022) return { ok: false, reason: "not a token mint account" };
  if (is2022 && !opts.cfg.allowToken2022) return { ok: false, reason: "token-2022 not allowed" };

  if (is2022) {
    // Block risky Token-2022 extensions (best-effort).
    const extTypes = parseToken2022ExtensionTypes(Buffer.from(acc.data));
    // Common risky extensions (enum values may vary; this is a practical blocklist).
    const blocked = new Set<number>([
      1, // TransferFeeConfig
      4, // ConfidentialTransferMint
      10, // InterestBearingConfig
      12, // PermanentDelegate
      14, // TransferHook
      16 // ConfidentialTransferFeeConfig
    ]);
    for (const t of extTypes) {
      if (blocked.has(t)) return { ok: false, reason: `token-2022 blocked extension ${t}` };
    }
  }

  const parsed = parseMintAccount(Buffer.from(acc.data));
  if (!parsed?.isInitialized) return { ok: false, reason: "mint not initialized" };
  if (opts.cfg.requireMintAuthorityDisabled && parsed.mintAuthorityOption !== 0) {
    return { ok: false, reason: "mint authority still enabled" };
  }
  if (opts.cfg.requireFreezeAuthorityDisabled && parsed.freezeAuthorityOption !== 0) {
    return { ok: false, reason: "freeze authority still enabled" };
  }

  // Holder concentration checks (best-effort, can fail early at launch)
  const supplyResp = await withRpcLimit(
    opts.cluster,
    async () =>
      await withRetries(async () => await connection.getTokenSupply(mintPk, "confirmed"), {
        attempts: 3,
        baseDelayMs: 200
      }),
    2
  );
  const supply = BigInt(supplyResp.value.amount);
  if (supply === 0n) return { ok: false, reason: "zero supply" };

  const largest = await withRpcLimit(
    opts.cluster,
    async () =>
      await withRetries(async () => await connection.getTokenLargestAccounts(mintPk, "confirmed"), {
        attempts: 3,
        baseDelayMs: 200
      }),
    2
  );
  const amounts = largest.value.map((a) => BigInt(a.amount));
  const top1 = amounts[0] ?? 0n;
  const top10 = amounts.slice(0, 10).reduce((s, x) => s + x, 0n);
  const nonZeroHolders = amounts.filter((a) => a > 0n).length;

  const top1Pct = Number((top1 * 10_000n) / supply) / 100;
  const top10Pct = Number((top10 * 10_000n) / supply) / 100;

  // On Pump.fun bonding curve launches, distribution is extremely concentrated at the very start.
  // Only enforce holder concentration caps once there are enough non-zero holders to make it meaningful.
  if (nonZeroHolders >= 5) {
    if (top1Pct > opts.cfg.maxTop1HolderPct) {
      return { ok: false, reason: `top1 too high (${top1Pct}%)`, top1Pct, top10Pct };
    }
    if (top10Pct > opts.cfg.maxTop10HolderPct) {
      return { ok: false, reason: `top10 too high (${top10Pct}%)`, top1Pct, top10Pct };
    }
  }

  return { ok: true, top1Pct, top10Pct };
}

async function txMentionsAnyOfMints(opts: {
  cluster: Cluster;
  signature: string;
  mintSet: Set<string>;
}): Promise<string[]> {
  if (opts.mintSet.size === 0) return [];
  const connection = new Connection(getRpcUrl(opts.cluster), "confirmed");
  const tx = await getTransactionFast(connection, opts.cluster, opts.signature);
  const keys = getStaticAccountKeysFromTx(tx) ?? [];
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
      const cfg = s.config;
      const epoch = s.epoch;

      // Rate-limited “heartbeat” so the UI doesn't feel stuck.
      try {
        const now = Date.now();
        const hbKey = `_lastHeartbeatMs_${sourceKey}`;
        const lastHb = (s as any)[hbKey] as number | undefined;
        if (!lastHb || now - lastHb > 15_000) {
          (s as any)[hbKey] = now;
          const stats = (s as any)._autoSnipeStats as any | undefined;
          if (stats?.totalSignals) {
            pushSessionLog(
              cluster,
              s.owner,
              "info",
              `Auto-snipe stats: signals=${stats.totalSignals} txOk=${stats.txOk} mintInferred=${stats.mintInferred} safetyOk=${stats.safetyOk} triggered=${stats.triggered} rejects=${JSON.stringify(
                stats.rejects ?? {}
              )}`
            );
          }
        }
      } catch {
        // ignore heartbeat errors
      }

      // Route signals based on selected Pump.fun phase.
      // - For "pre" we react to Pump.fun signals
      // - For "post" we react to Raydium signals
      if (cfg.mode === "snipe") {
        if (cfg.pumpFunPhase === "pre" && sourceKey !== "pumpfun") continue;
        if (cfg.pumpFunPhase === "post" && sourceKey !== "raydium") continue;
      } else {
        // volume/arb: keep Raydium-only in this template
        if (sourceKey !== "raydium") continue;
      }

      // If a snipe list is provided, only trigger on matching mints.
      const snipeSet = new Set((cfg.snipeList ?? []).map((x) => x.trim()).filter(Boolean));

      // Best default sniping mode: "auto" on Pump.fun pre-migration, with strong safety filters.
      if (cfg.mode === "snipe" && cfg.pumpFunPhase === "pre" && sourceKey === "pumpfun" && cfg.snipeTargetMode === "auto") {
        const stats: any = ((s as any)._autoSnipeStats ??= {
          totalSignals: 0,
          txOk: 0,
          mintInferred: 0,
          safetyOk: 0,
          triggered: 0,
          rejects: {}
        });
        stats.totalSignals += 1;

        try {
          const isCreateFromLogs = isCreateLikePumpfunLogs(logs);
          const inferred = await inferMintFromPumpfunTx({ cluster, signature });
          if (!s.running || s.config !== cfg || s.epoch !== epoch) continue;
          const mint = inferred?.mint;
          const tx = inferred?.tx;
          if (!mint || !tx) {
            stats.rejects.noMint = (stats.rejects.noMint ?? 0) + 1;
            continue;
          }
          const isCreate = isCreateFromLogs || isMintNewInTx(tx, mint);
          stats.txOk += 1;
          stats.mintInferred += 1;

          const now = Date.now();

          // Per-session momentum tracking
          const mintStats: Map<string, any> = (s as any)._autoMintStats ?? new Map();
          (s as any)._autoMintStats = mintStats;

          let st = mintStats.get(mint);
          if (!st) {
            // Only start tracking a mint when we see a create-like signal,
            // otherwise we'd “discover” old tokens after a restart.
            if (!isCreate) {
              stats.rejects.notNew = (stats.rejects.notNew ?? 0) + 1;
              continue;
            }
            st = { firstSeenMs: now, createdAtMs: now, count: 0, payers: new Set<string>(), safety: null };
            mintStats.set(mint, st);
          } else if (now - st.firstSeenMs > cfg.autoSnipe.windowSec * 1000) {
            // Window expired; only reset if we see a create-like signal again.
            if (!isCreate) {
              stats.rejects.windowExpired = (stats.rejects.windowExpired ?? 0) + 1;
              continue;
            }
            st.firstSeenMs = now;
            st.createdAtMs = now;
            st.count = 0;
            st.payers = new Set<string>();
            st.safety = null;
          }

          const createdAtMs = Number(st.createdAtMs ?? st.firstSeenMs ?? now);
          const ageSec = Math.floor((now - createdAtMs) / 1000);
          if (ageSec > cfg.autoSnipe.maxTxAgeSec) {
            stats.rejects.tooOld = (stats.rejects.tooOld ?? 0) + 1;
            continue;
          }

          st.count += 1;
          const payer = getStaticAccountKeysFromTx(tx)[0]?.toBase58();
          if (payer) st.payers.add(payer);

          // Run safety check once per mint per session window
          if (!st.safety) st.safety = await checkMintSafety({ cluster, mint, cfg: cfg.autoSnipe });
          if (!s.running || s.config !== cfg || s.epoch !== epoch) continue;
          if (!st.safety.ok) {
            const r = String(st.safety.reason ?? "safety");
            stats.rejects[r] = (stats.rejects[r] ?? 0) + 1;
            continue;
          }
          stats.safetyOk += 1;

          if (st.count < cfg.autoSnipe.minSignalsInWindow) {
            stats.rejects.momentum = (stats.rejects.momentum ?? 0) + 1;
            continue;
          }
          if (st.payers.size < cfg.autoSnipe.minUniqueFeePayersInWindow) {
            stats.rejects.uniquePayers = (stats.rejects.uniquePayers ?? 0) + 1;
            continue;
          }

          (s as any)._matchedMints = [mint];
          stats.triggered += 1;
        } catch (e: any) {
          pushSessionLog(cluster, s.owner, "warn", `Auto-snipe check failed: ${e?.message ?? String(e)}`);
          continue;
        }
      } else if (cfg.mode === "snipe" && cfg.snipeTargetMode === "list") {
        // List-based sniping: must specify a mint list.
        if (snipeSet.size === 0) {
          const lastWarn = (s as any)._lastEmptySnipeWarnMs as number | undefined;
          const now = Date.now();
          if (!lastWarn || now - lastWarn > 60_000) {
            (s as any)._lastEmptySnipeWarnMs = now;
            pushSessionLog(cluster, s.owner, "warn", "Snipe list is empty. Add a mint to snipe list or switch to Auto mode.");
          }
          continue;
        }
        try {
          const matches = await txMentionsAnyOfMints({ cluster, signature, mintSet: snipeSet });
          if (!s.running || s.config !== cfg || s.epoch !== epoch) continue;
          if (matches.length === 0) continue;
          (s as any)._matchedMints = matches;
        } catch (e: any) {
          pushSessionLog(cluster, s.owner, "warn", `Mint filter check failed: ${e?.message ?? String(e)}`);
          continue;
        }
      }

      // Only log cluster-level signals when they matter to at least one session.
      pushClusterLog(cluster, "info", `${sourceKey} matched. sig=${signature}`);

      if (!s.running || s.config !== cfg || s.epoch !== epoch) continue;
      s.pendingAction = {
        type: "SIGN_AND_BUNDLE",
        reason:
          cfg.mode === "snipe"
            ? `[snipe/${cfg.pumpFunPhase}] Target detected (${signature}). Click "Sign & execute".`
            : `[volume] Signal detected (${signature}). Click "Sign & execute".`,
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
  session.epoch += 1;

  pushSessionLog(cluster, owner, "info", `Session started. mode=${config.mode} mev=${config.mevEnabled}`);
  // Volume mode is timer-driven; it doesn't need Helius WS subscriptions (reduces rate limits/cost).
  if (config.mode === "snipe") {
    await ensureClusterSubscription(cluster);
  }

  if (config.mode === "volume") {
    startVolumeLoop(cluster, owner);
  }
}

export async function stopWalletSession(cluster: Cluster, owner: string) {
  const session = getOrCreateSession(cluster, owner);
  session.running = false;
  session.config = null;
  session.pendingAction = null;
  session.epoch += 1;
  pushSessionLog(cluster, owner, "info", "Session stopped");

  stopVolumeLoop(cluster, owner);

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
  if (cfg.mode !== "volume" && cfg.minLiquiditySol > 0) {
    pushSessionLog(
      opts.cluster,
      opts.owner,
      "warn",
      "Liquidity filter is a template placeholder. Implement Raydium pool state parsing to enforce it."
    );
  }

  const unsigned: string[] = [];

  if (cfg.mode === "volume") {
    if (!cfg.volumeEnabled) return null;
    const tokenMint = String(cfg.volumeTokenMint || "").trim();
    if (!tokenMint) throw new Error("volumeTokenMint is required for volume mode");

    const lamports = Math.max(1, Math.floor(cfg.buyAmountSol * 1e9));

    // Auto-route:
    // - If Jupiter can quote it, assume "post-migration" (Raydium/DEX liquidity) and use Jupiter swaps.
    // - Otherwise, fall back to Pump.fun pre-migration via PumpPortal, and if that fails try Raydium pool via PumpPortal.
    let usedRoute: "jupiter" | "pumpfun" | "raydium" = "jupiter";
    let jupiterErr: any = null;
    try {
      const buyQuote = await jupiterQuote({
        inputMint: WSOL_MINT,
        outputMint: tokenMint,
        amount: String(lamports),
        slippageBps: cfg.volumeSlippageBps
      });
      const buySwapTxB64 = await jupiterSwapTxBase64({
        quoteResponse: buyQuote,
        userPublicKey: opts.owner,
        wrapAndUnwrapSol: true
      });
      unsigned.push(buySwapTxB64);

      if (cfg.volumeRoundtrip) {
        const sellQuote = await jupiterQuote({
          inputMint: tokenMint,
          outputMint: WSOL_MINT,
          amount: String(buyQuote.outAmount),
          slippageBps: cfg.volumeSlippageBps
        });
        const sellSwapTxB64 = await jupiterSwapTxBase64({
          quoteResponse: sellQuote,
          userPublicKey: opts.owner,
          wrapAndUnwrapSol: true
        });
        unsigned.push(sellSwapTxB64);
      }
    } catch (e: any) {
      jupiterErr = e;
      const slippagePercent = Math.max(0.1, cfg.volumeSlippageBps / 100); // bps -> %
      let buyTxB64: string | null = null;
      let lastErr: any = null;

      // 1) Pump.fun pool (pre-migration)
      try {
        usedRoute = "pumpfun";
        buyTxB64 = await pumpportalTradeTxBase64({
          owner: opts.owner,
          mint: tokenMint,
          action: "buy",
          amount: cfg.buyAmountSol,
          denominatedInSol: true,
          slippagePercent,
          pool: "pump"
        });
      } catch (pumpErr: any) {
        lastErr = pumpErr;
      }

      // 2) Raydium pool (post-migration) via PumpPortal (covers "migrated but not on Jupiter" cases)
      if (!buyTxB64) {
        try {
          usedRoute = "raydium";
          buyTxB64 = await pumpportalTradeTxBase64({
            owner: opts.owner,
            mint: tokenMint,
            action: "buy",
            amount: cfg.buyAmountSol,
            denominatedInSol: true,
            slippagePercent,
            pool: "raydium"
          });
        } catch (rayErr: any) {
          lastErr = rayErr;
        }
      }

      if (!buyTxB64) {
        throw new Error(
          `No swap route for mint=${tokenMint}. JupiterErr=${jupiterErr?.message ?? String(jupiterErr)}; PumpPortal(pump+raydium) failed. LastErr=${lastErr?.message ?? String(lastErr)}`
        );
      }
      unsigned.push(buyTxB64);

      if (cfg.volumeRoundtrip) {
        // PumpPortal builds sell txs by inspecting current wallet token balances.
        // In a single-cycle "buy then sell" flow, that balance won't exist yet, so trade-local often fails.
        // Degrade to buy-only when using PumpPortal routes.
        pushSessionLog(
          opts.cluster,
          opts.owner,
          "warn",
          "Roundtrip is not supported for PumpPortal routes (balance unknown before buy). Proceeding buy-only."
        );
      }
    }

    (session as any)._lastVolumeRoute = usedRoute;
  } else {
    const buyTx = await buildUnsignedBuyLikeTxBase64({
      cluster: opts.cluster,
      owner: opts.owner,
      amountSol: cfg.buyAmountSol,
      memo: `mode=${cfg.mode} phase=${cfg.pumpFunPhase} source=${source} sig=${triggerSig}${targetMint ? ` mint=${targetMint}` : ""}`
    });
    unsigned.push(buyTx);
  }

  if (cfg.mevEnabled) {
    if (opts.cluster === "devnet") {
      pushSessionLog(opts.cluster, opts.owner, "warn", "MEV enabled but cluster=devnet; skipping tip tx.");
    } else {
      try {
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
      } catch (e: any) {
        // When Jito is globally rate-limited (HTTP 429), don't fail building swaps.
        // We'll still attempt to submit a bundle without an explicit tip.
        pushSessionLog(opts.cluster, opts.owner, "warn", `Jito tip unavailable; proceeding without tip. err=${e?.message ?? String(e)}`);
      }
    }
  }

  return unsigned;
}

// ---- Volume loop (timer-driven pending actions) ----

const volumeTimers = new Map<string, NodeJS.Timeout>();

function volumeKey(cluster: Cluster, owner: string) {
  return `${cluster}:${owner}`;
}

function startVolumeLoop(cluster: Cluster, owner: string) {
  const k = volumeKey(cluster, owner);
  if (volumeTimers.has(k)) return;

  const tick = () => {
    const s = getOrCreateSession(cluster, owner);
    const cfg = s.config;
    if (!s.running || !cfg || cfg.mode !== "volume") return;
    if (!cfg.volumeEnabled) return;
    if (s.pendingAction) return;

    s.pendingAction = {
      type: "SIGN_AND_BUNDLE",
      reason: cfg.volumeRoundtrip
        ? `[volume] Cycle ready (auto-route: Jupiter if possible, else Pump.fun): SOL→token→SOL. Click "Sign & execute".`
        : `[volume] Cycle ready (auto-route: Jupiter if possible, else Pump.fun): SOL→token. Click "Sign & execute".`,
      unsignedTxsBase64: []
    };
    (s.pendingAction as any).triggerSignature = `volumeTimer:${Date.now()}`;
    (s.pendingAction as any).source = "volumeTimer";
    (s.pendingAction as any).targetMint = cfg.volumeTokenMint;
    (s.pendingAction as any).needsUnsignedTxs = true;
  };

  // Create the first action quickly, then repeat.
  try {
    tick();
  } catch {
    // ignore
  }

  const handle = setInterval(() => {
    try {
      const s = getOrCreateSession(cluster, owner);
      const cfg = s.config;
      const intervalMs = cfg?.mode === "volume" ? Math.max(2, cfg.volumeIntervalSec) * 1000 : 20_000;
      // Run at 1Hz, but only create a new action when the interval has elapsed.
      const lastMs = (s as any)._lastVolumeActionMs as number | undefined;
      const now = Date.now();
      if (lastMs && now - lastMs < intervalMs) return;
      const before = s.pendingAction;
      tick();
      if (!before && s.pendingAction) (s as any)._lastVolumeActionMs = now;
    } catch (e: any) {
      pushSessionLog(cluster, owner, "warn", `Volume tick failed: ${e?.message ?? String(e)}`);
    }
  }, 1000);

  volumeTimers.set(k, handle);
}

function stopVolumeLoop(cluster: Cluster, owner: string) {
  const k = volumeKey(cluster, owner);
  const h = volumeTimers.get(k);
  if (h) clearInterval(h);
  volumeTimers.delete(k);
}

