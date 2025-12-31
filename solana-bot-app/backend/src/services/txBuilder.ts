import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import { getRpcUrl } from "../utils/env.js";
import type { Cluster } from "../state/store.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function memoIx(memo: string) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memo, "utf8")
  });
}

export async function buildUnsignedBuyLikeTxBase64(opts: {
  cluster: Cluster;
  owner: string;
  amountSol: number;
  memo: string;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}): Promise<string> {
  const connection = new Connection(getRpcUrl(opts.cluster), "processed");
  const payer = new PublicKey(opts.owner);
  const { blockhash } = await connection.getLatestBlockhash("processed");

  // NOTE:
  // This project template keeps swap-building modular and keyless.
  // Replace the memo instruction with a real Raydium swap instruction builder in production.
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit ?? 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: opts.computeUnitPriceMicroLamports ?? 20_000
    }),
    memoIx(`[BOT] BUY intent | amountSol=${opts.amountSol} | ${opts.memo}`)
  ];

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
}

export async function buildUnsignedSellLikeTxBase64(opts: {
  cluster: Cluster;
  owner: string;
  memo: string;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}): Promise<string> {
  const connection = new Connection(getRpcUrl(opts.cluster), "processed");
  const payer = new PublicKey(opts.owner);
  const { blockhash } = await connection.getLatestBlockhash("processed");

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit ?? 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: opts.computeUnitPriceMicroLamports ?? 20_000
    }),
    memoIx(`[BOT] SELL intent | ${opts.memo}`)
  ];

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
}

export async function buildUnsignedJitoTipTxBase64(opts: {
  cluster: Cluster;
  owner: string;
  tipAccount: string;
  tipLamports: number;
  memo?: string;
}): Promise<string> {
  const connection = new Connection(getRpcUrl(opts.cluster), "processed");
  const payer = new PublicKey(opts.owner);
  const tipTo = new PublicKey(opts.tipAccount);
  const { blockhash } = await connection.getLatestBlockhash("processed");

  const ixs: TransactionInstruction[] = [
    // Tip is paid as a plain SystemProgram transfer to a validator tip account.
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tipTo,
      lamports: opts.tipLamports
    }),
    memoIx(opts.memo ?? `[BOT] Jito tip ${opts.tipLamports} lamports`)
  ];

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
}

export function randomTipLamports(minLamports = 1000) {
  const base = Math.max(minLamports, 1000);
  // Randomize tip a bit to avoid "same tip every time" fingerprints.
  return base + Math.floor(Math.random() * 50_000);
}

