"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import clsx from "clsx";
import { Buffer } from "buffer";

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

function getBackendBaseUrl() {
  return (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8787").replace(/\/$/, "");
}

function explorerSigUrl(sig: string, cluster: string) {
  const c = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${sig}${c}`;
}

function jitoBundleUrl(bundleId: string) {
  // Jito explorer works for mainnet bundles (bundle ID).
  return `https://explorer.jito.wtf/bundle/${bundleId}`;
}

export function Dashboard() {
  const { connection } = useConnection();
  const wallet = useWallet();

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
  const [autoAllowToken2022, setAutoAllowToken2022] = useState(false);
  const [mevEnabled, setMevEnabled] = useState(true);
  const [buyAmountSol, setBuyAmountSol] = useState("0.1");
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

  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const backendBaseUrl = useMemo(() => getBackendBaseUrl(), []);

  const displayLogs = useMemo(() => {
    const merged = [...(clusterLogs ?? []), ...(sessionLogs ?? [])];
    merged.sort((a, b) => a.ts - b.ts);
    return merged;
  }, [clusterLogs, sessionLogs]);

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

  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        await fetchStatus();
      } catch (e) {
        // don't spam toasts; just keep last known UI.
      }
      t = setInterval(() => {
        fetchStatus().catch(() => {});
      }, 1500);
    })();
    return () => {
      if (t) clearInterval(t);
    };
  }, [fetchStatus]);

  useEffect(() => {
    // Auto-scroll logs to bottom
    const el = logBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [displayLogs]);

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

  const signAndSubmitPendingBundle = useCallback(async () => {
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
      if (cluster === "devnet" && mevEnabled) {
        toast.error("Jito bundles are mainnet-only; disable MEV on devnet.");
        return;
      }

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

      toast.success("Bundle submitted to Jito");
      await fetchStatus();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to sign/submit");
    } finally {
      setLoading(false);
    }
  }, [backendBaseUrl, cluster, fetchStatus, mevEnabled, pendingAction, wallet]);

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
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-2xl font-semibold tracking-tight">Solana Bot App</div>
            <div className="text-sm text-slate-300">
              Client-signed trades + optional MEV protection via Jito bundles
            </div>
          </div>
          <div className="flex items-center gap-3">
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

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">Bot configuration</div>
              <div
                className={clsx(
                  "rounded-full px-3 py-1 text-xs font-medium",
                  running ? "bg-emerald-900/40 text-emerald-200" : "bg-slate-800 text-slate-200"
                )}
              >
                {running ? "RUNNING" : "STOPPED"}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                    <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-200 sm:col-span-2">
                      <div className="font-semibold text-slate-100">Auto-snipe filters (recommended defaults)</div>
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
                        <span className="text-slate-200">Allow Token-2022 mints (riskier)</span>
                        <input
                          type="checkbox"
                          checked={autoAllowToken2022}
                          onChange={(e) => setAutoAllowToken2022(e.target.checked)}
                          disabled={loading}
                        />
                      </label>
                      <div className="mt-2 text-slate-400">
                        Auto mode only triggers when a mint passes safety checks (mint+freeze authority disabled,
                        holder concentration caps) and shows enough early momentum.
                      </div>
                    </div>
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

            <div className="mt-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Optional snipe list (token mints)</span>
                <textarea
                  className="min-h-[110px] rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs"
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

            <div className="mt-5 flex flex-wrap gap-2">
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
                disabled={loading || !pendingAction || !mevEnabled}
                onClick={signAndSubmitPendingBundle}
                title={!mevEnabled ? "Enable MEV to bundle via Jito" : ""}
              >
                Sign & submit pending bundle
              </button>
            </div>

            {pendingAction && (
              <div className="mt-4 rounded-lg border border-amber-800/60 bg-amber-900/10 p-3 text-sm">
                <div className="font-semibold text-amber-200">Pending action</div>
                <div className="mt-1 text-amber-100/90">{pendingAction.reason}</div>
                <div className="mt-2 text-xs text-amber-100/70">
                  Your wallet will sign all transactions locally, then the backend will simulate +
                  submit the bundle to Jito for atomic execution (MEV protection).
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="text-sm font-semibold text-slate-200">Backend wallet sessions</div>
              <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950">
                <div className="max-h-[160px] overflow-auto">
                  {(sessions ?? []).length === 0 ? (
                    <div className="px-3 py-3 text-xs text-slate-500">No active sessions.</div>
                  ) : (
                    <table className="min-w-full text-left text-xs">
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
                  )}
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-400">
                To run sniper + volume with different wallets, open this app in two browser profiles and connect a
                different wallet in each.
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">Live logs</div>
              <button
                className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200 disabled:opacity-60"
                onClick={copyLogs}
                disabled={loading}
                type="button"
              >
                Copy logs
              </button>
            </div>
            <div
              ref={logBoxRef}
              className="mt-3 h-[340px] overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed"
            >
              {displayLogs.length === 0 ? (
                <div className="text-slate-500">No logs yet.</div>
              ) : (
                displayLogs.map((l, idx) => (
                  <div key={`${l.ts}-${idx}`} className="whitespace-pre-wrap">
                    <span className="text-slate-500">
                      {new Date(l.ts).toLocaleTimeString()}{" "}
                    </span>
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
            <div className="mt-2 text-xs text-slate-400">
              Tip: Keep this tab open so you can promptly sign when a qualifying pool is detected.
            </div>
          </section>
        </div>

        <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">Bundle / transaction history</div>
            <button
              className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200"
              onClick={() => fetchStatus().catch(() => {})}
              disabled={loading}
            >
              Refresh
            </button>
          </div>

          <div className="mt-3 overflow-auto rounded-lg border border-slate-800">
            <table className="min-w-full text-left text-sm">
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
        </section>
      </div>
    </main>
  );
}

