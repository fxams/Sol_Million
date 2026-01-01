import { getJitoUrl } from "../utils/env.js";
import type { Cluster } from "../state/store.js";

type RpcReq = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type RpcRes<T> = { jsonrpc: "2.0"; id: number; result?: T; error?: { code: number; message: string; data?: unknown } };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function jitoRpc<T>(cluster: Cluster, method: string, params?: unknown): Promise<T> {
  const url = getJitoUrl(cluster);
  const body: RpcReq = { jsonrpc: "2.0", id: Date.now(), method, params };

  const maxAttempts = 3;
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      const ct = res.headers.get("content-type")?.toLowerCase() ?? "";
      const json = ct.includes("application/json") ? ((await res.json().catch(() => null)) as RpcRes<T> | null) : null;

      if (!res.ok) {
        // Handle global rate limits more gracefully.
        if (res.status === 429 && attempt < maxAttempts) {
          const base = 400 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 200);
          await sleep(base + jitter);
          continue;
        }
        const txt = !json ? await res.text().catch(() => "") : "";
        throw new Error(`Jito RPC HTTP ${res.status}: ${JSON.stringify(json?.error ?? json ?? txt ?? {})}`);
      }
      if (!json) throw new Error("Jito RPC: empty response");
      if (json.error) throw new Error(`Jito RPC error: ${json.error.message}`);
      return json.result as T;
    } catch (e: any) {
      lastErr = e;
      // If it's a rate-limit shaped error and we have retries left, we already waited above.
      if (attempt < maxAttempts) continue;
      throw lastErr;
    }
  }

  // Should never reach here.
  throw lastErr ?? new Error("Jito RPC failed");
}

/**
 * MEV protection note:
 * Jito bundles are submitted directly to validators (block engine) instead of the public mempool.
 * Validators execute the bundle's transactions atomically/sequentially in-order, which helps
 * prevent common mempool-based front-running for sniper / volume strategies.
 */
export const jito = {
  async getTipAccounts(cluster: Cluster): Promise<string[]> {
    const cached = tipAccountsCache.get(cluster);
    const now = Date.now();
    // Refresh periodically; tip accounts change rarely, and caching avoids Jito RPC rate limits.
    if (cached && now - cached.fetchedAtMs < 30 * 60_000) return cached.accounts;

    try {
      const accounts = await jitoRpc<string[]>(cluster, "getTipAccounts", []);
      tipAccountsCache.set(cluster, { accounts, fetchedAtMs: now });
      return accounts;
    } catch (e) {
      // If we have any cached value, prefer it over failing to build bundles.
      if (cached?.accounts?.length) return cached.accounts;
      throw e;
    }
  },

  async simulateBundle(cluster: Cluster, encodedTransactionsBase58: string[]) {
    // Jito method: simulateBundle
    // Common param shape: [{ encodedTransactions: [...] }]
    return await jitoRpc<any>(cluster, "simulateBundle", [
      {
        encodedTransactions: encodedTransactionsBase58
      }
    ]);
  },

  async sendBundle(cluster: Cluster, encodedTransactionsBase58: string[]) {
    // Jito method: sendBundle
    // Common param shape: [ [tx1, tx2, ...] ]
    return await jitoRpc<any>(cluster, "sendBundle", [encodedTransactionsBase58]);
  },

  async getBundleStatuses(cluster: Cluster, bundleIds: string[]) {
    // Jito method: getBundleStatuses
    return await jitoRpc<any>(cluster, "getBundleStatuses", [bundleIds]);
  }
};

const tipAccountsCache = new Map<Cluster, { accounts: string[]; fetchedAtMs: number }>();

