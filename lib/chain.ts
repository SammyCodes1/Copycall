/**
 * What the copy/claim flows need from Solana. Two implementations:
 *  - lib/solana.ts `rpcChain` (real; SOLANA_RPC_URL, server only)
 *  - lib/mock/chain-mock.ts (MOCK_PANTA=true and tests; an in-memory ledger)
 */
import type { VersionedMessage } from "@solana/web3.js";
import type { ChainReader } from "./tx-guard";

export type LandedTx = {
  err: unknown | null;
  message: VersionedMessage;
  signatures: string[];
  /**
   * USDC (base units) the fee payer's wallet lost in this transaction, from the
   * chain's own pre/post token balances (negative = received). null if unknown.
   */
  payerUsdcOutBase?: bigint | null;
};

export type ConfirmationState = "confirmed" | "failed" | "pending" | "expired";

export interface Chain extends ChainReader {
  /** Broadcast signed bytes on our RPC. Returns the signature. */
  send(raw: Uint8Array): Promise<string>;
  /** Wait (bounded) for `confirmed` commitment. */
  waitForConfirmation(
    signature: string,
    lastValidBlockHeight: number | null,
    timeoutMs: number,
  ): Promise<ConfirmationState>;
  /** The transaction as it landed on chain (confirmed commitment), or null if not found yet. */
  getLandedTransaction(signature: string): Promise<LandedTx | null>;
  /**
   * MOCK CHAIN ONLY: "sign" and land the exact message without a wallet.
   * Undefined on the real chain, so simulated signing can't exist in real mode.
   */
  simulateSignAndSend?(messageBytes: Uint8Array): Promise<string>;
}
