/** In-memory CopyStore (MOCK_PANTA=true and tests only). Same contract as the Supabase store. */
import { randomUUID } from "node:crypto";
import { assertBootSafe, isVercelProduction } from "../boot";
import type { CopyStore, PendingOrder, RecordedClaim, RecordedCopy, ReportJob } from "../copy-store";

/** Overridable clock (tests move time forward to exercise backoff). */
let clockMs: () => number = () => Date.now();
export function setMemoryCopyClock(fn: (() => number) | null) {
  clockMs = fn ?? (() => Date.now());
}
const nowSec = () => Math.floor(clockMs() / 1000);

/** Report bookkeeping, like the copies/claims report_* columns (migration 0010). */
type ReportCols = {
  reportedAt?: number | null;
  reportAttempts?: number;
  reportLastAttemptAt?: number | null;
  reportError?: string | null;
};

export type CopyMemoryState = {
  cache: Map<string, { value: unknown; expiresAt: number }>;
  orders: Map<string, PendingOrder>;
  copies: Map<string, RecordedCopy & { userId: string; orderId: string } & ReportCols>;
  claims: Map<string, RecordedClaim & { userId: string; orderId: string } & ReportCols>;
  /** G-02: sweep attempts and a logical "last swept" clock per order. */
  sweep: Map<string, { attempts: number; at: number }>;
  sweepClock: number;
  /** G-03: broadcasts of the same signed bytes per order. */
  sends: Map<string, number>;
};

