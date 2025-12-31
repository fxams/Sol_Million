import "dotenv/config";
import { clusterApiUrl } from "@solana/web3.js";
import type { Cluster } from "../state/store.js";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
  defaultCluster: (process.env.CLUSTER ?? "mainnet-beta") as Cluster,
  jitoBlockEngineUrl: optional("JITO_BLOCK_ENGINE_URL") ?? "https://mainnet.block-engine.jito.wtf",
  heliusRpcUrl: optional("HELIUS_RPC_URL"),
  heliusWsUrl: optional("HELIUS_WS_URL"),
  heliusRpcUrlDevnet: optional("HELIUS_RPC_URL_DEVNET"),
  heliusWsUrlDevnet: optional("HELIUS_WS_URL_DEVNET")
};

export function getRpcUrl(cluster: Cluster) {
  if (cluster === "devnet") return env.heliusRpcUrlDevnet ?? clusterApiUrl("devnet");
  return env.heliusRpcUrl ?? clusterApiUrl("mainnet-beta");
}

export function getWsUrl(cluster: Cluster) {
  if (cluster === "devnet") return env.heliusWsUrlDevnet ?? "wss://api.devnet.solana.com/";
  return env.heliusWsUrl ?? "wss://api.mainnet-beta.solana.com/";
}

export function getJitoUrl(cluster: Cluster) {
  // Jito bundles are mainnet only. We keep the function for code symmetry.
  if (cluster === "devnet") return env.jitoBlockEngineUrl;
  return env.jitoBlockEngineUrl;
}

export const requiredEnv = {
  // Helper for endpoints that truly require URLs
  heliusRpcUrlMainnet: () => required("HELIUS_RPC_URL"),
  heliusWsUrlMainnet: () => required("HELIUS_WS_URL"),
  jitoBlockEngineUrl: () => required("JITO_BLOCK_ENGINE_URL")
};

