import { getJitoUrl } from "../utils/env.js";
import type { Cluster } from "../state/store.js";

type RpcReq = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type RpcRes<T> = { jsonrpc: "2.0"; id: number; result?: T; error?: { code: number; message: string; data?: unknown } };

async function jitoRpc<T>(cluster: Cluster, method: string, params?: unknown): Promise<T> {
  const url = getJitoUrl(cluster);
  const body: RpcReq = { jsonrpc: "2.0", id: Date.now(), method, params };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => null)) as RpcRes<T> | null;
  if (!res.ok) {
    throw new Error(`Jito RPC HTTP ${res.status}: ${JSON.stringify(json?.error ?? json ?? {})}`);
  }
  if (!json) throw new Error("Jito RPC: empty response");
  if (json.error) throw new Error(`Jito RPC error: ${json.error.message}`);
  return json.result as T;
}

/**
 * MEV protection note:
 * Jito bundles are submitted directly to validators (block engine) instead of the public mempool.
 * Validators execute the bundle's transactions atomically/sequentially in-order, which helps
 * prevent common mempool-based front-running for sniper / volume strategies.
 */
export const jito = {
  async getTipAccounts(cluster: Cluster): Promise<string[]> {
    // Jito method: getTipAccounts (no params)
    return await jitoRpc<string[]>(cluster, "getTipAccounts", []);
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

