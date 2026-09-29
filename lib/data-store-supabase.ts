import "server-only";
/**
 * Supabase-backed DataStore (service role; see supabase/migrations).
 * Every error is rethrown as a generic message: no SQL, keys or row data leak
 * into responses or logs.
 */
import type { DataStore, StoredMarket, StoredStats, StoredTrade } from "./data-store";
import { getDb } from "./db";
import type { Phase, Side } from "./schemas";
import type { TradeInsert, TradeSide } from "./trades";

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const sec = (v: string | null | undefined) => (v ? Math.floor(Date.parse(v) / 1000) : null);

function fail(what: string): never {
  throw new Error(`Database error: ${what}`);
}

type TradeRow = {
  id: string;
  signature: string;
  market_id: string;
  wallet: string;
  side: TradeSide;
  shares: string | number;
  fee: string | number;
  block_time: string | null;
  is_primary: boolean;
  is_creator_trade: boolean;
  panta_id: string | null;
};
export const TRADE_COLUMNS = "id, signature, market_id, wallet, side, shares, fee, block_time, is_primary, is_creator_trade, panta_id";

export function toStoredTrade(r: TradeRow): StoredTrade {
  return {
    id: r.id,
    signature: r.signature,
    marketId: r.market_id,
    wallet: r.wallet,
    side: r.side,
    shares: String(r.shares),
    fee: String(r.fee),
    blockTime: sec(r.block_time),
    isPrimary: r.is_primary,
    isCreatorTrade: r.is_creator_trade,
    pantaId: r.panta_id ?? "",
  };
}

type MarketRow = {
  id: string;
  address: string;
  title: string;
  status: Phase;
  outcome: Side | null;
  creator_wallet: string | null;
  creator_verified: boolean;
};
export const MARKET_COLUMNS = "id, address, title, status, outcome, creator_wallet, creator_verified";

export function toStoredMarket(r: MarketRow): StoredMarket {
  return {
    id: r.id,
    address: r.address,
    title: r.title,
    status: r.status,
    outcome: r.outcome,
    creatorWallet: r.creator_wallet,
    creatorVerified: r.creator_verified,
  };
}

type StatsRow = {
  wallet: string;
  resolved_calls: number;
  correct_calls: number;
  hit_rate: string | number;
  open_positions: number;
  last_active: string | null;
  creator_trade_count: number;
  recent_results: string;
  updated_at: string;
};
export const STATS_COLUMNS =
  "wallet, resolved_calls, correct_calls, hit_rate, open_positions, last_active, creator_trade_count, recent_results, updated_at";

export function toStoredStats(r: StatsRow): StoredStats {
  return {
    wallet: r.wallet,
    resolvedCalls: r.resolved_calls,
    correctCalls: r.correct_calls,
    hitRate: Number(r.hit_rate),
    openPositions: r.open_positions,
    lastActive: sec(r.last_active),
    creatorTradeCount: r.creator_trade_count,
    recentResults: r.recent_results,
    updatedAt: sec(r.updated_at) ?? 0,
  };
}

function tradeRow(t: TradeInsert) {
  return {
    signature: t.signature,
    market_id: t.marketId,
    wallet: t.wallet,
    side: t.side,
    shares: t.shares,
    fee: t.fee,
    block_time: t.blockTime === null ? null : iso(t.blockTime),
    is_primary: t.isPrimary,
    is_creator_trade: t.isCreatorTrade,
    panta_id: t.pantaId,
  };
}

