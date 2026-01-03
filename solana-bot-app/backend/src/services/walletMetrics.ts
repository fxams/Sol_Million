import { Connection, PublicKey } from "@solana/web3.js";
import type { Cluster } from "../state/store.js";
import { getRpcUrl } from "../utils/env.js";

export type WalletMetrics = {
  owner: string;
  balanceLamports: number;
  balanceSol: number;
  /** Count of most recent signatures fetched (limit=N). */
  txCountRecent: number;
  /** Count of fetched signatures within the last 24h (based on blockTime). */
  txCount24h: number;
  sampledAtMs: number;
};

type CacheEntry = { metrics: WalletMetrics; fetchedAtMs: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(cluster: Cluster, owner: string) {
  return `${cluster}:${owner}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let idx = 0;
  const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function getWalletMetricsBatch(opts: {
  cluster: Cluster;
  owners: string[];
  /** Cache TTL in ms. Default 20s. */
  ttlMs?: number;
  /** How many signatures to fetch per wallet. Default 100. */
  sigLimit?: number;
}): Promise<WalletMetrics[]> {
  const ttlMs = opts.ttlMs ?? 20_000;
  const sigLimit = opts.sigLimit ?? 100;
  const now = Date.now();

  const owners = Array.from(new Set(opts.owners.map((o) => o.trim()).filter(Boolean)));
  if (owners.length === 0) return [];

  const cached: WalletMetrics[] = [];
  const toFetch: string[] = [];
  for (const owner of owners) {
    const k = cacheKey(opts.cluster, owner);
    const c = cache.get(k);
    if (c && now - c.fetchedAtMs < ttlMs) cached.push(c.metrics);
    else toFetch.push(owner);
  }

  if (toFetch.length === 0) return cached.sort((a, b) => owners.indexOf(a.owner) - owners.indexOf(b.owner));

  const connection = new Connection(getRpcUrl(opts.cluster), "processed");
  const pubkeys = toFetch.map((o) => new PublicKey(o));

  // 1) Balances in a single RPC (or few chunks).
  const balancesLamportsByOwner = new Map<string, number>();
  const chunkSize = 100;
  for (let i = 0; i < pubkeys.length; i += chunkSize) {
    const chunk = pubkeys.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const infos = await connection.getMultipleAccountsInfo(chunk, "processed");
    for (let j = 0; j < chunk.length; j++) {
      const pk = chunk[j];
      const info = infos[j];
      balancesLamportsByOwner.set(pk.toBase58(), info?.lamports ?? 0);
    }
  }

  // 2) Tx counts (no batch RPC exists; keep concurrency low).
  const sigCounts = await mapWithConcurrency(
    toFetch,
    4,
    async (owner) => {
      const pk = new PublicKey(owner);
      const sigs = await connection.getSignaturesForAddress(pk, { limit: sigLimit }, "confirmed");
      const cutoff = now - 24 * 60 * 60 * 1000;
      const txCount24h = sigs.filter((s) => (s.blockTime ? s.blockTime * 1000 >= cutoff : false)).length;
      return { owner, txCountRecent: sigs.length, txCount24h };
    }
  );
  const sigByOwner = new Map(sigCounts.map((x) => [x.owner, x]));

  const fresh: WalletMetrics[] = toFetch.map((owner) => {
    const lamports = balancesLamportsByOwner.get(owner) ?? 0;
    const sig = sigByOwner.get(owner);
    const metrics: WalletMetrics = {
      owner,
      balanceLamports: lamports,
      balanceSol: lamports / 1e9,
      txCountRecent: sig?.txCountRecent ?? 0,
      txCount24h: sig?.txCount24h ?? 0,
      sampledAtMs: now
    };
    cache.set(cacheKey(opts.cluster, owner), { metrics, fetchedAtMs: now });
    return metrics;
  });

  const merged = [...cached, ...fresh];
  merged.sort((a, b) => owners.indexOf(a.owner) - owners.indexOf(b.owner));
  return merged;
}

