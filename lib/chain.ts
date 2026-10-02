/**
 * What the copy/claim flows need from Solana. Two implementations:
 *  - lib/solana.ts `rpcChain` (real; SOLANA_RPC_URL, server only)
 *  - lib/mock/chain-mock.ts (MOCK_PANTA=true and tests; an in-memory ledger)
 */
import type { VersionedMessage } from "@solana/web3.js";
import type { ChainReader, InnerSystemOp, TokenAuthorityOp } from "./tx-guard";

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
  /** H-04: inner Token delegate/authority/close instructions. null if unknown. */
  tokenAuthorityOps?: TokenAuthorityOp[] | null;
  /** J-07: the fee payer's lamports right after this tx (meta.postBalances[0]). null if unknown. */
  payerPostLamports?: number | null;
};

export type ConfirmationState = "confirmed" | "failed" | "pending" | "expired";

/**
 * I-01: a broadcast that didn't return a signature. `refused` only when the RPC's structured
 * JSON-RPC error proves the node rejected it before forwarding (-32002 preflight failure with a
 * TransactionError, -32003 signature verification). Everything else (node behind -32005,
 * internal -32603, rate limit, HTTP 429/5xx, timeouts, unknown codes) is `unclear`: the tx may
 * have been relayed. `detail` never contains the RPC URL.
 */
export class SendError extends Error {
  constructor(
    readonly kind: "refused" | "unclear",
    readonly rpcCode: number | null,
    detail: string,
  ) {
    super(detail);
    this.name = "SendError";
  }
}

export interface Chain extends ChainReader {
  /** Broadcast signed bytes on our RPC. Returns the signature. Throws SendError (I-01). */
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
  /** I-01: any on-chain trace of this signature (any commitment, incl. processed, with history). */
  signatureSeen(signature: string): Promise<boolean>;
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