export const supabaseDataStore: DataStore = {
  async upsertMarkets(rows) {
    if (!rows.length) return;
    const { error } = await getDb()
      .from("markets")
      .upsert(
        rows.map((r) => ({ id: r.id, address: r.id, title: r.title, status: r.status, updated_at: new Date().toISOString() })),
        { onConflict: "id" },
      );
    if (error) fail("upsert markets");
  },

  async marketsNeedingTrades(limit) {
    const { data, error } = await getDb()
      .from("markets")
      .select("id, status")
      .eq("trades_final", false)
      .order("trades_synced_at", { ascending: true, nullsFirst: true })
      .order("id")
      .limit(limit);
    if (error) fail("markets needing trades");
    return (data ?? []) as { id: string; status: Phase }[];
  },

  async markTradesSynced(id, final, nowSec) {
    const { error } = await getDb().from("markets").update({ trades_synced_at: iso(nowSec), trades_final: final }).eq("id", id);
    if (error) fail("mark trades synced");
  },

  async marketsNeedingCreator(limit, recheckBeforeSec) {
    const { data, error } = await getDb()
      .from("markets")
      .select("id")
      .is("creator_wallet", null)
      .or(`creator_checked_at.is.null,creator_checked_at.lt.${iso(recheckBeforeSec)}`)
      .order("id")
      .limit(limit);
    if (error) fail("markets needing creator");
    return (data ?? []).map((r) => r.id as string);
  },

  async setMarketCreator(id, creator, nowSec) {
    const db = getDb();
    const patch = creator
      ? { creator_wallet: creator, creator_verified: false, creator_checked_at: iso(nowSec) }
      : { creator_checked_at: iso(nowSec) };
    const { error } = await db.from("markets").update(patch).eq("id", id);
    if (error) fail("set market creator");
    if (creator) {
      const r = await db.from("trades").update({ is_creator_trade: true }).eq("market_id", id).eq("wallet", creator);
      if (r.error) fail("flag creator trades");
    }
  },

  async getCreators(ids) {
    if (!ids.length) return {};
    const { data, error } = await getDb().from("markets").select("id, creator_wallet").in("id", ids).not("creator_wallet", "is", null);
    if (error) fail("get creators");
    return Object.fromEntries((data ?? []).map((r) => [r.id as string, r.creator_wallet as string]));
  },

  async setMarketOutcome(id, outcome) {
    const { error } = await getDb().from("markets").update({ outcome }).eq("id", id).is("outcome", null);
    if (error) fail("set market outcome");
  },

  async insertTrades(rows) {
    if (!rows.length) return [];
    // ON CONFLICT (signature) DO NOTHING RETURNING: only new rows come back.
    const { data, error } = await getDb()
      .from("trades")
      .upsert(rows.map(tradeRow), { onConflict: "signature", ignoreDuplicates: true })
      .select(TRADE_COLUMNS);
    if (error) fail("insert trades");
    return ((data ?? []) as TradeRow[]).map(toStoredTrade);
  },

  async tradesForWallet(wallet, limit) {
    const { data, error } = await getDb()
      .from("trades")
      .select(TRADE_COLUMNS)
      .eq("wallet", wallet)
      .order("block_time", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) fail("trades for wallet");
    return ((data ?? []) as TradeRow[]).map(toStoredTrade);
  },

  async walletsToRefresh(limit) {
    const { data, error } = await getDb().rpc("wallets_to_refresh", { p_limit: limit });
    if (error) fail("wallets to refresh");
    return (data ?? []) as string[];
  },

  async replacePositions(wallet, rows) {
    const { error } = await getDb().rpc("replace_positions", {
      p_wallet: wallet,
      p_rows: rows.map((r) => ({
        market_id: r.marketId,
        side: r.side,
        shares: r.shares,
        phase: r.phase,
        outcome: r.outcome,
        claimable: r.claimable,
        claimed: r.claimed,
      })),
    });
    if (error) fail("replace positions");
  },

  async upsertTraderStats(s) {
    const { error } = await getDb()
      .from("trader_stats")
      .upsert(
        {
          wallet: s.wallet,
          resolved_calls: s.resolvedCalls,
          correct_calls: s.correctCalls,
          hit_rate: s.hitRate.toFixed(5),
          open_positions: s.openPositions,
          last_active: s.lastActive === null ? null : iso(s.lastActive),
          creator_trade_count: s.creatorTradeCount,
          recent_results: s.recentResults,
          updated_at: iso(s.updatedAt),
        },
        { onConflict: "wallet" },
      );
    if (error) fail("upsert trader stats");
  },
};
