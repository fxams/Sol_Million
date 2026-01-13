"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { usePumpFunTokenStream } from "./usePumpFunTokenStream";

type Cluster = "mainnet-beta" | "devnet";

function formatAddress(addr: string | null, length = 6) {
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
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatMarketCap(supply: string | undefined, decimals: number | undefined): string {
  if (!supply || !decimals) return "-";
  try {
    const num = BigInt(supply);
    const divisor = BigInt(10 ** (decimals || 0));
    const whole = num / divisor;
    const formatted = whole.toLocaleString();
    if (formatted.length > 6) {
      const millions = Number(whole) / 1_000_000;
      return `$${millions.toFixed(1)}M`;
    }
    if (formatted.length > 3) {
      const thousands = Number(whole) / 1_000;
      return `$${thousands.toFixed(1)}K`;
    }
    return `$${formatted}`;
  } catch {
    return "-";
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

function pumpFunUrl(mint: string) {
  return `https://pump.fun/${mint}`;
}

function TokenCard({ token, cluster, isNew }: { token: any; cluster: Cluster; isNew: boolean }) {
  const displayName = token.name || formatAddress(token.mint, 4);
  const displaySymbol = token.symbol || "N/A";
  const imageUrl = token.imageUri || `https://api.dicebear.com/7.x/shapes/svg?seed=${token.mint}`;

  return (
    <div
      className={clsx(
        "group relative overflow-hidden rounded-xl border transition-all",
        isNew
          ? "border-emerald-500/30 bg-emerald-500/5 shadow-lg shadow-emerald-500/10"
          : "border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/60"
      )}
    >
      {/* Image */}
      <div className="relative aspect-square w-full overflow-hidden bg-slate-950">
        <img
          src={imageUrl}
          alt={displayName}
          className="h-full w-full object-cover"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.src = `https://api.dicebear.com/7.x/shapes/svg?seed=${token.mint}`;
          }}
        />
        {isNew && (
          <div className="absolute bottom-2 left-2 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-semibold text-white">
            LIVE
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-3">
        <div className="mb-1">
          <h3 className="text-sm font-semibold text-slate-100 line-clamp-1">{displayName}</h3>
          <p className="text-xs text-slate-400">{displaySymbol}</p>
        </div>

        <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
          <span>{formatTimeAgo(token.timestamp)}</span>
          <span className="font-mono">by {formatAddress(token.deployer, 4)}</span>
        </div>

        <div className="mb-2">
          <div className="text-xs font-semibold text-slate-300">
            MC: {formatMarketCap(token.supply, token.decimals)}
          </div>
        </div>

        {token.description && (
          <p className="mb-2 line-clamp-2 text-xs text-slate-400">{token.description}</p>
        )}

        {/* Links */}
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={pumpFunUrl(token.mint)}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200 hover:bg-slate-700 transition"
          >
            Pump.fun
          </a>
          <a
            href={explorerMintUrl(token.mint, cluster)}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200 hover:bg-slate-700 transition"
          >
            Explorer
          </a>
          {token.website && (
            <a
              href={token.website.startsWith("http") ? token.website : `https://${token.website}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200 hover:bg-slate-700 transition"
            >
              Website
            </a>
          )}
          {token.twitter && (
            <a
              href={
                token.twitter.startsWith("http")
                  ? token.twitter
                  : token.twitter.startsWith("@")
                    ? `https://twitter.com/${token.twitter.slice(1)}`
                    : `https://twitter.com/${token.twitter}`
              }
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200 hover:bg-slate-700 transition"
            >
              Twitter
            </a>
          )}
        </div>
      </div>
    </div>
  );
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
          t.name?.toLowerCase().includes(query) ||
          t.symbol?.toLowerCase().includes(query) ||
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
          placeholder="Search by name, symbol, mint, or deployer..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 min-w-[200px] rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500"
        />
      </div>

      {/* Token Cards Grid */}
      {filteredTokens.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-12 text-center text-sm text-slate-500">
          {tokens.length === 0
            ? connected
              ? "Waiting for new token deployments..."
              : "Connecting to token stream..."
            : "No tokens match your filters."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filteredTokens.map((token, idx) => {
            const isNew = idx === 0 && filter === "recent" && Date.now() - token.timestamp < 60_000;
            return <TokenCard key={`${token.signature}-${idx}`} token={token} cluster={props.cluster} isNew={isNew} />;
          })}
        </div>
      )}

      {filteredTokens.length > 0 && (
        <div className="text-xs text-slate-400">
          Showing {filteredTokens.length} of {tokens.length} tokens. New tokens appear at the top.
        </div>
      )}
    </div>
  );
}
