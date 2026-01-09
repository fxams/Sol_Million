"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps
} from "reactflow";

type VizComponent =
  | "frontend"
  | "backend-api"
  | "state-store"
  | "helius-ws"
  | "solana-rpc"
  | "pumpfun"
  | "raydium"
  | "jupiter"
  | "jito"
  | "pumpportal"
  | "tx-builder"
  | "wallet-metrics"
  | "other";

type VizEvent = {
  id: string;
  ts: number;
  cluster: "mainnet-beta" | "devnet";
  owner: string | null;
  level: "info" | "warn" | "error";
  msg: string;
  kind: "cluster_log" | "session_log";
  component: VizComponent;
};

type NodeId =
  | "wallet"
  | "frontend"
  | "backend"
  | "store"
  | "helius"
  | "solana"
  | "raydium"
  | "pumpfun"
  | "pumpportal"
  | "jupiter"
  | "jito";

const COMPONENT_TO_NODE: Partial<Record<VizComponent, NodeId>> = {
  frontend: "frontend",
  "backend-api": "backend",
  "state-store": "store",
  "helius-ws": "helius",
  "solana-rpc": "solana",
  raydium: "raydium",
  pumpfun: "pumpfun",
  pumpportal: "pumpportal",
  jupiter: "jupiter",
  jito: "jito",
  "tx-builder": "backend",
  "wallet-metrics": "backend"
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function edgeId(a: NodeId, b: NodeId) {
  return `${a}->${b}`;
}

function pulseEdgeFromComponent(c: VizComponent): Array<[NodeId, NodeId]> {
  const n = COMPONENT_TO_NODE[c];
  if (!n) return [];
  // A couple of sensible “flow” routes to make it feel like the tweet-style animation.
  switch (n) {
    case "backend":
      return [
        ["frontend", "backend"],
        ["backend", "store"]
      ];
    case "store":
      return [["backend", "store"]];
    case "helius":
      return [
        ["store", "helius"],
        ["helius", "solana"]
      ];
    case "solana":
      return [["helius", "solana"]];
    case "raydium":
      return [
        ["helius", "raydium"],
        ["backend", "raydium"]
      ];
    case "pumpfun":
      return [
        ["helius", "pumpfun"],
        ["backend", "pumpfun"]
      ];
    case "pumpportal":
      return [["backend", "pumpportal"]];
    case "jupiter":
      return [["backend", "jupiter"]];
    case "jito":
      return [["backend", "jito"]];
    case "frontend":
      return [["wallet", "frontend"]];
    default:
      return [];
  }
}

function GlowNode(props: NodeProps<{ label: string; subtitle?: string; level?: string; activity?: number }>) {
  const a = clamp01(props.data.activity ?? 0);
  const hue = props.data.level === "error" ? 350 : props.data.level === "warn" ? 45 : 195;
  const glow = 8 + a * 22;
  const borderA = 0.25 + a * 0.55;
  const bgA = 0.25 + a * 0.25;
  const shadowA = 0.12 + a * 0.35;
  const scale = 1 + a * 0.04;

  return (
    <div
      className="rounded-xl border px-3 py-2 text-xs text-slate-100 backdrop-blur"
      style={{
        borderColor: `hsla(${hue}, 95%, 72%, ${borderA})`,
        background: `rgba(2, 6, 23, ${bgA})`,
        boxShadow: `0 0 ${glow}px hsla(${hue}, 95%, 65%, ${shadowA}), 0 0 0 1px rgba(148,163,184,0.08) inset`,
        transform: `scale(${scale})`,
        transition: "transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease"
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">{props.data.label}</div>
        <div className="font-mono text-[10px] text-slate-400">{props.id}</div>
      </div>
      {props.data.subtitle ? <div className="mt-0.5 text-[11px] text-slate-400">{props.data.subtitle}</div> : null}
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

function makeBaseNodes(cluster: "mainnet-beta" | "devnet"): Node[] {
  const nodes: Array<Node<{ label: string; subtitle?: string; level?: string; activity?: number }, string>> = [
    { id: "wallet", type: "glow", position: { x: 0, y: 140 }, data: { label: "Wallet", subtitle: "Phantom/Solflare/etc" } },
    { id: "frontend", type: "glow", position: { x: 220, y: 140 }, data: { label: "Frontend (Next.js)", subtitle: "Dashboard UI + polling" } },
    { id: "backend", type: "glow", position: { x: 470, y: 140 }, data: { label: "Backend (Express)", subtitle: "API + orchestration" } },
    { id: "store", type: "glow", position: { x: 720, y: 20 }, data: { label: "State Store", subtitle: "sessions/logs/actions" } },
    { id: "helius", type: "glow", position: { x: 720, y: 260 }, data: { label: "Helius Monitor", subtitle: "WS logs + triggers" } },
    { id: "solana", type: "glow", position: { x: 990, y: 260 }, data: { label: "Solana RPC/WS", subtitle: cluster } },
    { id: "raydium", type: "glow", position: { x: 990, y: 370 }, data: { label: "Raydium", subtitle: "post-migration signals" } },
    { id: "pumpfun", type: "glow", position: { x: 990, y: 150 }, data: { label: "Pump.fun", subtitle: "pre-migration signals" } },
    { id: "pumpportal", type: "glow", position: { x: 990, y: 40 }, data: { label: "PumpPortal", subtitle: "trade-local builder" } },
    { id: "jupiter", type: "glow", position: { x: 990, y: 480 }, data: { label: "Jupiter", subtitle: "quote + swap tx" } },
    { id: "jito", type: "glow", position: { x: 990, y: 590 }, data: { label: "Jito", subtitle: "simulate + send bundle" } }
  ];
  return nodes;
}

function makeEdges(): Edge[] {
  const mk = (a: NodeId, b: NodeId): Edge => ({
    id: edgeId(a, b),
    source: a,
    target: b,
    animated: true,
    style: { stroke: "rgba(56, 189, 248, 0.25)", strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(56, 189, 248, 0.35)" }
  });
  return [
    mk("wallet", "frontend"),
    mk("frontend", "backend"),
    mk("backend", "store"),
    mk("store", "helius"),
    mk("helius", "solana"),
    mk("helius", "pumpfun"),
    mk("helius", "raydium"),
    mk("backend", "pumpportal"),
    mk("backend", "jupiter"),
    mk("backend", "jito"),
    mk("backend", "raydium"),
    mk("backend", "pumpfun")
  ];
}

export function AppFlowViz(props: {
  backendBaseUrl: string;
  cluster: "mainnet-beta" | "devnet";
  owner?: string | null;
  height?: number;
}) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<VizEvent | null>(null);
  const [activity, setActivity] = useState<Record<NodeId, number>>({
    wallet: 0,
    frontend: 0,
    backend: 0,
    store: 0,
    helius: 0,
    solana: 0,
    raydium: 0,
    pumpfun: 0,
    pumpportal: 0,
    jupiter: 0,
    jito: 0
  });
  const [edgeActivity, setEdgeActivity] = useState<Record<string, number>>({});
  const evRef = useRef<EventSource | null>(null);

  const nodesBase = useMemo(() => makeBaseNodes(props.cluster), [props.cluster]);
  const edgesBase = useMemo(() => makeEdges(), []);

  const nodes = useMemo(() => {
    return nodesBase.map((n) => {
      const id = n.id as NodeId;
      const a = activity[id] ?? 0;
      const level = lastEvent?.component && COMPONENT_TO_NODE[lastEvent.component] === id ? lastEvent.level : undefined;
      return { ...n, data: { ...(n.data as any), activity: a, level } };
    });
  }, [activity, lastEvent?.component, lastEvent?.level, nodesBase]);

  const edges = useMemo(() => {
    return edgesBase.map((e) => {
      const a = clamp01(edgeActivity[e.id] ?? 0);
      const w = 2 + a * 3;
      const oa = 0.18 + a * 0.5;
      return {
        ...e,
        style: {
          ...(e.style ?? {}),
          strokeWidth: w,
          stroke: `rgba(56, 189, 248, ${oa})`,
          strokeDasharray: "10 8",
          animation: "rf-dash 1.2s linear infinite"
        }
      };
    });
  }, [edgeActivity, edgesBase]);

  useEffect(() => {
    // smooth decay so “active” motion feels alive.
    const t = setInterval(() => {
      setActivity((prev) => {
        let changed = false;
        const next: any = { ...prev };
        for (const k of Object.keys(prev) as NodeId[]) {
          const v = prev[k];
          const nv = v <= 0.001 ? 0 : v * 0.92;
          if (nv !== v) changed = true;
          next[k] = nv;
        }
        return changed ? next : prev;
      });
      setEdgeActivity((prev) => {
        let changed = false;
        const next: any = { ...prev };
        for (const k of Object.keys(prev)) {
          const v = prev[k];
          const nv = v <= 0.001 ? 0 : v * 0.9;
          if (nv !== v) changed = true;
          next[k] = nv;
        }
        return changed ? next : prev;
      });
    }, 60);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const url = new URL(`${props.backendBaseUrl.replace(/\/$/, "")}/api/viz/stream`);
    url.searchParams.set("cluster", props.cluster);
    if (props.owner) url.searchParams.set("owner", props.owner);

    // Close old connection when owner/cluster changes.
    evRef.current?.close();
    const es = new EventSource(url.toString());
    evRef.current = es;

    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));

    es.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent).data) as VizEvent;
        setLastEvent(e);
        const node = COMPONENT_TO_NODE[e.component] ?? "backend";
        setActivity((prev) => ({ ...prev, [node]: clamp01((prev[node] ?? 0) + 0.35) }));
        // Make the “flow” happen: pulse a couple of edges per event.
        const pulses = pulseEdgeFromComponent(e.component);
        if (pulses.length) {
          setEdgeActivity((prev) => {
            const next: Record<string, number> = { ...prev };
            for (const [a, b] of pulses) {
              const id = edgeId(a, b);
              next[id] = clamp01((next[id] ?? 0) + 0.6);
              // also “energize” endpoints a bit
              setActivity((p) => ({
                ...p,
                [a]: clamp01((p[a] ?? 0) + 0.12),
                [b]: clamp01((p[b] ?? 0) + 0.18)
              }));
            }
            return next;
          });
        }
      } catch {
        // ignore malformed events
      }
    });

    es.addEventListener("ping", () => {
      // subtle heartbeat even when idle
      setEdgeActivity((prev) => ({ ...prev, [edgeId("frontend", "backend")]: clamp01((prev[edgeId("frontend", "backend")] ?? 0) + 0.12) }));
    });

    return () => es.close();
  }, [props.backendBaseUrl, props.cluster, props.owner]);

  const nodeTypes = useMemo(() => ({ glow: GlowNode }), []);
  const h = props.height ?? 420;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-3 py-2">
        <div className="text-xs font-semibold text-slate-200">Real-time app map</div>
        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          <div>
            Stream:{" "}
            <span className={connected ? "text-emerald-300" : "text-rose-300"}>{connected ? "connected" : "disconnected"}</span>
          </div>
          <div className="font-mono">{props.cluster}</div>
          {props.owner ? <div className="max-w-[220px] truncate font-mono">owner={props.owner}</div> : null}
        </div>
      </div>

      <div style={{ height: h }} className="relative">
        <style>{`
          @keyframes rf-dash { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -36; } }
          .react-flow__pane { cursor: default; }
          .react-flow__controls button { background: rgba(2,6,23,0.65); border: 1px solid rgba(30,41,59,0.9); }
          .react-flow__controls button svg { fill: #e2e8f0; }
          .react-flow__attribution { display: none; }
        `}</style>

        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag
            zoomOnScroll={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} color="rgba(148,163,184,0.08)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>

      <div className="border-t border-slate-800 px-3 py-2 text-[11px] text-slate-400">
        {lastEvent ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-slate-500">{new Date(lastEvent.ts).toLocaleTimeString()}</span>
            <span className={lastEvent.level === "error" ? "text-rose-300" : lastEvent.level === "warn" ? "text-amber-300" : "text-slate-200"}>
              {lastEvent.component}
            </span>
            <span className="text-slate-500">—</span>
            <span className="max-w-[980px] truncate">{lastEvent.msg}</span>
          </div>
        ) : (
          <div>Waiting for activity… start monitoring to see the graph light up.</div>
        )}
      </div>
    </div>
  );
}

