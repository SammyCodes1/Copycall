"use client";
/**
 * Browser side of the copy/claim flows. The browser never builds or edits a
 * transaction and never talks to an RPC: it signs the exact bytes our server
 * validated, and hands them back to our server to broadcast and verify.
 */
import { WalletReadyState, type SignerWalletAdapter } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { useCallback } from "react";

export type Checks = {
  feePayer: string;
  programs: string[];
  usdcOut: string;
  maxUsdcOut: string;
  otherAccountsChecked: number;
};
export type Built = { orderId: string; transaction: string; expiresAt: number; simulated: boolean; checks: Checks };
export type Confirmed = { status: "confirmed"; signature: string; reported: boolean; simulated: boolean };

/** An API error with our stable `code` (QUOTE_EXPIRED, TX_REJECTED, ...). */
export class FlowError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new FlowError("NETWORK", "Network error. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!res.ok) throw new FlowError(data.code ?? "ERROR", data.message ?? "Something went wrong");
  return { status: res.status, data: data as T };
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns sign(built, confirmUrl, onStage): wallet signs the exact bytes (or,
 * in mock mode, signing is simulated server-side), then our server confirms.
 */
export function useTxSigner(sessionWallet: string, mock: boolean) {
  const { wallet, wallets } = useWallet();

  return useCallback(
    async (built: Built, confirmUrl: string, onStage: (s: "signing" | "confirming") => void): Promise<Confirmed> => {
      onStage("signing");
      let first: { orderId: string; signedTransaction?: string; simulated?: true };
      if (mock) {
        // Simulated wallet approval: a visible beat so the demo shows the signing step.
        await sleep(1200);
        first = { orderId: built.orderId, simulated: true };
      } else {
        const adapter =
          wallet?.adapter ?? wallets.find((w) => w.readyState === WalletReadyState.Installed)?.adapter ?? null;
        if (!adapter) throw new FlowError("NO_WALLET", "Install Phantom or Solflare to sign.");
        if (!adapter.connected) {
          try {
            await adapter.connect();
          } catch {
            throw new FlowError("WALLET_DECLINED", "Your wallet didn't connect. Nothing was sent.");
          }
        }
        if (adapter.publicKey?.toBase58() !== sessionWallet) {
          throw new FlowError(
            "WALLET_MISMATCH",
            `Switch your wallet to ${sessionWallet.slice(0, 4)}…${sessionWallet.slice(-4)} to sign.`,
          );
        }
        if (!("signTransaction" in adapter)) throw new FlowError("NO_WALLET", "This wallet can't sign transactions.");
        const tx = VersionedTransaction.deserialize(fromB64(built.transaction));
        let signed: VersionedTransaction;
        try {
          signed = await (adapter as SignerWalletAdapter).signTransaction(tx);
        } catch {
          throw new FlowError("WALLET_DECLINED", "You declined in your wallet. Nothing was sent.");
        }
        first = { orderId: built.orderId, signedTransaction: toB64(signed.serialize()) };
      }

      onStage("confirming");
      let r = await api<Confirmed | { status: "pending"; signature: string }>("POST", confirmUrl, first);
      for (let i = 0; r.data.status === "pending" && i < 30; i++) {
        await sleep(2000);
        r = await api("POST", confirmUrl, { orderId: built.orderId, signature: r.data.signature });
      }
      if (r.data.status !== "confirmed") {
        throw new FlowError("PENDING", "Still waiting for the network. Check your positions in a minute.");
      }
      return r.data;
    },
    [wallet, wallets, sessionWallet, mock],
  );
}
