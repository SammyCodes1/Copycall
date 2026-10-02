import "server-only";
/**
 * Supabase-backed CopyStore (service role; migration 0006). Errors are
 * rethrown as generic messages so no SQL or row data leaks.
 */
import type { CompleteResult, CopyStore, PendingOrder, RecordedClaim, RecordedCopy, ReportJob } from "./copy-store";
import { getDb } from "./db";
import type { TradeSide } from "./trades";

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const sec = (v: string) => Math.floor(Date.parse(v) / 1000);
const dec = (v: string | number, dp: number) => Number(v).toFixed(dp);

function fail(what: string): never {
  throw new Error(`Database error: ${what}`);
}

type OrderRow = {
  id: string;
  user_id: string;
  wallet: string;
  kind: "copy" | "claim";
  leader_trade_id: string | null;
  market_id: string;
  side: TradeSide;
  amount_usdc: string | number;
  fee_usdc: string | number;
  fee_model: PendingOrder["feeModel"];
  max_usdc_out: string | number | null;
  shares: string | number;
  quote_id: string | null;
  panta_order_id: string | null;
  message_hash: string;
  message_base64: string;
  last_valid_block_height: number | string | null;
  created_at: string;
  expires_at: string;
  status: PendingOrder["status"];
  signature: string | null;
};

function toOrder(r: OrderRow): PendingOrder {
  return {
    id: r.id,
    userId: r.user_id,
    wallet: r.wallet,
    kind: r.kind,
    leaderTradeId: r.leader_trade_id,
    marketId: r.market_id,
    side: r.side,
    amountUsdc: dec(r.amount_usdc, 2),
    feeUsdc: dec(r.fee_usdc, 2),
    feeModel: r.fee_model ?? null,
    maxUsdcOut: r.max_usdc_out === null || r.max_usdc_out === undefined ? null : dec(r.max_usdc_out, 6),
    shares: dec(r.shares, 2),
    quoteId: r.quote_id,
    pantaOrderId: r.panta_order_id,
    messageHash: r.message_hash,
    messageBase64: r.message_base64,
    lastValidBlockHeight: r.last_valid_block_height === null ? null : Number(r.last_valid_block_height),
    createdAt: sec(r.created_at),
    expiresAt: sec(r.expires_at),
    status: r.status,
    signature: r.signature,
  };
}

