import WebSocket from "ws";
import { Connection, PublicKey } from "@solana/web3.js";
import { env, getRpcUrl, getWsUrl } from "../utils/env.js";
import { pushClusterLog } from "../state/store.js";
import type { Cluster } from "../state/store.js";

export const PUMPFUN_PROGRAM_ID = env.pumpfunProgramId;

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

type TokenDeploymentListener = (token: PumpFunTokenInfo) => void;

const listeners = new Set<TokenDeploymentListener>();
const recentTokens = new Map<Cluster, PumpFunTokenInfo[]>();
const MAX_RECENT_TOKENS = 100; // Reduced from 500 to save memory
const TOKEN_CLEANUP_AGE_MS = 60 * 60 * 1000; // Clean up tokens older than 1 hour

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function parseMintAccount(data: Buffer) {
  if (data.length < 82) return null;
  const mintAuthorityOption = data.readUInt32LE(0);
  const supply = data.readBigUInt64LE(36);
  const decimals = data.readUInt8(44);
  const isInitialized = data.readUInt8(45) === 1;
  const freezeAuthorityOption = data.readUInt32LE(46);
  return { mintAuthorityOption, freezeAuthorityOption, supply, decimals, isInitialized };
}

function getStaticAccountKeysFromTx(tx: any): PublicKey[] {
  const msg = tx?.transaction?.message;
  if (!msg) return [];
  if (Array.isArray(msg.staticAccountKeys)) return msg.staticAccountKeys as PublicKey[];
  if (Array.isArray(msg.accountKeys)) return msg.accountKeys as PublicKey[];
  return [];
}

async function withRetries<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseDelayMs?: number }): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 250;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const delay = baseDelayMs * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function getTransactionFast(connection: Connection, cluster: Cluster, signature: string) {
  const attempt = async (commitment: "confirmed" | "finalized") =>
    await connection.getTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0
    });

  const txConfirmed = await withRetries(async () => await attempt("confirmed"), { attempts: 3, baseDelayMs: 200 });
  if (txConfirmed) return txConfirmed;

  const txFinalized = await withRetries(async () => await attempt("finalized"), { attempts: 2, baseDelayMs: 250 });
  return txFinalized;
}

function isCreateLikePumpfunLogs(logs: string[]) {
  // More specific: look for actual create instruction, not just any "create" word
  return logs.some((l) => 
    /instruction:\s*create/i.test(l) || 
    /program log:\s*create/i.test(l) ||
    /create.*token/i.test(l) ||
    /initialize.*token/i.test(l)
  );
}

// Check if transaction actually creates a new mint (not just a trade)
function isTokenCreationTx(tx: any, mint: string): boolean {
  // Must have the mint appear in post but not pre token balances
  const preMints = new Set<string>();
  const postMints = new Set<string>();
  
  for (const b of tx?.meta?.preTokenBalances ?? []) {
    if (b?.mint) preMints.add(b.mint);
  }
  for (const b of tx?.meta?.postTokenBalances ?? []) {
    if (b?.mint) postMints.add(b.mint);
  }
  
  // Mint must be new (in post but not pre)
  if (!postMints.has(mint) || preMints.has(mint)) return false;
  
  // Additional check: look for mint initialization in inner instructions
  const innerInstructions = tx?.meta?.innerInstructions ?? [];
  for (const inner of innerInstructions) {
    for (const ix of inner?.instructions ?? []) {
      const programIdIndex = ix?.programIdIndex;
      if (programIdIndex !== undefined) {
        try {
          const keys = getStaticAccountKeysFromTx(tx);
          if (keys.length > programIdIndex) {
            const programId = keys[programIdIndex];
            if (programId && (programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID))) {
              // This is likely a token operation
              return true;
            }
          }
        } catch {
          // ignore parsing errors
        }
      }
    }
  }
  
  return true; // If mint is new, assume it's a creation
}

function isMintNewInTx(tx: any, mint: string) {
  const pre = new Set<string>();
  const post = new Set<string>();
  for (const b of tx?.meta?.preTokenBalances ?? []) if (b?.mint) pre.add(b.mint);
  for (const b of tx?.meta?.postTokenBalances ?? []) if (b?.mint) post.add(b.mint);
  return post.has(mint) && !pre.has(mint);
}

