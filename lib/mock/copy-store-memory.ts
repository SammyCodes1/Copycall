/** In-memory CopyStore (MOCK_PANTA=true and tests only). Same contract as the Supabase store. */
import { randomUUID } from "node:crypto";
import { assertBootSafe, isVercelProduction } from "../boot";
import type { CopyStore, PendingOrder, RecordedClaim, RecordedCopy } from "../copy-store";

export type CopyMemoryState = {
  cache: Map<string, { value: unknown; expiresAt: number }>;
  orders: Map<string, PendingOrder>;
  copies: Map<string, RecordedCopy & { userId: string; orderId: string }>;
  claims: Map<string, RecordedClaim & { userId: string; orderId: string }>;
};

export function createCopyMemoryState(): CopyMemoryState {
  return { cache: new Map(), orders: new Map(), copies: new Map(), claims: new Map() };
}

export function createMemoryCopyStore(s: CopyMemoryState = createCopyMemoryState()): CopyStore {
  assertBootSafe(process.env);
  if (isVercelProduction(process.env)) throw new Error("Memory copy store is not allowed in production");
  const used = (sig: string) =>
    [...s.orders.values()].some((o) => o.signature === sig) ||
    [...s.copies.values()].some((c) => c.signature === sig) ||
    [...s.claims.values()].some((c) => c.signature === sig);

  return {
    async cacheGet<T>(key: string, nowSec: number) {
      const e = s.cache.get(key);
      if (!e || e.expiresAt <= nowSec) return null;
      return structuredClone(e.value) as T;
    },
    async cachePut(key, value, expiresAt) {
      s.cache.set(key, { value: structuredClone(value), expiresAt });
    },
    async cacheDelete(key) {
      s.cache.delete(key);
    },

    async createPendingOrder(o) {
      const row: PendingOrder = { ...o, id: randomUUID(), status: "pending", signature: null };
      s.orders.set(row.id, row);
      return { ...row };
    },
    async getPendingOrder(id) {
      const o = s.orders.get(id);
      return o ? { ...o } : null;
    },
    async signatureUsed(sig) {
      return used(sig);
    },
    async completeOrder(orderId, userId, signature) {
      const o = s.orders.get(orderId);
      if (!o || o.userId !== userId) return "not_pending";
      if (o.status === "confirmed") return o.signature === signature ? "already_confirmed" : "not_pending";
      if (o.status !== "pending") return "not_pending";
      if (used(signature)) return "signature_used";
      o.status = "confirmed";
      o.signature = signature;
      const createdAt = Math.floor(Date.now() / 1000);
      if (o.kind === "copy") {
        const id = randomUUID();
        s.copies.set(id, {
          id,
          userId,
          orderId,
          leaderTradeId: o.leaderTradeId!,
          marketId: o.marketId,
          side: o.side,
          amountUsdc: o.amountUsdc,
          feeUsdc: o.feeUsdc,
          shares: o.shares,
          signature,
          status: "confirmed",
          createdAt,
        });
      } else {
        const id = randomUUID();
        s.claims.set(id, {
          id,
          userId,
          orderId,
          marketId: o.marketId,
          side: o.side,
          shares: o.shares,
          signature,
          createdAt,
        });
      }
      return "ok";
    },
    async failOrder(orderId) {
      const o = s.orders.get(orderId);
      if (o && o.status === "pending") o.status = "failed";
    },
    async markReported(orderId) {
      for (const c of s.copies.values()) if (c.orderId === orderId) c.status = "reported";
    },
    async listCopies(userId, limit) {
      return [...s.copies.values()]
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((c): RecordedCopy => ({
          id: c.id,
          leaderTradeId: c.leaderTradeId,
          marketId: c.marketId,
          side: c.side,
          amountUsdc: c.amountUsdc,
          feeUsdc: c.feeUsdc,
          shares: c.shares,
          signature: c.signature,
          status: c.status,
          createdAt: c.createdAt,
        }));
    },
    async listClaims(userId, limit) {
      return [...s.claims.values()]
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((c): RecordedClaim => ({
          id: c.id,
          marketId: c.marketId,
          side: c.side,
          shares: c.shares,
          signature: c.signature,
          createdAt: c.createdAt,
        }));
    },
  };
}

export function getSharedMemoryCopyStore(): CopyStore {
  const g = globalThis as unknown as { __copycallCopyStore?: CopyStore };
  return (g.__copycallCopyStore ??= createMemoryCopyStore());
}
