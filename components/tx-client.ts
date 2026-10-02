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
    /** E-02: VERIFY_UNAVAILABLE carries the signature so we can keep checking. */
    readonly signature?: string,
  ) {
    super(message);
  }
}

/** How long the browser keeps checking a broadcast transaction (30 x 2 s). The cron sweep takes over after. */
export const CONFIRM_POLLS = 30;

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
  const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string; signature?: unknown };
  if (!res.ok) {
    const sig = typeof data.signature === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(data.signature) ? data.signature : undefined;
    throw new FlowError(data.code ?? "ERROR", data.message ?? "Something went wrong", sig);
  }
  return { status: res.status, data: data as T };
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type ConfirmStep = Confirmed | { status: "pending"; signature: string };

/**
 * E-02: "pending" and VERIFY_UNAVAILABLE both mean "landed or landing, not
 * verified yet": keep checking by signature, at most CONFIRM_POLLS times. If we
 * give up, the server's cron sweep still records it.
 */
export async function pollConfirm(
  post: (body: unknown) => Promise<ConfirmStep>,
  orderId: string,
  first: unknown,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Confirmed> {
  const attempt = async (body: unknown): Promise<ConfirmStep> => {
    try {
      return await post(body);
    } catch (err) {
      if (err instanceof FlowError && err.code === "VERIFY_UNAVAILABLE" && err.signature)
        return { status: "pending", signature: err.signature };
      throw err;
    }
  };
  let r = await attempt(first);
  for (let i = 0; r.status === "pending" && i < CONFIRM_POLLS; i++) {
    await wait(2000);
    r = await attempt({ orderId, signature: r.signature });
  }
  if (r.status !== "confirmed") {
    throw new FlowError(
      "PENDING",
      "Sent, still being verified. It will be recorded automatically; check your positions in a few minutes.",
    );
  }
  return r;
}

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
      return pollConfirm((body) => api<ConfirmStep>("POST", confirmUrl, body).then((x) => x.data), built.orderId, first, sleep);
    },
    [wallet, wallets, sessionWallet, mock],
  );
}
