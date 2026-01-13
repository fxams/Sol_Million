"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { usePumpFunTokenStream } from "./usePumpFunTokenStream";

type Cluster = "mainnet-beta" | "devnet";

function formatAddress(addr: string | null, length = 8) {
  if (!addr) return "-";
  if (addr.length <= length * 2) return addr;
  return `${addr.slice(0, length)}...${addr.slice(-length)}`;
}

function formatTimeAgo(timestamp: number) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSupply(supply: string | undefined, decimals: number | undefined) {
  if (!supply || !decimals) return "-";
  try {
    const num = BigInt(supply);
    const divisor = BigInt(10 ** (decimals || 0));
    const whole = num / divisor;
    const remainder = num % divisor;
    if (remainder === 0n) {
      return whole.toString();
    }
    const decimalsStr = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return decimalsStr ? `${whole}.${decimalsStr}` : whole.toString();
  } catch {
    return supply;
  }
}

function explorerMintUrl(mint: string, cluster: string) {
  const c = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/address/${mint}${c}`;
}

function explorerTxUrl(signature: string, cluster: string) {
  const c = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${c}`;
}

export function PumpFunTokenMonitor(props: { backendBaseUrl: string; cluster: Cluster }) {
  const { connected, tokens } = usePumpFunTokenStream({
    backendBaseUrl: props.backendBaseUrl,
    cluster: props.cluster,
    maxTokens: 200
  });

  const [filter, setFilter] = useState<"all" | "recent">("recent");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredTokens = useMemo(() => {
    let filtered = tokens;
    
    // Filter by time
    if (filter === "recent") {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      filtered = filtered.filter((t) => t.timestamp >= fiveMinutesAgo);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.mint.toLowerCase().includes(query) ||
          t.deployer?.toLowerCase().includes(query) ||
          t.signature.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [tokens, filter, searchQuery]);

  const stats = useMemo(() => {
    const now = Date.now();
    const lastMinute = tokens.filter((t) => t.timestamp >= now - 60_000).length;
    const last5Minutes = tokens.filter((t) => t.timestamp >= now - 5 * 60_000).length;
    const lastHour = tokens.filter((t) => t.timestamp >= now - 60 * 60_000).length;
    return { lastMinute, last5Minutes, lastHour, total: tokens.length };
  }, [tokens]);

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
          <div className="text-[11px] text-slate-400">Last minute</div>
          <div className="mt-0.5 text-sm font-semibold text-slate-100">{stats.lastMinute}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
          <div className="text-[11px] text-slate-400">Last 5 min</div>
          <div className="mt-0.5 text-sm font-semibold text-slate-100">{stats.last5Minutes}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
          <div className="text-[11px] text-slate-400">Last hour</div>
          <div className="mt-0.5 text-sm font-semibold text-slate-100">{stats.lastHour}</div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
          <div className="text-[11px] text-slate-400">Total tracked</div>
          <div className="mt-0.5 text-sm font-semibold text-slate-100">{stats.total}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <div className={clsx("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-rose-400")} />
            <span className="text-[10px] text-slate-400">{connected ? "Live" : "Offline"}</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-slate-800 bg-slate-950 p-1">
          <button
            type="button"
            onClick={() => setFilter("recent")}
            className={clsx(
              "rounded-md px-3 py-1.5 text-xs font-semibold transition",
              filter === "recent"
                ? "bg-slate-100 text-slate-900"
                : "text-slate-200 hover:bg-slate-800/60"
            )}
          >
            Recent (5m)
          </button>
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={clsx(
              "rounded-md px-3 py-1.5 text-xs font-semibold transition",
              filter === "all"
                ? "bg-slate-100 text-slate-900"
                : "text-slate-200 hover:bg-slate-800/60"
            )}
          >
            All
          </button>
        </div>
        <input
          type="text"
          placeholder="Search by mint, deployer, or signature..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 min-w-[200px] rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500"
        />
      </div>

      {/* Token List */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/40">
        <div className="max-h-[600px] overflow-auto">
          {filteredTokens.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-500">
              {tokens.length === 0
                ? connected
                  ? "Waiting for new token deployments..."
                  : "Connecting to token stream..."
                : "No tokens match your filters."}
            </div>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-300">Time</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-300">Mint</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-300">Deployer</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-300">Supply</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-300">Decimals</th>
                  <th className="px-4 py-3 text-xs font-semibold text-slate-300">Links</th>
                </tr>
              </thead>
              <tbody>
                {filteredTokens.map((token, idx) => (
                  <tr
                    key={`${token.signature}-${idx}`}
                    className={clsx(
                      "border-b border-slate-900 transition-colors",
                      idx === 0 && filter === "recent" ? "bg-emerald-500/5" : "hover:bg-slate-900/40"
                    )}
                  >
                    <td className="px-4 py-3 text-xs text-slate-400">{formatTimeAgo(token.timestamp)}</td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-slate-200">{formatAddress(token.mint, 6)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-slate-300">{formatAddress(token.deployer, 6)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300">
                      {formatSupply(token.supply, token.decimals)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{token.decimals ?? "-"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <a
                          href={explorerMintUrl(token.mint, props.cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-300 hover:text-sky-200 hover:underline text-xs"
                        >
                          Mint
                        </a>
                        <a
                          href={explorerTxUrl(token.signature, props.cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sky-300 hover:text-sky-200 hover:underline text-xs"
                        >
                          Tx
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {filteredTokens.length > 0 && (
        <div className="text-xs text-slate-400">
          Showing {filteredTokens.length} of {tokens.length} tokens. New tokens appear at the top.
        </div>
      )}
    </div>
  );
}
