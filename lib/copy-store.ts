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
};

export type PendingOrderInsert = Omit<PendingOrder, "id" | "status" | "signature">;

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
   * (or claims) row. UNIQUE signatures make a reused signature fail.
   */
  completeOrder(orderId: string, userId: string, signature: string): Promise<CompleteResult>;
  failOrder(orderId: string): Promise<void>;
  /** After POST /trades/: copies.status = reported (claims: reported_at). */
  markReported(orderId: string): Promise<void>;

  listCopies(userId: string, limit: number): Promise<RecordedCopy[]>;
  listClaims(userId: string, limit: number): Promise<RecordedClaim[]>;
}