async function extractTokenInfo(opts: { cluster: Cluster; signature: string; logs: string[] }): Promise<PumpFunTokenInfo | null> {
  const connection = new Connection(getRpcUrl(opts.cluster), "confirmed");
  const tx = await getTransactionFast(connection, opts.cluster, opts.signature);
  if (!tx) return null;

  // Extract mint from token balances
  const mints = new Set<string>();
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint) mints.add(b.mint);
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint) mints.add(b.mint);

  if (mints.size === 0) {
    // Try to find mint in account keys
    const keys = getStaticAccountKeysFromTx(tx);
    for (const k of keys.slice(0, 25)) {
      try {
        const info = await withRetries(async () => await connection.getAccountInfo(k, "confirmed"), {
          attempts: 2,
          baseDelayMs: 200
        });
        if (!info) continue;
        if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;
        const parsed = parseMintAccount(Buffer.from(info.data));
        if (!parsed?.isInitialized) continue;
        mints.add(k.toBase58());
        break;
      } catch {
        // continue
      }
    }
  }

  if (mints.size === 0) return null;

  const mint = Array.from(mints)[0];
  
  // Check if this is a new mint (appears in post but not pre balances)
  const isNewMint = isMintNewInTx(tx, mint);
  
  // If it's a new mint, it's likely a token creation
  // We'll be less strict to catch more tokens, but still validate it's new
  if (!isNewMint) {
    // Not a new mint, skip
    return null;
  }
  
  // Additional validation: check if it has create-like logs (optional but preferred)
  const hasCreateLogs = isCreateLikePumpfunLogs(opts.logs);
  
  // If no create logs, still allow if it's a new mint (might be created via different method)
  // This helps catch tokens that might not have the exact log pattern

  // Extract deployer (first signer)
  const keys = getStaticAccountKeysFromTx(tx);
  const deployer = keys.length > 0 ? keys[0].toBase58() : null;

  // Get token metadata
  let decimals: number | undefined;
  let supply: string | undefined;
  let name: string | undefined;
  let symbol: string | undefined;
  let imageUri: string | undefined;
  let website: string | undefined;
  let twitter: string | undefined;
  let description: string | undefined;
  let metadataUri: string | undefined;

  try {
    const mintPk = new PublicKey(mint);
    const info = await withRetries(async () => await connection.getAccountInfo(mintPk, "confirmed"), {
      attempts: 2,
      baseDelayMs: 200
    });
    if (info) {
      const parsed = parseMintAccount(Buffer.from(info.data));
      if (parsed) {
        decimals = parsed.decimals;
        supply = parsed.supply.toString();
      }
    }

    // Try to get token supply
    try {
      const supplyResp = await connection.getTokenSupply(mintPk, "confirmed");
      if (supplyResp.value) {
        supply = supplyResp.value.amount;
        decimals = supplyResp.value.decimals;
      }
    } catch {
      // ignore
    }

    // Fetch metadata from multiple sources
    try {
      // First try Pump Fun API (most reliable for Pump Fun tokens)
      const pumpFunMetadata = await fetchPumpFunMetadata(mint);
      if (pumpFunMetadata) {
        name = pumpFunMetadata.name || name;
        symbol = pumpFunMetadata.symbol || symbol;
        imageUri = pumpFunMetadata.image || imageUri;
        website = pumpFunMetadata.website || website;
        twitter = pumpFunMetadata.twitter || twitter;
        description = pumpFunMetadata.description || description;
      }
    } catch (e: any) {
      pushClusterLog(opts.cluster, "warn", `Pump Fun API fetch failed for ${mint.slice(0, 8)}: ${e?.message}`);
    }

    // Fallback to Metaplex metadata
    if (!name || !imageUri) {
      try {
        const metadata = await fetchMetaplexMetadata(connection, mintPk);
        if (metadata) {
          name = name || metadata.name;
          symbol = symbol || metadata.symbol;
          imageUri = imageUri || metadata.image;
          metadataUri = metadataUri || metadata.uri;
          description = description || metadata.description;
          if (!website && metadata.external_url) website = metadata.external_url;
          if (!twitter && metadata.twitter) twitter = metadata.twitter;
          if (metadata.attributes) {
            // Some tokens store links in attributes
            for (const attr of metadata.attributes) {
              if (attr.trait_type === "website" && typeof attr.value === "string" && !website) {
                website = attr.value;
              }
              if (attr.trait_type === "twitter" && typeof attr.value === "string" && !twitter) {
                twitter = attr.value;
              }
            }
          }
        }
      } catch (e: any) {
        pushClusterLog(opts.cluster, "warn", `Metaplex metadata fetch failed for ${mint.slice(0, 8)}: ${e?.message}`);
      }
    }
  } catch {
    // ignore metadata errors
  }

  return {
    mint,
    signature: opts.signature,
    deployer,
    timestamp: Date.now(),
    decimals,
    supply,
    name,
    symbol,
    imageUri,
    website,
    twitter,
    description,
    metadataUri
  };
}

