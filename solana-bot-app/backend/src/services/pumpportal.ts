import bs58 from "bs58";

/**
 * PumpPortal "trade-local" returns a serialized transaction for the caller to sign.
 * This keeps the backend keyless (same pattern as our Jupiter integration).
 *
 * NOTE: This is a pragmatic integration for Pump.fun pre-migration tokens.
 * If you want to avoid third-party services, replace this with a native Pump.fun
 * instruction builder (bonding curve) using the on-chain program ID + account derivations.
 */

type PumpPortalTradeLocalResponse =
  | string
  | {
      transaction?: string;
      tx?: string;
      signedTransaction?: string;
      message?: string;
      error?: string;
    };

function pumpportalUrl() {
  // Public endpoint used by many Pump.fun tooling setups.
  return "https://pumpportal.fun/api/trade-local";
}

function looksBase64(s: string) {
  // Base64 often includes +,/ and ends with = padding; base58 does not.
  return /[+/=]/.test(s) || /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function toBase64Tx(txEncoded: string): string {
  const t = txEncoded.trim();
  if (!t) throw new Error("Empty PumpPortal transaction");
  if (looksBase64(t)) return t;
  // Assume base58
  const bytes = bs58.decode(t);
  return Buffer.from(bytes).toString("base64");
}

export async function pumpportalTradeTxBase64(opts: {
  owner: string; // base58 pubkey
  mint: string; // token mint
  action: "buy" | "sell";
  /**
   * PumpPortal expects:
   * - buy: amount in SOL (number) when denominatedInSol=true
   * - sell: amount in tokens or percentage depending on "denominatedInSol"
   *
   * We allow either a number or a string such as "100%".
   */
  amount: number | string;
  denominatedInSol: boolean;
  slippagePercent: number;
  /**
   * Optional "priorityFee" used by some PumpPortal setups.
   * Setting 0 lets the network fee market decide.
   */
  priorityFeeSol?: number;
}): Promise<string> {
  const body: any = {
    publicKey: opts.owner,
    action: opts.action,
    mint: opts.mint,
    amount: opts.amount,
    denominatedInSol: opts.denominatedInSol,
    slippage: opts.slippagePercent,
    priorityFee: opts.priorityFeeSol ?? 0,
    // Explicitly choose pump.fun pool path (pre-migration).
    pool: "pump"
  };

  const res = await fetch(pumpportalUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PumpPortal trade-local failed (${res.status}): ${txt.slice(0, 200)}`);
  }

  const data = (await res.json().catch(() => null)) as PumpPortalTradeLocalResponse | null;
  if (!data) throw new Error("PumpPortal trade-local returned empty response");

  if (typeof data === "string") return toBase64Tx(data);
  if (data.error) throw new Error(`PumpPortal error: ${data.error}`);

  const tx = data.transaction ?? data.tx ?? data.signedTransaction;
  if (!tx) throw new Error(`PumpPortal response missing transaction: ${data.message ?? "unknown"}`);
  return toBase64Tx(tx);
}

