import type WebSocket from "ws";

export type Cluster = "mainnet-beta" | "devnet";
export type BotMode = "snipe" | "volume";
export type PumpFunPhase = "pre" | "post";

export type BotConfig = {
  cluster: Cluster;
  mode: BotMode;
  /**
   * When sniping Pump.fun mints you can choose:
   * - "pre": pre-migration (bonding curve / Pump.fun program)
   * - "post": post-migration (Raydium pool)
   */
  pumpFunPhase: PumpFunPhase;
  mevEnabled: boolean;
  buyAmountSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  minLiquiditySol: number;
  autoSellDelaySec: number;
  snipeList: string[];
};

export type LogLine = {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
};

export type PendingAction =
  | {
      type: "SIGN_AND_BUNDLE";
      reason: string;
      unsignedTxsBase64: string[];
    }
  | null;

export type BundleStatus = {
  bundleId: string;
  jitoBundleId?: string;
  state: "prepared" | "submitted" | "confirmed" | "dropped" | "error";
  createdAtMs: number;
  lastUpdateMs: number;
  jitoStatus?: unknown;
  error?: string;
  txSignatures?: string[];
};

export type PreparedBundle = {
  bundleId: string;
  encodedTransactionsBase58: string[];
  createdAtMs: number;
};

export type WalletSession = {
  owner: string; // base58 pubkey (never a private key)
  running: boolean;
  config: BotConfig | null;
  logs: LogLine[];
  bundles: Map<string, BundleStatus>;
  preparedBundles: Map<string, PreparedBundle>;
  pendingAction: PendingAction;
};

export type ClusterRuntime = {
  ws?: WebSocket;
  wsSubIdsByKey?: Map<string, number>;
  wsSubKeyById?: Map<number, string>;
  wsPendingReqIdToKey?: Map<number, string>;
  seenSignatures?: Set<string>;
  clusterLogs: LogLine[];
  sessions: Map<string, WalletSession>; // owner -> session
};

const MAX_LOGS = 500;

function makeSession(owner: string): WalletSession {
  return {
    owner,
    running: false,
    config: null,
    logs: [],
    bundles: new Map(),
    preparedBundles: new Map(),
    pendingAction: null
  };
}

function makeRuntime(): ClusterRuntime {
  return {
    clusterLogs: [],
    sessions: new Map(),
    wsSubIdsByKey: new Map(),
    wsSubKeyById: new Map(),
    wsPendingReqIdToKey: new Map(),
    seenSignatures: new Set()
  };
}

export const state: Record<Cluster, ClusterRuntime> = {
  "mainnet-beta": makeRuntime(),
  devnet: makeRuntime()
};

export function getOrCreateSession(cluster: Cluster, owner: string): WalletSession {
  const runtime = state[cluster];
  const existing = runtime.sessions.get(owner);
  if (existing) return existing;
  const s = makeSession(owner);
  runtime.sessions.set(owner, s);
  return s;
}

export function pushClusterLog(cluster: Cluster, level: LogLine["level"], msg: string) {
  const runtime = state[cluster];
  runtime.clusterLogs.push({ ts: Date.now(), level, msg });
  if (runtime.clusterLogs.length > MAX_LOGS) {
    runtime.clusterLogs.splice(0, runtime.clusterLogs.length - MAX_LOGS);
  }
}

export function pushSessionLog(cluster: Cluster, owner: string, level: LogLine["level"], msg: string) {
  const s = getOrCreateSession(cluster, owner);
  s.logs.push({ ts: Date.now(), level, msg });
  if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS);
}

