"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useVizStream, type VizEvent, type VizComponent } from "./useVizStream";

type Cluster = "mainnet-beta" | "devnet";

type SeriesPoint = { ts: number; value: number };

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function Sparkline(props: { points: SeriesPoint[]; height?: number; width?: number; color?: string }) {
  const h = props.height ?? 44;
  const w = props.width ?? 220;
  const pts = props.points.slice(-60);
  if (pts.length < 2) {
    return <div style={{ height: h, width: w }} className="rounded-md border border-slate-800 bg-slate-950" />;
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
  const stroke = props.color ?? "rgb(56 189 248)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="rounded-md border border-slate-800 bg-slate-950">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.8" />
    </svg>
  );
}

function MetricCard(props: {
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  accent?: "sky" | "emerald" | "amber" | "rose" | "violet";
  children?: React.ReactNode;
}) {
  const accent =
    props.accent === "emerald"
      ? "from-emerald-500/20 to-emerald-500/0"
      : props.accent === "amber"
        ? "from-amber-500/20 to-amber-500/0"
        : props.accent === "rose"
          ? "from-rose-500/20 to-rose-500/0"
          : props.accent === "violet"
            ? "from-violet-500/20 to-violet-500/0"
            : "from-sky-500/20 to-sky-500/0";

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className={clsx("pointer-events-none absolute inset-0 bg-gradient-to-br opacity-70", accent)} />
      <div className="relative">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold tracking-wide text-slate-300">{props.title}</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{props.value}</div>
            {props.sub ? <div className="mt-0.5 text-[11px] text-slate-400">{props.sub}</div> : null}
          </div>
          {props.right ? <div className="shrink-0">{props.right}</div> : null}
        </div>
        {props.children ? <div className="mt-3">{props.children}</div> : null}
      </div>
    </div>
  );
}

function Donut(props: { segments: { label: string; value: number; color: string }[]; size?: number }) {
  const size = props.size ?? 96;
  const r = (size / 2) * 0.78;
  const c = 2 * Math.PI * r;
  const total = Math.max(1e-9, props.segments.reduce((a, s) => a + s.value, 0));
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="drop-shadow-[0_0_18px_rgba(56,189,248,0.12)]">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(148,163,184,0.14)" strokeWidth={10} />
      {props.segments.map((s) => {
        const frac = s.value / total;
        const len = c * frac;
        const seg = (
          <circle
            key={s.label}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-offset}
            style={{ transition: "stroke-dasharray 200ms ease, stroke-dashoffset 200ms ease" }}
          />
        );
        offset += len;
        return seg;
      })}
    </svg>
  );
}

function componentLabel(c: VizComponent) {
  switch (c) {
    case "backend-api":
      return "Backend";
    case "state-store":
      return "State";
    case "helius-ws":
      return "Helius WS";
    case "solana-rpc":
      return "Solana RPC";
    case "pumpfun":
      return "Pump.fun";
    case "raydium":
      return "Raydium";
    case "pumpportal":
      return "PumpPortal";
    case "jupiter":
      return "Jupiter";
    case "jito":
      return "Jito";
    case "wallet-metrics":
      return "Wallet metrics";
    case "tx-builder":
      return "Tx builder";
    case "frontend":
      return "Frontend";
    default:
      return "Other";
  }
}

function severityScore(e: VizEvent) {
  return e.level === "error" ? 3 : e.level === "warn" ? 1.6 : 1;
}

