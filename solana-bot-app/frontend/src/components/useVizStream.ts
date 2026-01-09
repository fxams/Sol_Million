"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type VizComponent =
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

export type VizEvent = {
  id: string;
  ts: number;
  cluster: "mainnet-beta" | "devnet";
  owner: string | null;
  level: "info" | "warn" | "error";
  msg: string;
  kind: "cluster_log" | "session_log";
  component: VizComponent;
};

export function useVizStream(opts: {
  backendBaseUrl: string;
  cluster: "mainnet-beta" | "devnet";
  owner?: string | null;
  maxEvents?: number;
}) {
  const maxEvents = Math.max(50, Math.min(1000, opts.maxEvents ?? 400));
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<VizEvent | null>(null);
  const [events, setEvents] = useState<VizEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const url = useMemo(() => {
    const u = new URL(`${opts.backendBaseUrl.replace(/\/$/, "")}/api/viz/stream`);
    u.searchParams.set("cluster", opts.cluster);
    if (opts.owner) u.searchParams.set("owner", opts.owner);
    return u.toString();
  }, [opts.backendBaseUrl, opts.cluster, opts.owner]);

  useEffect(() => {
    esRef.current?.close();
    setConnected(false);
    setLastEvent(null);
    setEvents([]);

    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));

    es.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent).data) as VizEvent;
        setLastEvent(e);
        setEvents((prev) => {
          const next = [...prev, e];
          return next.length > maxEvents ? next.slice(next.length - maxEvents) : next;
        });
      } catch {
        // ignore
      }
    });

    return () => es.close();
  }, [url, maxEvents]);

  return { connected, lastEvent, events };
}

