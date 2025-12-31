import type WebSocket from "ws";

export type Cluster = "mainnet-beta" | "devnet";
export type BotMode = "snipe" | "volume";

export type BotConfig = {
  cluster: Cluster;
  mode: BotMode;
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

export type ClusterRuntime = {
  running: boolean;
  config: BotConfig | null;
  logs: LogLine[];
  bundles: Map<string, BundleStatus>;
  preparedBundles: Map<string, PreparedBundle>;
  pendingAction: PendingAction;
  ws?: WebSocket;
  wsSubId?: number;
};

const MAX_LOGS = 500;

function makeRuntime(): ClusterRuntime {
  return {
    running: false,
    config: null,
    logs: [],
    bundles: new Map(),
    preparedBundles: new Map(),
    pendingAction: null
  };
}

export const state: Record<Cluster, ClusterRuntime> = {
  "mainnet-beta": makeRuntime(),
  devnet: makeRuntime()
};

export function pushLog(cluster: Cluster, level: LogLine["level"], msg: string) {
  const runtime = state[cluster];
  runtime.logs.push({ ts: Date.now(), level, msg });
  if (runtime.logs.length > MAX_LOGS) runtime.logs.splice(0, runtime.logs.length - MAX_LOGS);
}