// Derive Metaplex metadata PDA
async function deriveMetadataPDA(mint: PublicKey): Promise<PublicKey> {
  const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  return metadataPDA;
}

// Fetch metadata from Pump Fun API with memory-efficient approach
async function fetchPumpFunMetadata(mint: string): Promise<any | null> {
  try {
    // Pump Fun API endpoint
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    if (!data) return null;

    // Only extract needed fields to minimize memory
    return {
      name: data.name,
      symbol: data.symbol,
      image: data.image_uri || data.image,
      description: data.description ? String(data.description).substring(0, 500) : undefined, // Limit description length
      website: data.website || data.website_url,
      twitter: data.twitter || data.twitter_url || (data.twitter_handle ? `https://twitter.com/${String(data.twitter_handle).replace(/^@/, "")}` : undefined)
    };
  } catch {
    return null;
  }
}

// Fetch Metaplex metadata
async function fetchMetaplexMetadata(connection: Connection, mint: PublicKey): Promise<any | null> {
  try {
    const metadataPDA = await deriveMetadataPDA(mint);
    const metadataAccount = await withRetries(
      async () => await connection.getAccountInfo(metadataPDA, "confirmed"),
      { attempts: 2, baseDelayMs: 200 }
    );

    if (!metadataAccount || !metadataAccount.data) return null;

    // Parse Metaplex metadata (simplified - real parsing is more complex)
    const data = metadataAccount.data;
    if (data.length < 1) return null;

    // Skip key (1 byte) and update authority (32 bytes)
    let offset = 1 + 32;
    if (data.length < offset + 32) return null;

    // Mint (32 bytes)
    offset += 32;

    // Data struct starts here
    if (data.length < offset + 4) return null;
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    if (data.length < offset + nameLen) return null;
    const nameBytes = data.slice(offset, offset + nameLen);
    const name = nameBytes.toString("utf8").replace(/\0/g, "");
    offset += nameLen;

    if (data.length < offset + 4) return null;
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    if (data.length < offset + symbolLen) return null;
    const symbolBytes = data.slice(offset, offset + symbolLen);
    const symbol = symbolBytes.toString("utf8").replace(/\0/g, "");
    offset += symbolLen;

    if (data.length < offset + 4) return null;
    const uriLen = data.readUInt32LE(offset);
    offset += 4;
    if (data.length < offset + uriLen) return null;
    const uriBytes = data.slice(offset, offset + uriLen);
    const uri = uriBytes.toString("utf8").replace(/\0/g, "");

    // Fetch JSON metadata from URI
    if (uri && (uri.startsWith("http") || uri.startsWith("https"))) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(uri, { 
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0"
          }
        });
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const json = await response.json();
          return {
            name: json.name || name,
            symbol: json.symbol || symbol,
            image: json.image || json.image_uri,
            description: json.description,
            external_url: json.external_url || json.website,
            twitter: json.twitter || json.twitter_url || (json.twitter_handle ? `https://twitter.com/${String(json.twitter_handle).replace(/^@/, "")}` : undefined),
            uri
          };
        }
      } catch (e: any) {
        // Log but don't fail - metadata URI fetch is optional
        // console.log(`Metadata URI fetch failed: ${e?.message}`);
      }
    }

    return { name, symbol, uri };
  } catch {
    return null;
  }
}

