/**
 * What the copy/claim flows need from Solana. Two implementations:
 *  - lib/solana.ts `rpcChain` (real; SOLANA_RPC_URL, server only)
 *  - lib/mock/chain-mock.ts (MOCK_PANTA=true and tests; an in-memory ledger)
 */
import type { VersionedMessage } from "@solana/web3.js";
import type { ChainReader, InnerSystemOp } from "./tx-guard";

export type LandedTx = {
  err: unknown | null;
  message: VersionedMessage;
  signatures: string[];
  /**
   * USDC (base units) the fee payer's wallet lost in this transaction, from the
   * chain's own pre/post token balances (negative = received). null if unknown.
   */
  payerUsdcOutBase?: bigint | null;
  /** Programs reached through CPI (meta.innerInstructions). null if unknown. */
  innerPrograms?: string[] | null;
  /** Inner System instructions (F-01). null if unknown. */
  innerSystemOps?: InnerSystemOp[] | null;
};

export type ConfirmationState = "confirmed" | "failed" | "pending" | "expired";

export interface Chain extends ChainReader {
  /** Broadcast signed bytes on our RPC. Returns the signature. */
  send(raw: Uint8Array): Promise<string>;
  /**
   * Wait (bounded) for `confirmed` commitment. Always reads the status at least once (G-01),
   * even with timeoutMs 0. "expired" = past lastValidBlockHeight, or (when that is unknown)
   * the message's blockhash is no longer valid (G-02), and still no status on a second read.
   */
  waitForConfirmation(
    signature: string,
    lastValidBlockHeight: number | null,
    timeoutMs: number,
    blockhash?: string,
  ): Promise<ConfirmationState>;
  /** G-03: whether a blockhash can still land a transaction (bounded re-sends only while true). */
  isBlockhashValid(blockhash: string): Promise<boolean>;
  /** The transaction as it landed on chain (confirmed commitment), or null if not found yet. */
  getLandedTransaction(signature: string): Promise<LandedTx | null>;
  /** F-01: the wallet account's current owner, executable flag and data length (null = no account). */
  getWalletAccount(address: string): Promise<{ owner: string; executable: boolean; dataLength: number } | null>;
  /**
   * MOCK CHAIN ONLY: "sign" and land the exact message without a wallet.
   * Undefined on the real chain, so simulated signing can't exist in real mode.
   */
  simulateSignAndSend?(messageBytes: Uint8Array): Promise<string>;
}
