"use client";
/**
 * Browser side of the copy/claim flows. The browser never builds or edits a
 * transaction and never talks to an RPC: it signs the exact bytes our server
 * validated, and hands them back to our server to broadcast and verify.
 */
import { WalletReadyState, type SignerWalletAdapter } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
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
    /** HTTP status of the failed response (0 = no response). */
    readonly httpStatus = 0,
  ) {
    super(message);
  }
}

/** How long the browser keeps checking a broadcast transaction (30 x 2 s). The cron sweep takes over after. */
export const CONFIRM_POLLS = 30;
/**
 * F-04: how many times the browser re-checks by signature after the server failed the order
 * (QUOTE_EXPIRED / ORDER_NOT_PENDING with a signature): the revive path re-verifies on chain.
 */
export const REVIVE_TRIES = 3;
const REVIVABLE = new Set(["QUOTE_EXPIRED", "ORDER_NOT_PENDING"]);

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
    throw new FlowError(data.code ?? "ERROR", data.message ?? "Something went wrong", sig, res.status);
  }
  return { status: res.status, data: data as T };
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type ConfirmStep = Confirmed | { status: "pending"; signature: string };

/**
 * E-02 / F-04: keep checking a sent transaction by signature until it is recorded:
 *  - "pending" and VERIFY_UNAVAILABLE (with a signature): landed or landing, not verified yet;
 *  - a lost response (network error or 5xx) after we handed over a signed transaction: we know
 *    its signature locally, so check by signature;
 *  - QUOTE_EXPIRED / ORDER_NOT_PENDING carrying a signature: the server failed the order, but
 *    it may still have landed; the revive path re-verifies it on chain (at most REVIVE_TRIES).
 * At most CONFIRM_POLLS checks in total. If we give up, the server's cron sweep still records
 * pending orders.
 */
export async function pollConfirm(
  post: (body: unknown) => Promise<ConfirmStep>,
  orderId: string,
  first: unknown,
  wait: (ms: number) => Promise<void> = sleep,
  knownSignature?: string,
): Promise<Confirmed> {
  let revives = 0;
  const attempt = async (body: unknown): Promise<ConfirmStep> => {
    try {
      return await post(body);
    } catch (err) {
      if (!(err instanceof FlowError)) throw err;
      const sig = err.signature ?? knownSignature;
      if (err.code === "VERIFY_UNAVAILABLE" && sig) return { status: "pending", signature: sig };
      if ((err.code === "NETWORK" || err.httpStatus >= 500) && knownSignature)
        return { status: "pending", signature: knownSignature };
      if (REVIVABLE.has(err.code) && err.signature && revives < REVIVE_TRIES) {
        revives++;
        return { status: "pending", signature: err.signature };
      }
      if (err.code === "QUOTE_EXPIRED" && err.signature)
        throw new FlowError("QUOTE_EXPIRED", "The transaction expired before it landed. Nothing was spent. Refresh and try again.");
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
      let knownSignature: string | undefined;
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
        // F-04: the signature is known as soon as the wallet signs, so a lost response can be re-checked.
        knownSignature = bs58.encode(signed.signatures[0]);
      }

      onStage("confirming");
      return pollConfirm(
        (body) => api<ConfirmStep>("POST", confirmUrl, body).then((x) => x.data),
        built.orderId,
        first,
        sleep,
        knownSignature,
      );
    },
    [wallet, wallets, sessionWallet, mock],
  );
}