const seenSignatures = new Map<Cluster, Set<string>>();
const seenMints = new Map<Cluster, Set<string>>();
const wsConnections = new Map<Cluster, WebSocket>();

function markSeenSignature(cluster: Cluster, signature: string): boolean {
  if (!seenSignatures.has(cluster)) {
    seenSignatures.set(cluster, new Set());
  }
  const seen = seenSignatures.get(cluster)!;
  if (seen.has(signature)) return true;
  seen.add(signature);
  // Cap memory - reduced size
  if (seen.size > 2000) {
    const keep = Array.from(seen).slice(-1000);
    seenSignatures.set(cluster, new Set(keep));
  }
  return false;
}

function markSeenMint(cluster: Cluster, mint: string): boolean {
  if (!seenMints.has(cluster)) {
    seenMints.set(cluster, new Set());
  }
  const seen = seenMints.get(cluster)!;
  if (seen.has(mint)) return true;
  seen.add(mint);
  // Cap memory - reduced size
  if (seen.size > 2000) {
    const keep = Array.from(seen).slice(-1000);
    seenMints.set(cluster, new Set(keep));
  }
  return false;
}

export function subscribeTokenDeployments(listener: TokenDeploymentListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentTokens(cluster: Cluster): PumpFunTokenInfo[] {
  const tokens = recentTokens.get(cluster) ?? [];
  // Clean up old tokens when retrieving
  const now = Date.now();
  const cleaned = tokens.filter((t) => now - t.timestamp < TOKEN_CLEANUP_AGE_MS);
  if (cleaned.length < tokens.length) {
    recentTokens.set(cluster, cleaned);
  }
  return cleaned;
}

export async function ensureTokenMonitoring(cluster: Cluster) {
  if (!PUMPFUN_PROGRAM_ID) {
    pushClusterLog(cluster, "warn", "PUMPFUN_PROGRAM_ID not set; token monitoring disabled.");
    return;
  }

  if (wsConnections.has(cluster)) return;
  
  // Start periodic cleanup if not already started
  startPeriodicCleanup();

  const wsUrl = getWsUrl(cluster);
  pushClusterLog(cluster, "info", `Starting Pump Fun token monitoring: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);
  wsConnections.set(cluster, ws);

  ws.on("open", () => {
    pushClusterLog(cluster, "info", "Pump Fun token monitoring WebSocket connected");
    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "logsSubscribe",
        params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: "processed" }]
      })
    );
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString()) as any;

      if (msg.method === "logsNotification") {
        const signature = msg.params?.result?.value?.signature as string | undefined;
        const logs = (msg.params?.result?.value?.logs as string[]) ?? [];

        if (!signature || logs.length === 0) return;
        if (markSeenSignature(cluster, signature)) return;

        // Check if this looks like a token creation
        if (!isCreateLikePumpfunLogs(logs)) return;

        // Extract token info
        try {
          const tokenInfo = await extractTokenInfo({ cluster, signature, logs });
          if (!tokenInfo) return;
          
          // Skip if we've already seen this mint (avoid duplicates)
          if (markSeenMint(cluster, tokenInfo.mint)) {
            pushClusterLog(cluster, "info", `Skipping duplicate mint: ${tokenInfo.mint.slice(0, 8)}...`);
            return;
          }

          // Add to recent tokens with cleanup
          if (!recentTokens.has(cluster)) {
            recentTokens.set(cluster, []);
          }
          const clusterTokens = recentTokens.get(cluster)!;
          
          // Clean up old tokens first (older than 1 hour)
          const now = Date.now();
          const cleaned = clusterTokens.filter((t) => now - t.timestamp < TOKEN_CLEANUP_AGE_MS);
          recentTokens.set(cluster, cleaned);
          
          // Add new token
          cleaned.unshift(tokenInfo);
          
          // Cap at MAX_RECENT_TOKENS
          if (cleaned.length > MAX_RECENT_TOKENS) {
            cleaned.splice(MAX_RECENT_TOKENS);
          }
          
          recentTokens.set(cluster, cleaned);

          // Notify listeners immediately with basic info
          for (const listener of listeners) {
            try {
              listener(tokenInfo);
            } catch {
              // ignore listener errors
            }
          }

          // Fetch metadata asynchronously and update (metadata might not be immediately available)
          // Use a single timeout to avoid memory leaks
          const timeoutId = setTimeout(async () => {
            try {
              // Try Pump Fun API first
              const pumpFunMetadata = await fetchPumpFunMetadata(tokenInfo.mint);
              if (pumpFunMetadata) {
                const tokens = recentTokens.get(cluster);
                if (tokens) {
                  const idx = tokens.findIndex((t) => t.mint === tokenInfo.mint && t.signature === signature);
                  if (idx >= 0) {
                    tokens[idx] = {
                      ...tokens[idx],
                      name: pumpFunMetadata.name || tokens[idx].name,
                      symbol: pumpFunMetadata.symbol || tokens[idx].symbol,
                      imageUri: pumpFunMetadata.image || tokens[idx].imageUri,
                      website: pumpFunMetadata.website || tokens[idx].website,
                      twitter: pumpFunMetadata.twitter || tokens[idx].twitter,
                      description: pumpFunMetadata.description || tokens[idx].description
                    };
                    // Notify listeners with updated metadata
                    for (const listener of listeners) {
                      try {
                        listener(tokens[idx]);
                      } catch {
                        // ignore listener errors
                      }
                    }
                  }
                }
              }
            } catch {
              // ignore async metadata update errors
            }
          }, 3000); // Wait 3 seconds for metadata to be available on Pump Fun API
          
          // Store timeout ID for potential cleanup (though in practice these should complete quickly)
          // Note: In a production environment, you'd want to track these and clear them on shutdown

          pushClusterLog(
            cluster,
            "info",
            `New Pump Fun token: ${tokenInfo.name || tokenInfo.mint.slice(0, 8)}... (${signature.slice(0, 8)}...)`
          );
        } catch (e: any) {
          pushClusterLog(cluster, "warn", `Failed to extract token info: ${e?.message ?? String(e)}`);
        }
      }
    } catch (e: any) {
      pushClusterLog(cluster, "error", `Token monitoring error: ${e?.message ?? String(e)}`);
    }
  });

  ws.on("close", () => {
    pushClusterLog(cluster, "warn", "Pump Fun token monitoring WebSocket closed");
    wsConnections.delete(cluster);
  });

  ws.on("error", (err) => {
    pushClusterLog(cluster, "error", `Pump Fun token monitoring WebSocket error: ${String(err)}`);
  });
}

export function stopTokenMonitoring(cluster: Cluster) {
  const ws = wsConnections.get(cluster);
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    wsConnections.delete(cluster);
  }
  
  // Clean up memory when stopping
  seenSignatures.delete(cluster);
  seenMints.delete(cluster);
  recentTokens.delete(cluster);
}

// Periodic cleanup to prevent memory leaks
let cleanupInterval: NodeJS.Timeout | null = null;

export function startPeriodicCleanup() {
  if (cleanupInterval) return;
  
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [cluster, tokens] of recentTokens.entries()) {
      const cleaned = tokens.filter((t) => now - t.timestamp < TOKEN_CLEANUP_AGE_MS);
      if (cleaned.length < tokens.length) {
        recentTokens.set(cluster, cleaned);
        pushClusterLog(cluster, "info", `Cleaned up ${tokens.length - cleaned.length} old tokens`);
      }
    }
    
    // Clean up seen signatures and mints periodically
    for (const [cluster, seen] of seenSignatures.entries()) {
      if (seen.size > 2000) {
        const keep = Array.from(seen).slice(-1000);
        seenSignatures.set(cluster, new Set(keep));
      }
    }
    
    for (const [cluster, seen] of seenMints.entries()) {
      if (seen.size > 2000) {
        const keep = Array.from(seen).slice(-1000);
        seenMints.set(cluster, new Set(keep));
      }
    }
  }, 5 * 60 * 1000); // Run cleanup every 5 minutes
}

export function stopPeriodicCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