export function createCopyMemoryState(): CopyMemoryState {
  return {
    cache: new Map(),
    orders: new Map(),
    copies: new Map(),
    claims: new Map(),
    sweep: new Map(),
    sweepClock: 0,
    sends: new Map(),
  };
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
      const row: PendingOrder = { ...o, id: randomUUID(), status: "pending", signature: null, broadcastSignature: null, reviewFlag: null };
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
    async flagForReview(orderId, flag) {
      const o = s.orders.get(orderId);
      if (!o) return false;
      o.reviewFlag = flag;
      return true;
    },
    async completeOrder(orderId, userId, signature, opts) {
      // No await inside: runs to completion, like complete_order's row lock.
      const o = s.orders.get(orderId);
      if (!o || o.userId !== userId) return "not_pending";
      if (o.status === "confirmed") return o.signature === signature ? "already_confirmed" : "not_pending";
      if (o.status === "failed" && !opts?.allowFailed) return "not_pending";
      if (o.status !== "pending" && o.status !== "failed") return "not_pending";
      if ([...s.copies.values(), ...s.claims.values()].some((r) => r.orderId === orderId)) return "not_pending";
      if (used(signature)) return "signature_used";
      o.status = "confirmed";
      o.signature = signature;
      const createdAt = nowSec();
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
    async noteBroadcast(orderId, signature) {
      const o = s.orders.get(orderId);
      if (!o || o.status !== "pending") return false;
      if (o.broadcastSignature === null) o.broadcastSignature = signature;
      return o.broadcastSignature === signature;
    },
    async claimBroadcastSweep(p) {
      const due = [...s.orders.values()]
        .filter(
          (o) =>
            o.status === "pending" &&
            o.broadcastSignature !== null &&
            o.createdAt < p.createdBefore &&
            o.createdAt > p.createdAfter &&
            (s.sweep.get(o.id)?.attempts ?? 0) < p.maxAttempts,
        )
        .sort((a, b) => {
          const la = s.sweep.get(a.id)?.at ?? -1;
          const lb = s.sweep.get(b.id)?.at ?? -1;
          return la !== lb ? la - lb : a.createdAt - b.createdAt;
        })
        .slice(0, Math.min(Math.max(p.limit, 0), 100));
      return due.map((o) => {
        const prev = s.sweep.get(o.id);
        const next = { attempts: (prev?.attempts ?? 0) + 1, at: ++s.sweepClock };
        s.sweep.set(o.id, next);
        return { order: { ...o }, attempts: next.attempts };
      });
    },
    async claimNextBroadcastSweep(p) {
      const ex = new Set(p.exclude);
      const due = [...s.orders.values()]
        .filter(
          (o) =>
            o.status === "pending" &&
            o.broadcastSignature !== null &&
            !ex.has(o.id) &&
            o.createdAt < p.createdBefore &&
            o.createdAt > p.createdAfter &&
            (s.sweep.get(o.id)?.attempts ?? 0) < p.maxAttempts,
        )
        .sort((a, b) => {
          const la = s.sweep.get(a.id)?.at ?? -1;
          const lb = s.sweep.get(b.id)?.at ?? -1;
          return la !== lb ? la - lb : a.createdAt - b.createdAt;
        });
      const o = due[0];
      if (!o) return null;
      const next = { attempts: (s.sweep.get(o.id)?.attempts ?? 0) + 1, at: ++s.sweepClock };
      s.sweep.set(o.id, next);
      return { order: { ...o }, attempts: next.attempts };
    },
    async listUnbroadcastBefore(createdBefore, limit) {
      return [...s.orders.values()]
        .filter((o) => o.status === "pending" && o.broadcastSignature === null && o.createdAt < createdBefore)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, Math.max(0, Math.min(100, limit)))
        .map((o) => ({ ...o }));
    },
    async failIfUnbroadcast(orderId) {
      const o = s.orders.get(orderId);
      if (!o || o.status !== "pending" || o.broadcastSignature !== null) return false;
      o.status = "failed";
      return true;
    },
    async noteSendAttempt(orderId, max) {
      const o = s.orders.get(orderId);
      const n = s.sends.get(orderId) ?? 0;
      if (!o || o.status !== "pending" || n >= max) return false;
      s.sends.set(orderId, n + 1);
      return true;
    },
    async markReported(orderId) {
      const at = nowSec();
      for (const c of s.copies.values())
        if (c.orderId === orderId) {
          c.status = "reported";
          c.reportedAt = at;
        }
      for (const c of s.claims.values()) if (c.orderId === orderId) c.reportedAt = at;
    },
    async isReported(orderId) {
      return [...s.copies.values(), ...s.claims.values()].some((r) => r.orderId === orderId && !!r.reportedAt);
    },
    async recordReportFailure(orderId, code, stop, maxAttempts) {
      for (const r of [...s.copies.values(), ...s.claims.values()]) {
        if (r.orderId !== orderId || r.reportedAt) continue;
        r.reportError = /^[A-Z_]{1,40}$/.test(code) ? code : "ERROR";
        r.reportAttempts = stop ? Math.max(r.reportAttempts ?? 0, maxAttempts) : Math.max(r.reportAttempts ?? 0, 1);
        r.reportLastAttemptAt = nowSec();
      }
    },
    async claimReportRetries(p) {
      const now = nowSec();
      const lim = Math.min(Math.max(p.limit, 0), 100);
      const due = (r: ReportCols & { createdAt: number }) => {
        const n = r.reportAttempts ?? 0;
        return (
          !r.reportedAt &&
          n < p.maxAttempts &&
          r.createdAt > now - p.maxAgeSec &&
          (r.reportLastAttemptAt == null || r.reportLastAttemptAt <= now - p.baseGapSec * 2 ** Math.max(n - 1, 0))
        );
      };
      const jobs: ReportJob[] = [];
      type Row = ReportCols & { createdAt: number; orderId: string; signature: string; marketId: string; status?: string };
      const take = (rows: Row[], kind: ReportJob["kind"]) => {
        const picked = rows
          .filter((r) => due(r) && (kind === "claim" || r.status === "confirmed"))
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, lim);
        for (const r of picked) {
          const o = s.orders.get(r.orderId);
          if (!o) continue;
          r.reportAttempts = (r.reportAttempts ?? 0) + 1;
          r.reportLastAttemptAt = now;
          jobs.push({
            kind,
            orderId: r.orderId,
            signature: r.signature,
            wallet: o.wallet,
            marketId: r.marketId,
            quoteId: o.quoteId,
            attempts: r.reportAttempts,
          });
        }
      };
      take([...s.copies.values()], "copy");
      take([...s.claims.values()], "claim");
      return jobs;
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
