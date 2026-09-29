"use client";
/**
 * Solana wallet context (Phantom + Solflare via @solana/wallet-adapter-react,
 * @solana/web3.js v1). No ConnectionProvider on purpose: the browser never talks
 * to our RPC directly (SOLANA_RPC_URL contains a key and stays server-side).
 * Phantom and Solflare also register via Wallet Standard; the adapter dedupes.
 */
import { WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useMemo, type ReactNode } from "react";

export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <WalletProvider wallets={wallets} autoConnect={false}>
      {children}
    </WalletProvider>
  );
}
