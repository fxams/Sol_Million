"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  clusterApiUrl
} from "@solana/web3.js";
import clsx from "clsx";
import { Buffer } from "buffer";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";

type BotMode = "snipe" | "volume";
type PumpFunPhase = "pre" | "post";
type SnipeTargetMode = "list" | "auto";

type PendingAction =
  | {
      type: "SIGN_AND_BUNDLE";
      reason: string;
      unsignedTxsBase64: string[];
    }
  | null;

type BundleStatus = {
  bundleId: string;
  jitoBundleId?: string;
  state: "prepared" | "submitted" | "confirmed" | "dropped" | "error";
  createdAtMs: number;
  lastUpdateMs: number;
  jitoStatus?: unknown;
  error?: string;
  txSignatures?: string[];
};

type BotStatus = {
  ok: boolean;
  running: boolean;
  cluster: "mainnet-beta" | "devnet";
  owner?: string | null;
  // Back-compat (older backend). New backend returns clusterLogs + sessionLogs.
  logs?: { ts: number; level: "info" | "warn" | "error"; msg: string }[];
  clusterLogs?: { ts: number; level: "info" | "warn" | "error"; msg: string }[];
  sessionLogs?: { ts: number; level: "info" | "warn" | "error"; msg: string }[];
  bundles: BundleStatus[];
  pendingAction: PendingAction;
  sessions?: {
    owner: string;
    running: boolean;
    mode: BotMode | null;
    pumpFunPhase: PumpFunPhase | null;
    mevEnabled: boolean | null;
  }[];
};

type FleetWallet = {
  owner: string; // pubkey base58
  secretKey: number[]; // Uint8Array serialized as number[]
};

type FleetStatusItem = {
  owner: string;
  running: boolean;
  mode: BotMode | null;
  pumpFunPhase: PumpFunPhase | null;
  mevEnabled: boolean | null;
  pendingAction: { type: "SIGN_AND_BUNDLE"; reason: string } | null;
  lastLog: { ts: number; level: "info" | "warn" | "error"; msg: string } | null;
};

type FleetMetricsItem = {
  owner: string;
  balanceSol: number;
  txCountRecent: number;
  txCount24h: number;
  sampledAtMs: number;
};

type SeriesPoint = { ts: number; value: number };

type LogLine = { ts: number; level: "info" | "warn" | "error"; msg: string };

function logLooksLikeSnipe(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("[snipe/") ||
    m.includes("auto-snipe") ||
    m.includes("pumpfun") ||
    m.includes("raydium") ||
    m.includes("snipe list") ||
    m.includes("session started. mode=snipe") ||
    m.includes("mode=snipe") ||
    m.includes("pending action created") ||
    m.includes("target detected")
  );
}

function logLooksLikeVolume(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("[volume]") ||
    m.includes("volume") ||
    m.includes("pumpportal") ||
    m.includes("jupiter") ||
    m.includes("jito tip") ||
    m.includes("session started. mode=volume") ||
    m.includes("mode=volume") ||
    m.includes("volumetimer")
  );
}