export const supabaseCopyStore: CopyStore = {
  async cacheGet<T>(key: string, nowSec: number) {
    const { data, error } = await getDb().from("api_cache").select("value, expires_at").eq("key", key).maybeSingle();
    if (error) fail("cache get");
    if (!data || sec(data.expires_at as string) <= nowSec) return null;
    return data.value as T;
  },
  async cachePut(key, value, expiresAt) {
    const { error } = await getDb()
      .from("api_cache")
      .upsert({ key, value, expires_at: iso(expiresAt) }, { onConflict: "key" });
    if (error) fail("cache put");
    // Opportunistic cleanup of expired rows (cheap, indexed).
    await getDb().from("api_cache").delete().lt("expires_at", new Date().toISOString());
  },
  async cacheDelete(key) {
    const { error } = await getDb().from("api_cache").delete().eq("key", key);
    if (error) fail("cache delete");
  },

  async createPendingOrder(o) {
    const { data, error } = await getDb()
      .from("pending_orders")
      .insert({
        user_id: o.userId,
        wallet: o.wallet,
        kind: o.kind,
        leader_trade_id: o.leaderTradeId,
        market_id: o.marketId,
        side: o.side,
        amount_usdc: o.amountUsdc,
        fee_usdc: o.feeUsdc,
        fee_model: o.feeModel,
        max_usdc_out: o.maxUsdcOut,
        shares: o.shares,
        quote_id: o.quoteId,
        panta_order_id: o.pantaOrderId,
        message_hash: o.messageHash,
        message_base64: o.messageBase64,
        last_valid_block_height: o.lastValidBlockHeight,
        created_at: iso(o.createdAt),
        expires_at: iso(o.expiresAt),
      })
      .select("*")
      .single();
    if (error || !data) fail("create pending order");
    return toOrder(data as OrderRow);
  },
  async getPendingOrder(id) {
    const { data, error } = await getDb().from("pending_orders").select("*").eq("id", id).maybeSingle();
    if (error) fail("get pending order");
    return data ? toOrder(data as OrderRow) : null;
  },
  async signatureUsed(signature) {
    const db = getDb();
    const checks = await Promise.all(
      ["pending_orders", "copies", "claims"].map((t) =>
        db.from(t).select("id", { count: "exact", head: true }).eq("signature", signature),
      ),
    );
    if (checks.some((c) => c.error)) fail("signature used");
    return checks.some((c) => (c.count ?? 0) > 0);
  },
  async completeOrder(orderId, userId, signature, opts) {
    const { data, error } = await getDb().rpc("complete_order", {
      p_order_id: orderId,
      p_user_id: userId,
      p_signature: signature,
      p_allow_failed: opts?.allowFailed === true,
    });
    if (error) fail("complete order");
    return data as CompleteResult;
  },
  async failOrder(orderId) {
    const { error } = await getDb()
      .from("pending_orders")
      .update({ status: "failed" })
      .eq("id", orderId)
      .eq("status", "pending");
    if (error) fail("fail order");
  },
  async markReported(orderId) {
    const db = getDb();
    const [a, b] = await Promise.all([
      db.from("copies").update({ status: "reported", reported_at: new Date().toISOString() }).eq("order_id", orderId),
      db.from("claims").update({ reported_at: new Date().toISOString() }).eq("order_id", orderId),
    ]);
    if (a.error || b.error) fail("mark reported");
  },
  async isReported(orderId) {
    const db = getDb();
    const [a, b] = await Promise.all([
      db.from("copies").select("reported_at").eq("order_id", orderId).maybeSingle(),
      db.from("claims").select("reported_at").eq("order_id", orderId).maybeSingle(),
    ]);
    if (a.error || b.error) fail("report status");
    return Boolean(a.data?.reported_at || b.data?.reported_at);
  },
  async recordReportFailure(orderId, code, stop, maxAttempts) {
    const { error } = await getDb().rpc("record_report_failure", {
      p_order_id: orderId,
      p_code: /^[A-Z_]{1,40}$/.test(code) ? code : "ERROR",
      p_stop: stop,
      p_max_attempts: maxAttempts,
    });
    if (error) fail("record report failure");
  },
  async claimReportRetries(p) {
    const { data, error } = await getDb().rpc("claim_report_retries", {
      p_limit: p.limit,
      p_max_attempts: p.maxAttempts,
      p_base_gap_sec: p.baseGapSec,
      p_max_age_sec: p.maxAgeSec,
    });
    if (error) fail("claim report retries");
    return ((data ?? []) as Record<string, unknown>[]).map(
      (r): ReportJob => ({
        kind: r.kind as ReportJob["kind"],
        orderId: String(r.order_id),
        signature: String(r.signature),
        wallet: String(r.wallet),
        marketId: String(r.market_id),
        quoteId: r.quote_id === null || r.quote_id === undefined ? null : String(r.quote_id),
        attempts: Number(r.attempts),
      }),
    );
  },
  async listCopies(userId, limit) {
    const { data, error } = await getDb()
      .from("copies")
      .select("id, leader_trade_id, market_id, side, amount_usdc, fee_usdc, shares, signature, status, created_at")
      .eq("user_id", userId)
      .in("status", ["confirmed", "reported"])
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) fail("list copies");
    return (data ?? []).map((r): RecordedCopy => ({
      id: r.id,
      leaderTradeId: r.leader_trade_id,
      marketId: r.market_id,
      side: r.side,
      amountUsdc: dec(r.amount_usdc, 2),
      feeUsdc: r.fee_usdc === null || r.fee_usdc === undefined ? null : dec(r.fee_usdc, 2),
      shares: dec(r.shares ?? 0, 2),
      signature: r.signature,
      status: r.status,
      createdAt: sec(r.created_at),
    }));
  },
  async listClaims(userId, limit) {
    const { data, error } = await getDb()
      .from("claims")
      .select("id, market_id, side, shares, signature, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) fail("list claims");
    return (data ?? []).map((r): RecordedClaim => ({
      id: r.id,
      marketId: r.market_id,
      side: r.side,
      shares: dec(r.shares, 2),
      signature: r.signature,
      createdAt: sec(r.created_at),
    }));
  },
};
