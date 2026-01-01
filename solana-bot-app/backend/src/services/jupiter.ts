type QuoteResponse = {
  inputMint: string;
  outputMint: string;
  // swap/v1 fields
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan?: unknown[];
};

function jupBase() {
  // The legacy `quote-api.jup.ag` hostname no longer resolves in some environments.
  // `lite-api.jup.ag` provides public quote/swap endpoints under `/swap/v1`.
  return "https://lite-api.jup.ag/swap/v1";
}

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export async function jupiterQuote(opts: {
  inputMint: string;
  outputMint: string;
  amount: string; // integer string
  slippageBps: number;
}): Promise<QuoteResponse> {
  const url = new URL(`${jupBase()}/quote`);
  url.searchParams.set("inputMint", opts.inputMint);
  url.searchParams.set("outputMint", opts.outputMint);
  url.searchParams.set("amount", opts.amount);
  url.searchParams.set("slippageBps", String(opts.slippageBps));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Jupiter quote failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as QuoteResponse;
}

export async function jupiterSwapTxBase64(opts: {
  quoteResponse: QuoteResponse;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
}): Promise<string> {
  const res = await fetch(`${jupBase()}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: opts.quoteResponse,
      userPublicKey: opts.userPublicKey,
      wrapAndUnwrapSol: opts.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: true
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Jupiter swap failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  const tx = data?.swapTransaction as string | undefined;
  if (!tx) throw new Error("Jupiter swap response missing swapTransaction");
  return tx;
}