function CollapsibleCard(props: {
  title: string;
  defaultOpen?: boolean;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(props.defaultOpen));
  useEffect(() => {
    // If parent wants this section opened (e.g. mode switch), open it.
    if (props.defaultOpen) setOpen(true);
  }, [props.defaultOpen]);
  return (
    <details
      className={clsx(
        "group rounded-xl border border-slate-800 bg-slate-900/50",
        "open:shadow-[0_0_0_1px_rgba(148,163,184,0.08)]",
        props.className
      )}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={clsx(
          "flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3",
          "select-none [&::-webkit-details-marker]:hidden"
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
          <div className="text-base font-semibold text-slate-100">{props.title}</div>
        </div>
        <div className="shrink-0">{props.right}</div>
      </summary>
      <div className="px-4 pb-4 pt-1">{props.children}</div>
    </details>
  );
}

function getBackendBaseUrl() {
  return (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8787").replace(/\/$/, "");
}

function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Sparkline(props: { points: SeriesPoint[]; height?: number }) {
  const h = props.height ?? 36;
  const w = 180;
  const pts = props.points.slice(-60);
  if (pts.length < 2) {
    return <div className="h-[36px] w-[180px] rounded-md border border-slate-800 bg-slate-950" />;
  }
  const min = Math.min(...pts.map((p) => p.value));
  const max = Math.max(...pts.map((p) => p.value));
  const span = Math.max(1e-9, max - min);
  const coords = pts.map((p, i) => {
    const x = (i / (pts.length - 1)) * (w - 2) + 1;
    const y = h - 1 - ((p.value - min) / span) * (h - 2);
    return { x, y };
  });
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="rounded-md border border-slate-800 bg-slate-950">
      <path d={d} fill="none" stroke="rgb(56 189 248)" strokeWidth="1.5" />
    </svg>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={clsx(
        "rounded-md px-3 py-2 text-sm font-semibold transition",
        props.active
          ? "bg-slate-100 text-slate-900"
          : "text-slate-200 hover:bg-slate-800/60"
      )}
    >
      {props.children}
    </button>
  );
}

function KpiCard(props: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
      <div className="text-[11px] text-slate-400">{props.label}</div>
      <div className="mt-0.5 text-sm font-semibold text-slate-100">{props.value}</div>
      {props.sub ? <div className="mt-0.5 text-[11px] text-slate-400">{props.sub}</div> : null}
    </div>
  );
}

function explorerSigUrl(sig: string, cluster: string) {
  const c = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${sig}${c}`;
}

function jitoBundleUrl(bundleId: string) {
  // Jito explorer works for mainnet bundles (bundle ID).
  return `https://explorer.jito.wtf/bundle/${bundleId}`;
}

function isAccessForbiddenRpcError(e: any) {
  const msg = String(e?.message ?? e ?? "");
  return msg.includes("403") || msg.toLowerCase().includes("access forbidden");
}

export function Dashboard() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [activeTab, setActiveTab] = useState<"bot" | "fleet">("bot");

  const [cluster, setCluster] = useState<"mainnet-beta" | "devnet">(
    ((process.env.NEXT_PUBLIC_CLUSTER ?? "mainnet-beta") as "mainnet-beta" | "devnet") ||
      "mainnet-beta"
  );
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);

  const [mode, setMode] = useState<BotMode>("snipe");
  const [pumpFunPhase, setPumpFunPhase] = useState<PumpFunPhase>("pre");
  const [snipeTargetMode, setSnipeTargetMode] = useState<SnipeTargetMode>("auto");
  const [autoMaxTxAgeSec, setAutoMaxTxAgeSec] = useState("20");
  const [autoWindowSec, setAutoWindowSec] = useState("8");
  const [autoMinSignals, setAutoMinSignals] = useState("3");
  const [autoMinUniquePayers, setAutoMinUniquePayers] = useState("3");
  const [autoMaxTop1Pct, setAutoMaxTop1Pct] = useState("20");
  const [autoMaxTop10Pct, setAutoMaxTop10Pct] = useState("60");
  const [autoAllowToken2022, setAutoAllowToken2022] = useState(true);
  const [mevEnabled, setMevEnabled] = useState(true);
  const [buyAmountSol, setBuyAmountSol] = useState("0.1");
  const [volumeEnabled, setVolumeEnabled] = useState(true);
  const [volumeIntervalSec, setVolumeIntervalSec] = useState("20");
  const [volumeTokenMint, setVolumeTokenMint] = useState("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const [volumeSlippageBps, setVolumeSlippageBps] = useState("150");
  const [volumeRoundtrip, setVolumeRoundtrip] = useState(true);
  const [takeProfitPct, setTakeProfitPct] = useState("30");
  const [stopLossPct, setStopLossPct] = useState("15");
  const [minLiquiditySol, setMinLiquiditySol] = useState("10");
  const [autoSellDelaySec, setAutoSellDelaySec] = useState("10");
  const [snipeList, setSnipeList] = useState("");

  const [clusterLogs, setClusterLogs] = useState<NonNullable<BotStatus["clusterLogs"]>>([]);
  const [sessionLogs, setSessionLogs] = useState<NonNullable<BotStatus["sessionLogs"]>>([]);
  const [bundles, setBundles] = useState<BundleStatus[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [sessions, setSessions] = useState<BotStatus["sessions"]>([]);

  const [fleetWallets, setFleetWallets] = useState<FleetWallet[]>([]);
  const [fleetItems, setFleetItems] = useState<FleetStatusItem[]>([]);
  const [fleetMetrics, setFleetMetrics] = useState<FleetMetricsItem[]>([]);
  const [fleetBalanceSeries, setFleetBalanceSeries] = useState<SeriesPoint[]>([]);
  const [fleetTx24hSeries, setFleetTx24hSeries] = useState<SeriesPoint[]>([]);

  const [fundKind, setFundKind] = useState<"sol" | "token">("sol");
  const [fundAmount, setFundAmount] = useState("0.01"); // per wallet
  const [fundTokenMint, setFundTokenMint] = useState("");
  const [fundTokenDecimals, setFundTokenDecimals] = useState("6");
  const [fundMaxWallets, setFundMaxWallets] = useState("20");
  const [fundChunkSize, setFundChunkSize] = useState("8");

  const fleetTotals = useMemo(() => {
    const totalWallets = fleetWallets.length;
    const runningCount = (fleetItems ?? []).filter((x) => x.running).length;
    const pendingCount = (fleetItems ?? []).filter((x) => Boolean(x.pendingAction)).length;
    const totalSol = (fleetMetrics ?? []).reduce((a, m) => a + (Number(m.balanceSol) || 0), 0);
    const totalTx24h = (fleetMetrics ?? []).reduce((a, m) => a + (Number(m.txCount24h) || 0), 0);
    return { totalWallets, runningCount, pendingCount, totalSol, totalTx24h };
  }, [fleetItems, fleetMetrics, fleetWallets.length]);

  const backendBaseUrl = useMemo(() => getBackendBaseUrl(), []);

  const displayLogs = useMemo(() => {
    const merged = [...(clusterLogs ?? []), ...(sessionLogs ?? [])];
    merged.sort((a, b) => a.ts - b.ts);
    return merged;
  }, [clusterLogs, sessionLogs]);

  const snipeLogs = useMemo(() => {
    const logs = displayLogs as LogLine[];
    return logs.filter((l) => logLooksLikeSnipe(l.msg));
  }, [displayLogs]);

  const volumeLogs = useMemo(() => {
    const logs = displayLogs as LogLine[];
    return logs.filter((l) => logLooksLikeVolume(l.msg));
  }, [displayLogs]);

  const copyLogs = useCallback(async () => {
    try {
      const text =
        displayLogs.length === 0
          ? "(no logs)"
          : displayLogs
              .map((l) => `[${new Date(l.ts).toISOString()}] ${l.level.toUpperCase()} ${l.msg}`)
              .join("\n");

      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers/webviews
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("Copy command failed");
      }

      toast.success("Logs copied to clipboard");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to copy logs");
    }
  }, [displayLogs]);

  const configPayload = useMemo(
    () => ({
      cluster,
      mode,
      pumpFunPhase,
      snipeTargetMode,
      autoSnipe: {
        maxTxAgeSec: Number(autoMaxTxAgeSec),
        windowSec: Number(autoWindowSec),
        minSignalsInWindow: Number(autoMinSignals),
        minUniqueFeePayersInWindow: Number(autoMinUniquePayers),
        requireMintAuthorityDisabled: true,
        requireFreezeAuthorityDisabled: true,
        allowToken2022: autoAllowToken2022,
        maxTop1HolderPct: Number(autoMaxTop1Pct),
        maxTop10HolderPct: Number(autoMaxTop10Pct)
      },
      mevEnabled,
      buyAmountSol: Number(buyAmountSol),
      volumeEnabled,
      volumeIntervalSec: Number(volumeIntervalSec),
      volumeTokenMint: volumeTokenMint.trim(),
      volumeSlippageBps: Number(volumeSlippageBps),
      volumeRoundtrip,
      takeProfitPct: Number(takeProfitPct),
      stopLossPct: Number(stopLossPct),
      minLiquiditySol: Number(minLiquiditySol),
      autoSellDelaySec: Number(autoSellDelaySec),
      snipeList: snipeList
        .split(/\s|,|\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    }),
    [
      cluster,
      mode,
      pumpFunPhase,
      snipeTargetMode,
      autoMaxTxAgeSec,
      autoWindowSec,
      autoMinSignals,
      autoMinUniquePayers,
      autoMaxTop1Pct,
      autoMaxTop10Pct,
      autoAllowToken2022,
      mevEnabled,
      buyAmountSol,
      volumeEnabled,
      volumeIntervalSec,
      volumeTokenMint,
      volumeSlippageBps,
      volumeRoundtrip,
      takeProfitPct,
      stopLossPct,
      minLiquiditySol,
      autoSellDelaySec,
      snipeList
    ]
  );

  const fetchStatus = useCallback(async () => {
    const ownerQ = wallet.publicKey ? `&owner=${wallet.publicKey.toBase58()}` : "";
    const res = await fetch(`${backendBaseUrl}/api/status?cluster=${cluster}${ownerQ}`, {
      method: "GET",
      headers: { "content-type": "application/json" }
    });
    if (!res.ok) throw new Error(`status failed (${res.status})`);
    const data = (await res.json()) as BotStatus;
    // During wallet autoConnect or transient disconnects, owner can briefly be undefined.
    // Avoid wiping session-specific UI state in those moments.
    const hasOwner = Boolean(wallet.publicKey);
    if (hasOwner) {
      setRunning(data.running);
      setBundles(data.bundles ?? []);
      setPendingAction(data.pendingAction ?? null);
      // Only update session logs when we have an owner; otherwise keep the last session logs.
      if (data.sessionLogs) setSessionLogs(data.sessionLogs);
    }
    // Cluster logs can always be updated.
    if (data.clusterLogs) setClusterLogs(data.clusterLogs);
    else if (data.logs) setClusterLogs(data.logs);
    setSessions(data.sessions ?? []);
  }, [backendBaseUrl, cluster, wallet.publicKey]);

  const fetchFleetStatus = useCallback(async () => {
    if (fleetWallets.length === 0) return;
    const owners = fleetWallets.map((w) => w.owner);
    const res = await fetch(`${backendBaseUrl}/api/status-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cluster, owners })
    });
    if (!res.ok) throw new Error(`status-batch failed (${res.status})`);
    const data = (await res.json()) as { items?: FleetStatusItem[]; clusterLogs?: any[] };
    if (Array.isArray(data.items)) setFleetItems(data.items);
    // cluster logs can always be updated
    if (data.clusterLogs) setClusterLogs(data.clusterLogs as any);
  }, [backendBaseUrl, cluster, fleetWallets]);

  const fetchFleetMetrics = useCallback(async () => {
    if (fleetWallets.length === 0) return;
    const owners = fleetWallets.map((w) => w.owner);
    const res = await fetch(`${backendBaseUrl}/api/fleet-metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cluster, owners })
    });
    if (!res.ok) throw new Error(`fleet-metrics failed (${res.status})`);
    const data = (await res.json()) as { metrics?: FleetMetricsItem[] };
    if (Array.isArray(data.metrics)) {
      setFleetMetrics(data.metrics);
      const ts = Date.now();
      const totalBal = data.metrics.reduce((a, m) => a + (Number(m.balanceSol) || 0), 0);
      const totalTx24h = data.metrics.reduce((a, m) => a + (Number(m.txCount24h) || 0), 0);
      setFleetBalanceSeries((prev) => [...prev.slice(-59), { ts, value: totalBal }]);
      setFleetTx24hSeries((prev) => [...prev.slice(-59), { ts, value: totalTx24h }]);
    }
  }, [backendBaseUrl, cluster, fleetWallets]);

  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let inFlight = false;
    const intervalMs = 3000;

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") return;
      if (inFlight) return;
      inFlight = true;
      try {
        await fetchStatus();
      } catch {
        // keep last known UI
      } finally {
        inFlight = false;
      }
    };

    const onVis = () => {
      // refresh immediately when user returns
      if (document.visibilityState !== "hidden") tick().catch(() => {});
    };

    (async () => {
      await tick();
      t = setInterval(() => {
        tick().catch(() => {});
      }, intervalMs);
    })();
    return () => {
      stopped = true;
      if (t) clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
    document.addEventListener("visibilitychange", onVis);
  }, [fetchStatus]);

  useEffect(() => {
    if (activeTab !== "fleet") return;
    if (fleetWallets.length === 0) return;
    let t: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let inFlight = false;
    const intervalMs = 5000;

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") return;
      if (inFlight) return;
      inFlight = true;
      try {
        await fetchFleetStatus();
      } catch {
        // keep last known UI
      } finally {
        inFlight = false;
      }
    };

    const onVis = () => {
      if (document.visibilityState !== "hidden") tick().catch(() => {});
    };

    (async () => {
      await tick();
      t = setInterval(() => tick().catch(() => {}), intervalMs);
    })();

    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (t) clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [activeTab, fetchFleetStatus, fleetWallets.length]);

  useEffect(() => {
    if (activeTab !== "fleet") return;
    if (fleetWallets.length === 0) return;
    let t: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let inFlight = false;
    const intervalMs = 12_000;

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "hidden") return;
      if (inFlight) return;
      inFlight = true;
      try {
        await fetchFleetMetrics();
      } catch {
        // keep last known UI
      } finally {
        inFlight = false;
      }
    };

    const onVis = () => {
      if (document.visibilityState !== "hidden") tick().catch(() => {});
    };

    (async () => {
      await tick();
      t = setInterval(() => tick().catch(() => {}), intervalMs);
    })();

    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      if (t) clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [activeTab, fetchFleetMetrics, fleetWallets.length]);

  const startBot = useCallback(async () => {
    if (!wallet.publicKey) {
      toast.error("Connect a wallet first");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${backendBaseUrl}/api/start-monitoring`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...configPayload, owner: wallet.publicKey.toBase58() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `start failed (${res.status})`);
      toast.success("Monitoring started");
      await fetchStatus();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to start");
    } finally {
      setLoading(false);
    }
  }, [backendBaseUrl, configPayload, fetchStatus, wallet.publicKey]);

  const generateFleet = useCallback((n: number) => {
    const wallets: FleetWallet[] = [];
    for (let i = 0; i < n; i++) {
      const kp = Keypair.generate();
      wallets.push({
        owner: kp.publicKey.toBase58(),
        secretKey: Array.from(kp.secretKey)
      });
    }
    setFleetWallets(wallets);
    setFleetItems([]);
    toast.success(`Generated ${n} wallets (local only)`);
  }, []);

  const startFleet = useCallback(async () => {
    if (fleetWallets.length === 0) {
      toast.error("Generate wallets first");
      return;
    }
    setLoading(true);
    try {
      const owners = fleetWallets.map((w) => w.owner);
      const res = await fetch(`${backendBaseUrl}/api/start-monitoring-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...configPayload, owners })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `start batch failed (${res.status})`);
      toast.success(`Started ${data?.started ?? owners.length} sessions`);
      await fetchFleetStatus();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to start fleet");
    } finally {
      setLoading(false);
    }
  }, [backendBaseUrl, configPayload, fetchFleetStatus, fleetWallets]);

  const stopFleet = useCallback(async () => {
    if (fleetWallets.length === 0) return;
    setLoading(true);
    try {
      const owners = fleetWallets.map((w) => w.owner);
      const res = await fetch(`${backendBaseUrl}/api/stop-monitoring-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cluster, owners })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `stop batch failed (${res.status})`);
      toast.success(`Stopped ${data?.stopped ?? owners.length} sessions`);
      await fetchFleetStatus();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to stop fleet");
    } finally {
      setLoading(false);
    }
  }, [backendBaseUrl, cluster, fetchFleetStatus, fleetWallets]);

  const fundFleet = useCallback(async () => {
    if (!wallet.connected || !wallet.publicKey) {
      toast.error("Connect your main wallet first");
      return;
    }
    if (!wallet.signTransaction) {
      toast.error("Wallet does not support signTransaction");
      return;
    }
    if (fleetWallets.length === 0) {
      toast.error("Generate wallets first");
      return;
    }

    const maxN = Math.max(1, Math.min(fleetWallets.length, Number(fundMaxWallets) || fleetWallets.length));
    const recipients = fleetWallets.slice(0, maxN).map((w) => new PublicKey(w.owner));
    const chunkSize = Math.max(1, Math.min(16, Number(fundChunkSize) || 8));

    const amountNum = Number(fundAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      toast.error("Enter a valid amount");
      return;
    }

    setLoading(true);
    try {
      const payer = wallet.publicKey;
      let rpcConn: Connection = connection;
      let blockhash: string;
      try {
        const bh = await rpcConn.getLatestBlockhash("processed");
        blockhash = bh.blockhash;
      } catch (e: any) {
        if (!isAccessForbiddenRpcError(e)) throw e;
        // If the configured RPC is forbidden (common with missing/invalid API keys),
        // fall back to Solana public RPC for funding transactions.
        toast.error("RPC access forbidden (403). Falling back to public RPC. Set NEXT_PUBLIC_RPC_URL to a valid endpoint.");
        rpcConn = new Connection(clusterApiUrl(cluster), "processed");
        const bh = await rpcConn.getLatestBlockhash("processed");
        blockhash = bh.blockhash;
      }

      const txs: VersionedTransaction[] = [];

      if (fundKind === "sol") {
        const lamportsPer = Math.floor(amountNum * 1e9);
        if (lamportsPer <= 0) throw new Error("Amount too small (lamports rounds to 0)");

        for (let i = 0; i < recipients.length; i += chunkSize) {
          const chunk = recipients.slice(i, i + chunkSize);
          const ixs = chunk.map((to) =>
            SystemProgram.transfer({
              fromPubkey: payer,
              toPubkey: to,
              lamports: lamportsPer
            })
          );
          const msg = new TransactionMessage({
            payerKey: payer,
            recentBlockhash: blockhash,
            instructions: ixs
          }).compileToV0Message();
          txs.push(new VersionedTransaction(msg));
        }
      } else {
        const mintStr = fundTokenMint.trim();
        if (!mintStr) throw new Error("Enter token mint");
        const mint = new PublicKey(mintStr);
        const decimals = Math.max(0, Math.min(12, Number(fundTokenDecimals) || 0));
        const baseUnits = BigInt(Math.round(amountNum * Math.pow(10, decimals)));
        if (baseUnits <= 0n) throw new Error("Amount too small after decimals");

        const payerAta = getAssociatedTokenAddressSync(mint, payer, false);
        const recipientAtas = recipients.map((to) => getAssociatedTokenAddressSync(mint, to, false));

        // Check which ATAs exist (batch RPC)
        const infos = await rpcConn.getMultipleAccountsInfo(recipientAtas, "processed");
        const missing = new Set<string>();
        for (let i = 0; i < recipientAtas.length; i++) {
          if (!infos[i]) missing.add(recipientAtas[i].toBase58());
        }

        for (let i = 0; i < recipients.length; i += Math.max(1, Math.min(6, chunkSize))) {
          const chunkRecipients = recipients.slice(i, i + Math.max(1, Math.min(6, chunkSize)));
          const chunkAtas = recipientAtas.slice(i, i + Math.max(1, Math.min(6, chunkSize)));
          const ixs = [];
          for (let j = 0; j < chunkRecipients.length; j++) {
            const to = chunkRecipients[j];
            const ata = chunkAtas[j];
            if (missing.has(ata.toBase58())) {
              ixs.push(createAssociatedTokenAccountInstruction(payer, ata, to, mint));
            }
            ixs.push(createTransferInstruction(payerAta, ata, payer, baseUnits));
          }
          const msg = new TransactionMessage({
            payerKey: payer,
            recentBlockhash: blockhash,
            instructions: ixs
          }).compileToV0Message();
          txs.push(new VersionedTransaction(msg));
        }
      }

      const maybeSignAll = (wallet as any).signAllTransactions as ((txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>) | undefined;
      const signedTxs = maybeSignAll ? await maybeSignAll(txs) : await (async () => {
        const out: VersionedTransaction[] = [];
        for (const tx of txs) {
          // eslint-disable-next-line no-await-in-loop
          out.push(await wallet.signTransaction!(tx));
        }
        return out;
      })();

      let sent = 0;
      for (const tx of signedTxs) {
        // eslint-disable-next-line no-await-in-loop
        await rpcConn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "processed",
          maxRetries: 3
        });
        sent += 1;
      }

      toast.success(`Sent ${sent} transaction(s)`);
      await fetchFleetMetrics();
    } catch (e: any) {
      toast.error(e?.message ?? "Funding failed");
    } finally {
      setLoading(false);
    }
  }, [
    connection,
    fetchFleetMetrics,
    fleetWallets,
    fundAmount,
    fundChunkSize,
    fundKind,
    fundMaxWallets,
    fundTokenDecimals,
    fundTokenMint,
    wallet
  ]);

  const stopBot = useCallback(async () => {
    if (!wallet.publicKey) {
      toast.error("Connect a wallet first");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${backendBaseUrl}/api/stop-monitoring`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cluster, owner: wallet.publicKey.toBase58() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `stop failed (${res.status})`);
      toast.success("Monitoring stopped");
      await fetchStatus();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to stop");
    } finally {
      setLoading(false);
    }
  }, [backendBaseUrl, cluster, fetchStatus, wallet.publicKey]);

  const signAndExecutePendingAction = useCallback(async () => {
    if (!pendingAction) return;
    if (!wallet.connected || !wallet.publicKey) {
      toast.error("Connect a wallet first");
      return;
    }
    if (!wallet.signTransaction) {
      toast.error("Wallet does not support signTransaction");
      return;
    }

    setLoading(true);
    try {
      if (pendingAction.type !== "SIGN_AND_BUNDLE") return;
      if (cluster === "devnet" && mevEnabled) throw new Error("Jito bundles are mainnet-only; disable MEV on devnet.");

      // 1) Deserialize unsigned txs from backend
      const unsigned = pendingAction.unsignedTxsBase64.map((b64) =>
        VersionedTransaction.deserialize(Buffer.from(b64, "base64"))
      );

      // 2) Let wallet sign each tx client-side (backend never sees keys)
      const signed: VersionedTransaction[] = [];
      for (const tx of unsigned) {
        // Ensure payer is the connected wallet (backend sets this, but we validate UX-side)
        const signedTx = await wallet.signTransaction(tx);
        signed.push(signedTx);
      }

      const signedTxsBase64 = signed.map((tx) => Buffer.from(tx.serialize()).toString("base64"));

      if (mevEnabled) {
        // 3) Ask backend to build + simulate the bundle (Jito) from signed txs
        const prepRes = await fetch(`${backendBaseUrl}/api/prepare-bundle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cluster,
            owner: wallet.publicKey.toBase58(),
            signedTxsBase64
          })
        });
        const prepData = await prepRes.json().catch(() => ({}));
        if (!prepRes.ok) throw new Error(prepData?.error ?? `prepare failed (${prepRes.status})`);

        const bundleId = prepData.bundleId as string;
        toast.success(`Bundle prepared: ${bundleId.slice(0, 10)}…`);

        // 4) Submit bundle
        const subRes = await fetch(`${backendBaseUrl}/api/submit-bundle`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cluster, owner: wallet.publicKey.toBase58(), bundleId })
        });
        const subData = await subRes.json().catch(() => ({}));
        if (!subRes.ok) throw new Error(subData?.error ?? `submit failed (${subRes.status})`);

        toast.success("Submitted to Jito");
      } else {
        const sigs: string[] = [];
        for (const tx of signed) {
          const sig = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: "processed",
            maxRetries: 3
          });
          sigs.push(sig);
        }
        await fetch(`${backendBaseUrl}/api/ack-action`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cluster, owner: wallet.publicKey.toBase58() })
        }).catch(() => {});
        toast.success(`Sent ${sigs.length} tx(s) via public RPC`);
      }
      await fetchStatus();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to sign/submit");
    } finally {
      setLoading(false);
    }
  }, [backendBaseUrl, cluster, connection, fetchStatus, mevEnabled, pendingAction, wallet]);

  const sendPublicTestTx = useCallback(async () => {
    if (!wallet.connected || !wallet.publicKey) {
      toast.error("Connect a wallet first");
      return;
    }
    if (!wallet.signTransaction) {
      toast.error("Wallet does not support signTransaction");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${backendBaseUrl}/api/prepare-buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cluster,
          owner: wallet.publicKey.toBase58(),
          amountSol: Number(buyAmountSol),
          memo: "Public test tx (no MEV)"
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `prepare-buy failed (${res.status})`);

      const tx = VersionedTransaction.deserialize(Buffer.from(data.unsignedTxBase64, "base64"));
      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "processed",
        maxRetries: 3
      });
      toast.success(`Sent: ${sig.slice(0, 10)}…`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to send");
    } finally {
      setLoading(false);
    }
  }, [backendBaseUrl, buyAmountSol, cluster, connection, wallet]);

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-6xl px-3 py-5 sm:px-4 sm:py-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xl font-semibold tracking-tight sm:text-2xl">Solana Bot App</div>
            <div className="text-xs text-slate-300 sm:text-sm">
              Client-signed trades + optional MEV protection via Jito bundles
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <select
              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
              value={cluster}
              onChange={(e) => setCluster(e.target.value as any)}
              disabled={loading}
              aria-label="cluster"
            >
              <option value="mainnet-beta">mainnet-beta</option>
              <option value="devnet">devnet</option>
            </select>
            <WalletMultiButton />
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex w-full items-center justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-1 sm:w-auto sm:justify-start">
            <div className="inline-flex gap-1">
              <TabButton active={activeTab === "bot"} onClick={() => setActiveTab("bot")}>
                Bot
              </TabButton>
              <TabButton active={activeTab === "fleet"} onClick={() => setActiveTab("fleet")}>
                Wallet Fleet
              </TabButton>
            </div>
            <div className="hidden sm:block" />
          </div>

          {activeTab === "bot" ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <KpiCard label="Status" value={running ? "Running" : "Stopped"} />
              <KpiCard label="Mode" value={mode} />
              <KpiCard label="Pending action" value={pendingAction ? "Yes" : "No"} />
              <KpiCard label="MEV" value={mevEnabled ? "On" : "Off"} sub={cluster === "devnet" ? "Devnet: bundles off" : undefined} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <KpiCard label="Wallets" value={fleetTotals.totalWallets} />
              <KpiCard label="Running" value={fleetTotals.runningCount} />
              <KpiCard label="Pending" value={fleetTotals.pendingCount} />
              <KpiCard label="Total SOL" value={fleetTotals.totalSol.toFixed(3)} />
              <KpiCard label="Tx (24h)" value={fleetTotals.totalTx24h} />
            </div>
          )}
        </div>

        {activeTab === "bot" ? (
        <>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-2">
          <CollapsibleCard
            title="Bot configuration"
            defaultOpen
            right={
              <div
                className={clsx(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium",
                  running ? "bg-emerald-900/40 text-emerald-200" : "bg-slate-800 text-slate-200"
                )}
              >
                {running ? "RUNNING" : "STOPPED"}
              </div>
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Buy amount (SOL)</span>
                <input
                  className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                  value={buyAmountSol}
                  onChange={(e) => setBuyAmountSol(e.target.value)}
                  inputMode="decimal"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Min pool liquidity (SOL)</span>
                <input
                  className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                  value={minLiquiditySol}
                  onChange={(e) => setMinLiquiditySol(e.target.value)}
                  inputMode="decimal"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Take Profit %</span>
                <input
                  className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                  value={takeProfitPct}
                  onChange={(e) => setTakeProfitPct(e.target.value)}
                  inputMode="decimal"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Stop Loss %</span>
                <input
                  className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                  value={stopLossPct}
                  onChange={(e) => setStopLossPct(e.target.value)}
                  inputMode="decimal"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Auto-sell delay (sec)</span>
                <input
                  className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                  value={autoSellDelaySec}
                  onChange={(e) => setAutoSellDelaySec(e.target.value)}
                  inputMode="numeric"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Mode</span>
                <div className="flex gap-2">
                  <button
                    className={clsx(
                      "flex-1 rounded-md border px-3 py-2 text-sm",
                      mode === "snipe"
                        ? "border-emerald-600 bg-emerald-900/30"
                        : "border-slate-800 bg-slate-950"
                    )}
                    onClick={() => setMode("snipe")}
                    disabled={loading}
                    type="button"
                  >
                    Snipe
                  </button>
                  <button
                    className={clsx(
                      "flex-1 rounded-md border px-3 py-2 text-sm",
                      mode === "volume"
                        ? "border-emerald-600 bg-emerald-900/30"
                        : "border-slate-800 bg-slate-950"
                    )}
                    onClick={() => setMode("volume")}
                    disabled={loading}
                    type="button"
                  >
                    Volume/Arb
                  </button>
                </div>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Pump.fun snipe phase</span>
                <select
                  className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                  value={pumpFunPhase}
                  onChange={(e) => setPumpFunPhase(e.target.value as PumpFunPhase)}
                  disabled={loading || mode !== "snipe"}
                >
                  <option value="pre">Pre-migration (Pump.fun bonding curve)</option>
                  <option value="post">Post-migration (Raydium)</option>
                </select>
              </label>

              {mode === "snipe" && pumpFunPhase === "pre" && (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-slate-300">Snipe target selection</span>
                    <select
                      className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                      value={snipeTargetMode}
                      onChange={(e) => setSnipeTargetMode(e.target.value as SnipeTargetMode)}
                      disabled={loading}
                    >
                      <option value="auto">Auto (new Pump.fun mints + safety filters)</option>
                      <option value="list">Mint list only</option>
                    </select>
                  </label>

                  {snipeTargetMode === "auto" && (
                    <details className="group rounded-lg border border-slate-800 bg-slate-950 sm:col-span-2">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-slate-200 [&::-webkit-details-marker]:hidden">
                        <div className="flex items-center gap-2">
                          <span className="text-slate-500 transition-transform group-open:rotate-90">›</span>
                          <span className="font-semibold text-slate-100">Auto-snipe filters</span>
                        </div>
                        <span className="text-slate-400">advanced</span>
                      </summary>
                      <div className="px-3 pb-3 pt-1 text-xs text-slate-200">
                        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-slate-400">Max tx age (sec)</span>
                            <input
                              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                              value={autoMaxTxAgeSec}
                              onChange={(e) => setAutoMaxTxAgeSec(e.target.value)}
                              inputMode="numeric"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-slate-400">Window (sec)</span>
                            <input
                              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                              value={autoWindowSec}
                              onChange={(e) => setAutoWindowSec(e.target.value)}
                              inputMode="numeric"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-slate-400">Min signals</span>
                            <input
                              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                              value={autoMinSignals}
                              onChange={(e) => setAutoMinSignals(e.target.value)}
                              inputMode="numeric"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-slate-400">Min unique payers</span>
                            <input
                              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                              value={autoMinUniquePayers}
                              onChange={(e) => setAutoMinUniquePayers(e.target.value)}
                              inputMode="numeric"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-slate-400">Max top1 %</span>
                            <input
                              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                              value={autoMaxTop1Pct}
                              onChange={(e) => setAutoMaxTop1Pct(e.target.value)}
                              inputMode="decimal"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-slate-400">Max top10 %</span>
                            <input
                              className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                              value={autoMaxTop10Pct}
                              onChange={(e) => setAutoMaxTop10Pct(e.target.value)}
                              inputMode="decimal"
                            />
                          </label>
                        </div>
                        <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900 px-3 py-2">
                          <span className="text-slate-200">Allow Token-2022 mints (recommended)</span>
                          <input
                            type="checkbox"
                            checked={autoAllowToken2022}
                            onChange={(e) => setAutoAllowToken2022(e.target.checked)}
                            disabled={loading}
                          />
                        </label>
                        <div className="mt-2 text-slate-400">
                          Auto mode only triggers when a mint passes safety checks and shows enough early momentum.
                        </div>
                      </div>
                    </details>
                  )}
                </>
              )}
            </div>

            <div className="mt-4">
              <label className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm">
                <span className="text-slate-200">MEV protection (Jito bundles)</span>
                <input
                  type="checkbox"
                  checked={mevEnabled}
                  onChange={(e) => setMevEnabled(e.target.checked)}
                  disabled={loading || cluster === "devnet"}
                />
              </label>
              {cluster === "devnet" && (
                <div className="mt-2 text-xs text-amber-200">
                  Devnet: Jito bundles are mainnet-only. Disable MEV to test end-to-end signing.
                </div>
              )}
            </div>

            {mode === "volume" && (
              <details className="group mt-4 rounded-lg border border-slate-800 bg-slate-950">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm text-slate-200 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 transition-transform group-open:rotate-90">›</span>
                    <span className="font-semibold text-slate-200">Volume settings</span>
                  </div>
                  <span className="text-xs text-slate-400">advanced</span>
                </summary>
                <div className="px-3 pb-3 pt-1">
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-slate-300">Interval (sec)</span>
                    <input
                      className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                      value={volumeIntervalSec}
                      onChange={(e) => setVolumeIntervalSec(e.target.value)}
                      inputMode="numeric"
                      disabled={loading}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-slate-300">Slippage (bps)</span>
                    <input
                      className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2"
                      value={volumeSlippageBps}
                      onChange={(e) => setVolumeSlippageBps(e.target.value)}
                      inputMode="numeric"
                      disabled={loading}
                    />
                  </label>
                </div>
                <label className="mt-3 flex flex-col gap-1 text-sm">
                  <span className="text-slate-300">Token mint (paired against SOL)</span>
                  <input
                    className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-xs"
                    value={volumeTokenMint}
                    onChange={(e) => setVolumeTokenMint(e.target.value)}
                    disabled={loading}
                  />
                  <span className="text-xs text-slate-400">
                    Default is USDC. Volume mode auto-routes: Jupiter if tradable (post-migration), otherwise Pump.fun (pre-migration).
                  </span>
                </label>
                <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm">
                  <span className="text-slate-200">Roundtrip (SOL→token→SOL)</span>
                  <input
                    type="checkbox"
                    checked={volumeRoundtrip}
                    onChange={(e) => setVolumeRoundtrip(e.target.checked)}
                    disabled={loading}
                  />
                </label>
                <label className="mt-2 flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm">
                  <span className="text-slate-200">Enable volume generator</span>
                  <input
                    type="checkbox"
                    checked={volumeEnabled}
                    onChange={(e) => setVolumeEnabled(e.target.checked)}
                    disabled={loading}
                  />
                </label>
                </div>
              </details>
            )}

            <div className="mt-4">
              <details className="group rounded-lg border border-slate-800 bg-slate-950">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm text-slate-200 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 transition-transform group-open:rotate-90">›</span>
                    <span className="font-semibold text-slate-200">Snipe list</span>
                  </div>
                  <span className="text-xs text-slate-400">optional</span>
                </summary>
                <div className="px-3 pb-3 pt-1">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-slate-300">Token mints</span>
                    <textarea
                      className="min-h-[96px] rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs"
                      placeholder="Mint addresses, separated by commas/spaces/newlines"
                      value={snipeList}
                      onChange={(e) => setSnipeList(e.target.value)}
                      disabled={mode === "snipe" && pumpFunPhase === "pre" && snipeTargetMode === "auto"}
                    />
                  </label>
                  {mode === "snipe" && pumpFunPhase === "pre" && snipeTargetMode === "auto" && (
                    <div className="mt-2 text-xs text-slate-400">
                      Auto mode ignores the snipe list and discovers targets automatically.
                    </div>
                  )}
                </div>
              </details>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {!running ? (
                <button
                  className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
                  disabled={loading}
                  onClick={startBot}
                >
                  Start monitoring
                </button>
              ) : (
                <button
                  className="rounded-md bg-rose-600 px-4 py-2 text-sm font-semibold text-slate-50 disabled:opacity-60"
                  disabled={loading}
                  onClick={stopBot}
                >
                  Stop
                </button>
              )}

              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-60"
                disabled={loading || mevEnabled}
                onClick={sendPublicTestTx}
                title={mevEnabled ? "Disable MEV to send via public RPC" : ""}
              >
                Send public test tx
              </button>

              <button
                className="rounded-md border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-60"
                disabled={loading || !pendingAction}
                onClick={signAndExecutePendingAction}
                title={mevEnabled ? "Executes via Jito bundle" : "Executes via public RPC"}
              >
                Sign & execute
              </button>
            </div>

            {pendingAction && (
              <div className="mt-4 rounded-lg border border-amber-800/60 bg-amber-900/10 p-3 text-sm">
                <div className="font-semibold text-amber-200">Pending action</div>
                <div className="mt-1 text-amber-100/90">{pendingAction.reason}</div>
                <div className="mt-2 text-xs text-amber-100/70">
                  Your wallet signs locally. With MEV on: backend simulates + submits a Jito bundle. With MEV off:
                  transactions are sent via public RPC.
                </div>
              </div>
            )}

            <div className="mt-5">
              <details className="group rounded-lg border border-slate-800 bg-slate-950">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm text-slate-200 [&::-webkit-details-marker]:hidden">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 transition-transform group-open:rotate-90">›</span>
                    <span className="font-semibold text-slate-200">Backend wallet sessions</span>
                  </div>
                  <span className="text-xs text-slate-400">{(sessions ?? []).length}</span>
                </summary>
                <div className="px-3 pb-3 pt-1">
                  <div className="rounded-md border border-slate-800 bg-slate-950">
                    <div className="max-h-[180px] overflow-auto">
                      {(sessions ?? []).length === 0 ? (
                        <div className="px-3 py-3 text-xs text-slate-500">No active sessions.</div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="min-w-[520px] text-left text-xs">
                            <thead className="border-b border-slate-800 text-slate-400">
                              <tr>
                                <th className="px-3 py-2">Owner</th>
                                <th className="px-3 py-2">Mode</th>
                                <th className="px-3 py-2">Phase</th>
                                <th className="px-3 py-2">MEV</th>
                                <th className="px-3 py-2">Running</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(sessions ?? []).map((s) => {
                                const isMe = wallet.publicKey?.toBase58() === s.owner;
                                return (
                                  <tr key={s.owner} className="border-b border-slate-900">
                                    <td className="px-3 py-2 font-mono text-[11px] text-slate-200">
                                      {isMe ? <span className="text-emerald-300">● </span> : null}
                                      {s.owner}
                                    </td>
                                    <td className="px-3 py-2 text-slate-200">{s.mode ?? "-"}</td>
                                    <td className="px-3 py-2 text-slate-200">{s.pumpFunPhase ?? "-"}</td>
                                    <td className="px-3 py-2 text-slate-200">
                                      {s.mevEnabled == null ? "-" : s.mevEnabled ? "on" : "off"}
                                    </td>
                                    <td className="px-3 py-2 text-slate-200">{s.running ? "yes" : "no"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-slate-400">
                    To run sniper + volume with different wallets, open this app in two browser profiles and connect
                    a different wallet in each.
                  </div>
                </div>
              </details>
            </div>
          </CollapsibleCard>

          <CollapsibleCard
            title="Live logs"
            defaultOpen={false}
            right={
              <button
                className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 disabled:opacity-60"
                onClick={copyLogs}
                disabled={loading}
                type="button"
              >
                Copy
              </button>
            }
          >
            <div className="grid grid-cols-1 gap-3">
              <CollapsibleCard title="Snipe logs" defaultOpen={mode === "snipe"}>
                <div className="h-[200px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed sm:h-[260px]">
                  {snipeLogs.length === 0 ? (
                    <div className="text-slate-500">No snipe logs yet.</div>
                  ) : (
                    snipeLogs.map((l, idx) => (
                      <div key={`${l.ts}-s-${idx}`} className="whitespace-pre-wrap">
                        <span className="text-slate-500">{new Date(l.ts).toLocaleTimeString()} </span>
                        <span
                          className={clsx(
                            l.level === "error"
                              ? "text-rose-300"
                              : l.level === "warn"
                                ? "text-amber-300"
                                : "text-slate-200"
                          )}
                        >
                          {l.msg}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </CollapsibleCard>

              <CollapsibleCard title="Volume logs" defaultOpen={mode === "volume"}>
                <div className="h-[200px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed sm:h-[260px]">
                  {volumeLogs.length === 0 ? (
                    <div className="text-slate-500">
                      No volume-tagged logs yet. Showing recent logs:
                      <div className="mt-2">
                        {displayLogs.slice(-50).map((l: any, idx: number) => (
                          <div key={`${l.ts}-all-${idx}`} className="whitespace-pre-wrap">
                            <span className="text-slate-500">{new Date(l.ts).toLocaleTimeString()} </span>
                            <span
                              className={clsx(
                                l.level === "error"
                                  ? "text-rose-300"
                                  : l.level === "warn"
                                    ? "text-amber-300"
                                    : "text-slate-200"
                              )}
                            >
                              {l.msg}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    volumeLogs.map((l, idx) => (
                      <div key={`${l.ts}-v-${idx}`} className="whitespace-pre-wrap">
                        <span className="text-slate-500">{new Date(l.ts).toLocaleTimeString()} </span>
                        <span
                          className={clsx(
                            l.level === "error"
                              ? "text-rose-300"
                              : l.level === "warn"
                                ? "text-amber-300"
                                : "text-slate-200"
                          )}
                        >
                          {l.msg}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </CollapsibleCard>
            </div>
            <div className="mt-2 text-xs text-slate-400">
              Logs are filtered by mode so you can focus while trading.
            </div>
          </CollapsibleCard>
        </div>

        <div className="mt-4 sm:mt-6">
          <CollapsibleCard
            title="Bundle / transaction history"
            defaultOpen={false}
            right={
              <button
                className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200"
                onClick={() => fetchStatus().catch(() => {})}
                disabled={loading}
              >
                Refresh
              </button>
            }
          >
            <div className="mt-2 overflow-x-auto rounded-lg border border-slate-800">
              <table className="min-w-[820px] text-left text-sm">
              <thead className="bg-slate-950 text-slate-300">
                <tr>
                  <th className="px-4 py-3">Bundle</th>
                  <th className="px-4 py-3">State</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Links</th>
                </tr>
              </thead>
              <tbody>
                {bundles.length === 0 ? (
                  <tr>
                    <td className="px-4 py-4 text-slate-500" colSpan={4}>
                      No bundles yet.
                    </td>
                  </tr>
                ) : (
                  bundles.map((b) => (
                    <tr key={b.bundleId} className="border-t border-slate-800">
                      <td className="px-4 py-3 font-mono text-xs text-slate-200">
                        {b.bundleId}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={clsx(
                            "rounded-full px-2 py-1 text-xs",
                            b.state === "confirmed"
                              ? "bg-emerald-900/30 text-emerald-200"
                              : b.state === "error"
                                ? "bg-rose-900/30 text-rose-200"
                                : b.state === "dropped"
                                  ? "bg-amber-900/30 text-amber-200"
                                  : "bg-slate-800 text-slate-200"
                          )}
                        >
                          {b.state}
                        </span>
                        {b.error && <div className="mt-1 text-xs text-rose-200">{b.error}</div>}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        {new Date(b.createdAtMs).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex flex-wrap gap-3">
                          <a
                            className="text-sky-300 hover:underline"
                            href={jitoBundleUrl(b.jitoBundleId ?? b.bundleId)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Jito bundle
                          </a>
                          {(b.txSignatures ?? []).slice(0, 3).map((sig) => (
                            <a
                              key={sig}
                              className="text-sky-300 hover:underline"
                              href={explorerSigUrl(sig, cluster)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Tx
                            </a>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          </CollapsibleCard>
        </div>
        </>
        ) : (
          <div className="mt-4 space-y-4 sm:space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:gap-6">
              <CollapsibleCard title="Wallet fleet — stats & management" defaultOpen>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-60"
                    disabled={loading}
                    type="button"
                    onClick={() => generateFleet(20)}
                  >
                    Generate 20 wallets
                  </button>
                  <button
                    className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-60"
                    disabled={loading || fleetWallets.length === 0}
                    type="button"
                    onClick={() =>
                      downloadJson(`wallet-fleet-${cluster}-${Date.now()}.json`, {
                        cluster,
                        createdAt: new Date().toISOString(),
                        wallets: fleetWallets
                      })
                    }
                  >
                    Download keys (JSON)
                  </button>
                  <button
                    className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                    disabled={loading || fleetWallets.length === 0}
                    type="button"
                    onClick={startFleet}
                  >
                    Start all
                  </button>
                  <button
                    className="rounded-md bg-rose-600 px-3 py-2 text-xs font-semibold text-slate-50 disabled:opacity-60"
                    disabled={loading || fleetWallets.length === 0}
                    type="button"
                    onClick={stopFleet}
                  >
                    Stop all
                  </button>
                  <button
                    className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-60"
                    disabled={loading || fleetWallets.length === 0}
                    type="button"
                    onClick={() => {
                      setFleetWallets([]);
                      setFleetItems([]);
                      setFleetMetrics([]);
                      setFleetBalanceSeries([]);
                      setFleetTx24hSeries([]);
                    }}
                  >
                    Clear
                  </button>
                </div>

                <div className="mt-2 text-xs text-slate-400">
                  Wallets are generated in your browser. The backend only receives public keys. Download the JSON if you
                  need to import these wallets later (refreshing will lose them).
                </div>

                {fleetWallets.length > 0 ? (
                  <>
                    <CollapsibleCard title="Fund fleet" defaultOpen={false} className="mt-4">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-slate-300">Asset</span>
                          <select
                            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                            value={fundKind}
                            onChange={(e) => setFundKind(e.target.value as any)}
                            disabled={loading}
                          >
                            <option value="sol">SOL</option>
                            <option value="token">SPL token</option>
                          </select>
                        </label>

                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-slate-300">Amount per wallet</span>
                          <input
                            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                            value={fundAmount}
                            onChange={(e) => setFundAmount(e.target.value)}
                            inputMode="decimal"
                            disabled={loading}
                          />
                        </label>

                        {fundKind === "token" && (
                          <>
                            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                              <span className="text-slate-300">Token mint</span>
                              <input
                                className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs"
                                value={fundTokenMint}
                                onChange={(e) => setFundTokenMint(e.target.value)}
                                disabled={loading}
                                placeholder="Mint address"
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="text-slate-300">Token decimals</span>
                              <input
                                className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                                value={fundTokenDecimals}
                                onChange={(e) => setFundTokenDecimals(e.target.value)}
                                inputMode="numeric"
                                disabled={loading}
                              />
                            </label>
                            <div className="text-xs text-slate-400 sm:pt-6">
                              Decimals are required to convert “amount per wallet” to base units.
                            </div>
                          </>
                        )}

                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-slate-300">Max wallets</span>
                          <input
                            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                            value={fundMaxWallets}
                            onChange={(e) => setFundMaxWallets(e.target.value)}
                            inputMode="numeric"
                            disabled={loading}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          <span className="text-slate-300">Recipients per tx</span>
                          <input
                            className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2"
                            value={fundChunkSize}
                            onChange={(e) => setFundChunkSize(e.target.value)}
                            inputMode="numeric"
                            disabled={loading}
                          />
                        </label>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          className="rounded-md bg-sky-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                          disabled={loading || fleetWallets.length === 0}
                          type="button"
                          onClick={fundFleet}
                        >
                          Send from connected wallet
                        </button>
                        <div className="text-xs text-slate-400">
                          Sends on-chain transfers from your connected wallet. Token transfers will auto-create missing
                          ATAs for recipients.
                        </div>
                      </div>
                    </CollapsibleCard>

                    <div className="mt-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950 p-3 sm:grid-cols-2">
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-semibold text-slate-200">Total SOL balance</div>
                          <div className="text-xs text-slate-300">{fleetTotals.totalSol.toFixed(3)}</div>
                        </div>
                        <div className="mt-2">
                          <Sparkline points={fleetBalanceSeries} />
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">Last ~60 samples</div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-semibold text-slate-200">Tx count (last 24h)</div>
                          <div className="text-xs text-slate-300">{fleetTotals.totalTx24h}</div>
                        </div>
                        <div className="mt-2">
                          <Sparkline points={fleetTx24hSeries} />
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">Based on last 100 signatures per wallet</div>
                      </div>
                    </div>

                    <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950">
                      <table className="min-w-[980px] text-left text-xs">
                        <thead className="border-b border-slate-800 text-slate-400">
                          <tr>
                            <th className="px-3 py-2">Owner</th>
                            <th className="px-3 py-2">Running</th>
                            <th className="px-3 py-2">Pending</th>
                            <th className="px-3 py-2">Balance (SOL)</th>
                            <th className="px-3 py-2">Tx (24h)</th>
                            <th className="px-3 py-2">Tx (last 100)</th>
                            <th className="px-3 py-2">Last log</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(fleetItems.length ? fleetItems : fleetWallets.map((w) => ({ owner: w.owner } as any))).map(
                            (it: FleetStatusItem, idx: number) => {
                              const m = fleetMetrics.find((x) => x.owner === it.owner);
                              const pending = Boolean(it.pendingAction);
                              return (
                                <tr key={`${it.owner}-${idx}`} className="border-b border-slate-900">
                                  <td className="px-3 py-2 font-mono text-[11px] text-slate-200" title={it.owner}>
                                    <span className="inline-block max-w-[420px] truncate">{it.owner}</span>
                                  </td>
                                  <td className="px-3 py-2 text-slate-200">{it.running ? "yes" : "no"}</td>
                                  <td className="px-3 py-2 text-slate-200">
                                    {pending ? <span className="text-amber-200">yes</span> : "no"}
                                  </td>
                                  <td className="px-3 py-2 text-slate-200">{m ? m.balanceSol.toFixed(4) : "-"}</td>
                                  <td className="px-3 py-2 text-slate-200">{m ? m.txCount24h : "-"}</td>
                                  <td className="px-3 py-2 text-slate-200">{m ? m.txCountRecent : "-"}</td>
                                  <td className="px-3 py-2 text-slate-400">
                                    {it.lastLog ? `${it.lastLog.level.toUpperCase()} ${it.lastLog.msg}` : "-"}
                                  </td>
                                </tr>
                              );
                            }
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 p-4 text-sm text-slate-400">
                    Generate a wallet fleet to see stats, charts, and controls.
                  </div>
                )}
              </CollapsibleCard>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

