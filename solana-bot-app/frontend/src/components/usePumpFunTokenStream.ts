"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  imageUri?: string;
  website?: string;
  twitter?: string;
  description?: string;
};

export function usePumpFunTokenStream(opts: {
  backendBaseUrl: string;
  cluster: "mainnet-beta" | "devnet";
  maxTokens?: number;
}) {
  const maxTokens = Math.max(50, Math.min(1000, opts.maxTokens ?? 200));
  const [connected, setConnected] = useState(false);
  const [tokens, setTokens] = useState<PumpFunTokenInfo[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const url = useMemo(() => {
    const u = new URL(`${opts.backendBaseUrl.replace(/\/$/, "")}/api/pumpfun-tokens/stream`);
    u.searchParams.set("cluster", opts.cluster);
    return u.toString();
  }, [opts.backendBaseUrl, opts.cluster]);

  useEffect(() => {
    esRef.current?.close();
    setConnected(false);
    setTokens([]);

    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("open", () => {
      setConnected(true);
    });
    
    es.addEventListener("error", (e) => {
      setConnected(false);
      // Log error for debugging
      console.warn("Token stream error:", e);
    });

    es.addEventListener("message", (ev) => {
      try {
        const token = JSON.parse((ev as MessageEvent).data) as PumpFunTokenInfo;
        setTokens((prev) => {
          // Avoid duplicates
          if (prev.some((t) => t.mint === token.mint || t.signature === token.signature)) {
            return prev;
          }
          const next = [token, ...prev];
          return next.length > maxTokens ? next.slice(0, maxTokens) : next;
        });
      } catch {
        // ignore
      }
    });

    return () => es.close();
  }, [url, maxTokens]);

  return { connected, tokens };
}