function ClusterRiskMiniMap(props: { hot: Record<string, number> }) {
  // fixed little “cluster” network (screenshot-esque)
  const nodes = [
    { k: "Backend", x: 52, y: 54 },
    { k: "State", x: 118, y: 32 },
    { k: "Helius WS", x: 162, y: 78 },
    { k: "Solana RPC", x: 212, y: 42 },
    { k: "Jito", x: 226, y: 112 },
    { k: "Jupiter", x: 178, y: 132 },
    { k: "Pump.fun", x: 120, y: 120 },
    { k: "Raydium", x: 86, y: 104 }
  ];
  const edges: Array<[string, string]> = [
    ["Backend", "State"],
    ["Backend", "Helius WS"],
    ["Helius WS", "Solana RPC"],
    ["Backend", "Jito"],
    ["Backend", "Jupiter"],
    ["Helius WS", "Pump.fun"],
    ["Helius WS", "Raydium"]
  ];
  const max = Math.max(1e-9, ...Object.values(props.hot));

  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <style>{`
        @keyframes glowPulse { 0% { opacity: 0.55 } 50% { opacity: 1 } 100% { opacity: 0.55 } }
        @keyframes drift { 0% { transform: translateY(0px) } 50% { transform: translateY(-1.5px) } 100% { transform: translateY(0px) } }
      `}</style>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold tracking-wide text-slate-300">Cluster risk</div>
        <div className="text-[11px] text-slate-400">live heat</div>
      </div>
      <div className="mt-3">
        <svg width={260} height={160} viewBox="0 0 260 160" className="block">
          {/* edges */}
          {edges.map(([a, b]) => {
            const na = nodes.find((n) => n.k === a)!;
            const nb = nodes.find((n) => n.k === b)!;
            const ha = (props.hot[a] ?? 0) / max;
            const hb = (props.hot[b] ?? 0) / max;
            const h = clamp01((ha + hb) / 2);
            const stroke = `rgba(56, 189, 248, ${0.12 + h * 0.45})`;
            const w = 1 + h * 2.5;
            return <line key={`${a}-${b}`} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke={stroke} strokeWidth={w} />;
          })}

          {/* nodes */}
          {nodes.map((n, idx) => {
            const h = clamp01((props.hot[n.k] ?? 0) / max);
            const r = 6 + h * 10;
            const col = h > 0.65 ? "rgba(244, 63, 94, 0.9)" : h > 0.35 ? "rgba(245, 158, 11, 0.9)" : "rgba(56, 189, 248, 0.9)";
            const glow = h > 0.05 ? `drop-shadow(0 0 ${10 + h * 18}px ${col})` : "none";
            return (
              <g key={n.k} style={{ filter: glow, animation: `drift ${2.2 + idx * 0.12}s ease-in-out infinite` }}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill={col}
                  opacity={0.12 + h * 0.45}
                  style={{ animation: `glowPulse ${1.4 + idx * 0.08}s ease-in-out infinite` }}
                />
                <circle cx={n.x} cy={n.y} r={Math.max(4, r * 0.46)} fill="rgba(2,6,23,0.85)" stroke={col} strokeWidth={1.5} />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-2 text-[11px] text-slate-400">Bigger + warmer nodes mean more warnings/errors recently.</div>
    </div>
  );
}

export function InsightsDashboard(props: {
  backendBaseUrl: string;
  cluster: Cluster;
  owner?: string | null;
  buyAmountSol: number;
  mevEnabled: boolean;
  running: boolean;
  pendingAction: boolean;
  sessionsCount: number;
}) {
  const { connected, events, lastEvent } = useVizStream({
    backendBaseUrl: props.backendBaseUrl,
    cluster: props.cluster,
    owner: props.owner ?? null,
    maxEvents: 650
  });

  const [eventSeries, setEventSeries] = useState<SeriesPoint[]>([]);
  const [errorSeries, setErrorSeries] = useState<SeriesPoint[]>([]);

  useEffect(() => {
    // sample “events/sec” over time to keep it very active even when you’re not interacting
    const t = setInterval(() => {
      const now = Date.now();
      const last2s = events.filter((e) => e.ts >= now - 2000);
      const rate = last2s.length / 2;
      const errRate = last2s.filter((e) => e.level === "error").length / 2;
      setEventSeries((prev) => [...prev.slice(-59), { ts: now, value: rate }]);
      setErrorSeries((prev) => [...prev.slice(-59), { ts: now, value: errRate }]);
    }, 900);
    return () => clearInterval(t);
  }, [events]);

  const window60s = useMemo(() => {
    const now = Date.now();
    return events.filter((e) => e.ts >= now - 60_000);
  }, [events]);

  const byComponent = useMemo(() => {
    const map = new Map<VizComponent, { count: number; score: number; err: number; warn: number }>();
    for (const e of window60s) {
      const cur = map.get(e.component) ?? { count: 0, score: 0, err: 0, warn: 0 };
      cur.count += 1;
      cur.score += severityScore(e);
      if (e.level === "error") cur.err += 1;
      if (e.level === "warn") cur.warn += 1;
      map.set(e.component, cur);
    }
    const arr = Array.from(map.entries()).map(([k, v]) => ({ component: k, ...v }));
    arr.sort((a, b) => b.score - a.score);
    return arr;
  }, [window60s]);

  const total60 = window60s.length;
  const err60 = window60s.filter((e) => e.level === "error").length;
  const warn60 = window60s.filter((e) => e.level === "warn").length;

  const donutSegs = useMemo(() => {
    const top = byComponent.slice(0, 5);
    const palette = ["rgba(56,189,248,0.9)", "rgba(167,139,250,0.9)", "rgba(52,211,153,0.9)", "rgba(245,158,11,0.9)", "rgba(244,63,94,0.9)"];
    return top.map((x, i) => ({
      label: componentLabel(x.component),
      value: x.count,
      color: palette[i % palette.length]
    }));
  }, [byComponent]);

  const hot = useMemo(() => {
    // drive mini-map off warnings/errors weight
    const m: Record<string, number> = {};
    const add = (k: string, v: number) => (m[k] = (m[k] ?? 0) + v);
    for (const c of byComponent) {
      const label = componentLabel(c.component);
      add(label, c.err * 3 + c.warn * 1.5 + Math.max(0, c.count - c.err - c.warn) * 0.5);
    }
    // also map some labels we use in the mini map
    add("Backend", (m["Backend"] ?? 0) + (m["State"] ?? 0) * 0.2);
    return m;
  }, [byComponent]);

  const activityScore = useMemo(() => {
    // simple “active” score to mimic the screenshot's vibe
    const base = total60 / 60; // events/sec
    const penalty = err60 * 0.12 + warn60 * 0.06;
    return Math.max(0, base - penalty);
  }, [err60, total60, warn60]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Activity (events/sec)"
          value={activityScore.toFixed(2)}
          sub={
            <span className="font-mono">
              60s: {total60} • err {err60} • warn {warn60}
            </span>
          }
          accent={err60 > 0 ? "rose" : warn60 > 0 ? "amber" : "sky"}
          right={<div className={clsx("text-[11px] font-semibold", connected ? "text-emerald-300" : "text-rose-300")}>{connected ? "LIVE" : "OFFLINE"}</div>}
        >
          <Sparkline points={eventSeries} color="rgb(56 189 248)" />
        </MetricCard>

        <MetricCard
          title="Error rate (events/sec)"
          value={errorSeries.length ? errorSeries[errorSeries.length - 1].value.toFixed(2) : "0.00"}
          sub="sampled every ~0.9s"
          accent="rose"
        >
          <Sparkline points={errorSeries} color="rgb(244 63 94)" />
        </MetricCard>

        <MetricCard
          title="Trade size (configured)"
          value={`${props.buyAmountSol.toFixed(3)} SOL`}
          sub={`MEV: ${props.mevEnabled ? "on (Jito)" : "off"} • Cluster: ${props.cluster}`}
          accent={props.mevEnabled ? "violet" : "sky"}
        >
          <div className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-[11px] text-slate-300">
            <span>Bot</span>
            <span className={props.running ? "text-emerald-300" : "text-slate-400"}>{props.running ? "running" : "stopped"}</span>
          </div>
          <div className="mt-2 flex items-center justify-between rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-[11px] text-slate-300">
            <span>Pending action</span>
            <span className={props.pendingAction ? "text-amber-300" : "text-slate-400"}>{props.pendingAction ? "yes" : "no"}</span>
          </div>
        </MetricCard>

        <MetricCard title="Sessions" value={props.sessionsCount} sub="backend wallet sessions" accent="emerald">
          <div className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-[11px] text-slate-300">
            <span>Last event</span>
            <span className="font-mono text-slate-400">{lastEvent ? new Date(lastEvent.ts).toLocaleTimeString() : "-"}</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            {lastEvent ? (
              <span className="truncate">
                <span className={lastEvent.level === "error" ? "text-rose-300" : lastEvent.level === "warn" ? "text-amber-300" : "text-slate-200"}>
                  {componentLabel(lastEvent.component)}
                </span>{" "}
                — {lastEvent.msg}
              </span>
            ) : (
              "Waiting for activity…"
            )}
          </div>
        </MetricCard>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold tracking-wide text-slate-300">Service heat (last 60s)</div>
            <div className="text-[11px] text-slate-400">weighted by warn/error</div>
          </div>
          <div className="mt-3 space-y-2">
            {byComponent.length === 0 ? (
              <div className="rounded-md border border-slate-800 bg-slate-950 px-3 py-3 text-xs text-slate-500">
                No recent events yet. Start monitoring to populate this tab.
              </div>
            ) : (
              byComponent.slice(0, 10).map((c) => {
                const max = Math.max(1e-9, byComponent[0]?.score ?? 1);
                const p = clamp01(c.score / max);
                const tone =
                  c.err > 0 ? "from-rose-500/45 to-rose-500/0" : c.warn > 0 ? "from-amber-500/45 to-amber-500/0" : "from-sky-500/40 to-sky-500/0";
                return (
                  <div key={c.component} className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold text-slate-200">{componentLabel(c.component)}</div>
                      <div className="flex items-center gap-3 text-[11px] text-slate-400">
                        <span className="font-mono">{c.count} ev</span>
                        <span className={c.err ? "text-rose-300" : "text-slate-500"}>err {c.err}</span>
                        <span className={c.warn ? "text-amber-300" : "text-slate-500"}>warn {c.warn}</span>
                      </div>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-900">
                      <div
                        className={clsx("h-full bg-gradient-to-r", tone)}
                        style={{
                          width: `${Math.max(6, Math.floor(p * 100))}%`,
                          transition: "width 220ms ease"
                        }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold tracking-wide text-slate-300">Activity split</div>
              <div className="text-[11px] text-slate-400">top services</div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <Donut segments={donutSegs} size={96} />
              <div className="min-w-0 flex-1 space-y-1">
                {donutSegs.length === 0 ? (
                  <div className="text-xs text-slate-500">No data yet.</div>
                ) : (
                  donutSegs.map((s) => (
                    <div key={s.label} className="flex items-center justify-between gap-2 text-[11px]">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                        <span className="truncate text-slate-200">{s.label}</span>
                      </div>
                      <span className="font-mono text-slate-400">{s.value}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="mt-2 text-[11px] text-slate-400">Updates continuously from the viz stream.</div>
          </div>

          <ClusterRiskMiniMap hot={hot} />
        </div>
      </div>
    </div>
  );
}

