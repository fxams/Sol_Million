/* eslint-disable @next/next/no-img-element */
"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { BackpackWalletAdapter } from "@solana/wallet-adapter-backpack";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";

export function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => {
    // Prefer explicit RPC URL (Helius recommended), fall back to clusterApiUrl.
    const env = process.env.NEXT_PUBLIC_RPC_URL?.trim();
    if (env) return env;
    const cluster = (process.env.NEXT_PUBLIC_CLUSTER ?? "mainnet-beta") as
      | "mainnet-beta"
      | "devnet";
    return clusterApiUrl(cluster);
  }, []);

  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new BackpackWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

