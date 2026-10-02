/**
 * Storage for the copy and claim flows: short-lived caches (quotes, positions),
 * pending orders (the exact message we built for a user), and the recorded
 * copies / claims. Two implementations:
 *  - lib/copy-store-supabase.ts (real; tables from migration 0006)
 *  - lib/mock/copy-store-memory.ts (MOCK_PANTA=true and tests)
 * Times are unix seconds.
 */
import type { TradeSide } from "./trades";
import type { TxKind } from "./tx-guard";

export type PendingOrder = {
  id: string;
  userId: string;
  wallet: string;
  kind: TxKind;
  leaderTradeId: string | null; // copies only
  marketId: string;
  side: TradeSide;
  amountUsdc: string; // copy: stake; claim: winning shares (1 USDC each)
  feeUsdc: string;
  feeModel: "inclusive" | "on_top" | "no_fee" | null; // copies: detected at quote time; claims: null
  maxUsdcOut: string | null; // the guard limit the order was built under (claims: "0")
  shares: string;
  quoteId: string | null;
  pantaOrderId: string | null;
  messageHash: string; // sha256 hex of the exact message bytes handed to the wallet
  messageBase64: string; // the message itself (not secret; lets mock mode "sign" it)
  lastValidBlockHeight: number | null;
  createdAt: number;
  expiresAt: number; // after this we refuse to broadcast a signed tx
  status: "pending" | "confirmed" | "failed";
  signature: string | null;
  /** E-02: the signature we broadcast (set before sending). Not unique; `signature` is set on confirm. */
  broadcastSignature: string | null;
};

export type PendingOrderInsert = Omit<PendingOrder, "id" | "status" | "signature" | "broadcastSignature">;

export type CompleteResult = "ok" | "already_confirmed" | "signature_used" | "not_pending";

export type RecordedCopy = {
  id: string;
  leaderTradeId: string;
  marketId: string;
  side: TradeSide;
  amountUsdc: string; // total that left the wallet, fee included
  feeUsdc: string | null; // null for rows recorded before fee_usdc existed
  shares: string;
  signature: string;
  status: "confirmed" | "reported";
  createdAt: number;
};

export type RecordedClaim = {
  id: string;
  marketId: string;
  side: TradeSide;
  shares: string;
  signature: string;
  createdAt: number;
};

/** An unreported copy/claim the cron should report to Panta again (B3-07). */
export type ReportJob = {
  kind: TxKind;
  orderId: string;
  signature: string;
  wallet: string;
  marketId: string;
  quoteId: string | null;
  attempts: number; // including this one
};

export type ReportRetryPolicy = { limit: number; maxAttempts: number; baseGapSec: number; maxAgeSec: number };

export interface CopyStore {
  cacheGet<T>(key: string, nowSec: number): Promise<T | null>;
  cachePut(key: string, value: unknown, expiresAtSec: number): Promise<void>;
  cacheDelete(key: string): Promise<void>;

  createPendingOrder(o: PendingOrderInsert): Promise<PendingOrder>;
  getPendingOrder(id: string): Promise<PendingOrder | null>;
  /** Is this signature already recorded anywhere (orders, copies, claims)? */
  signatureUsed(signature: string): Promise<boolean>;
  /**
   * Atomically: pending -> confirmed with `signature`, and insert the copies
   * (or claims) row. UNIQUE signatures make a reused signature fail. With
   * allowFailed, a failed order may be confirmed too (B3-06: re-verified on chain).
   * The same order + signature twice returns already_confirmed and records nothing.
   */
  completeOrder(
    orderId: string,
    userId: string,
    signature: string,
    opts?: { allowFailed?: boolean },
  ): Promise<CompleteResult>;
  failOrder(orderId: string): Promise<void>;
  /** E-02: remember the signature we are about to broadcast (pending orders only, first one wins). */
  noteBroadcast(orderId: string, signature: string): Promise<void>;
  /**
   * G-02: claim up to `limit` pending orders with a broadcast signature, created in
   * (createdAfter, createdBefore) and swept fewer than `maxAttempts` times, least recently
   * swept first (never-swept first). Bumps each one's attempt counter atomically and
   * returns the new count (concurrent sweeps never share an order).
   */
  claimBroadcastSweep(p: {
    limit: number;
    createdBefore: number;
    createdAfter: number;
    maxAttempts: number;
  }): Promise<{ order: PendingOrder; attempts: number }[]>;
  /**
   * H-03: fail pending orders we never broadcast, created before `createdBefore` (seconds). No
   * confirm path can record those any more (the quote and the signature window are both over).
   * Returns how many were failed.
   */
  failUnbroadcastBefore(createdBefore: number): Promise<number>;
  /** G-03: count one more broadcast of this pending order's signed bytes; false if over `max` (or not pending). */
  noteSendAttempt(orderId: string, max: number): Promise<boolean>;
  /** After POST /trades/: copies.status = reported, reported_at = now (claims: reported_at). */
  markReported(orderId: string): Promise<void>;
  /** Has the copy/claim recorded for this order been reported to Panta? */
  isReported(orderId: string): Promise<boolean>;
  /** A failed report attempt (code is a Panta error code). stop = never retry. */
  recordReportFailure(orderId: string, code: string, stop: boolean, maxAttempts: number): Promise<void>;
  /** Claim due report retries (bumps their attempt counters atomically). */
  claimReportRetries(p: ReportRetryPolicy): Promise<ReportJob[]>;

  listCopies(userId: string, limit: number): Promise<RecordedCopy[]>;
  listClaims(userId: string, limit: number): Promise<RecordedClaim[]>;
}
