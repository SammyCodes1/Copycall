import "server-only";
/**
 * Supabase-backed DataStore (service role; see supabase/migrations).
 * Every error is rethrown as a generic message: no SQL, keys or row data leak
 * into responses or logs.
 */
import type { DataStore, FollowResult, StoredMarket, StoredStats, StoredTrade, UserSettings } from "./data-store";
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
export const TRADE_COLUMNS =
  "id, signature, market_id, wallet, side, shares, fee, block_time, is_primary, is_creator_trade, panta_id";

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
        rows.map((r) => ({
          id: r.id,
          address: r.id,
          title: r.title,
          status: r.status,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "id" },
      );
    if (error) fail("upsert markets");
  },

  async marketsNeedingTrades(limit, nowSec) {
    const { data, error } = await getDb().rpc("markets_needing_trades", { p_limit: limit, p_now: iso(nowSec) });
    if (error) fail("markets needing trades");
    return (data ?? []) as { id: string; status: Phase }[];
  },

  async markTradesSynced(id, final, nowSec) {
    const { error } = await getDb()
      .from("markets")
      .update({ trades_synced_at: iso(nowSec), trades_final: final })
      .eq("id", id);
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
    const { data, error } = await getDb()
      .from("markets")
      .select("id, creator_wallet")
      .in("id", ids)
      .not("creator_wallet", "is", null);
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

  async recordSyncFailure(kind, key, nowSec) {
    const { error } = await getDb().rpc("record_sync_failure", { p_kind: kind, p_key: key, p_now: iso(nowSec) });
    if (error) fail("record sync failure");
  },

  async clearSyncFailure(kind, key) {
    const { error } = await getDb().from("sync_failures").delete().eq("kind", kind).eq("key", key);
    if (error) fail("clear sync failure");
  },

  async walletsToRefresh(limit, nowSec) {
    const { data, error } = await getDb().rpc("wallets_to_refresh", { p_limit: limit, p_now: iso(nowSec) });
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

  async leaderboard(minResolved, limit) {
    const { data, error } = await getDb()
      .from("trader_stats")
      .select(STATS_COLUMNS)
      .gte("resolved_calls", minResolved)
      .order("hit_rate", { ascending: false })
      .order("resolved_calls", { ascending: false })
      .order("wallet")
      .limit(limit);
    if (error) fail("leaderboard");
    return ((data ?? []) as StatsRow[]).map(toStoredStats);
  },

  async traderRank(wallet, minResolved) {
    const { data, error } = await getDb().rpc("trader_rank", { p_wallet: wallet, p_min_resolved: minResolved });
    if (error) fail("trader rank");
    return typeof data === "number" ? data : null;
  },

  async getTraderStats(wallet) {
    const { data, error } = await getDb().from("trader_stats").select(STATS_COLUMNS).eq("wallet", wallet).maybeSingle();
    if (error) fail("trader stats");
    return data ? toStoredStats(data as StatsRow) : null;
  },

  async positionsForWallet(wallet) {
    const { data, error } = await getDb()
      .from("positions")
      .select("market_id, side, shares, phase, outcome, claimable, claimed")
      .eq("wallet", wallet);
    if (error) fail("positions");
    return (data ?? []).map((r) => ({
      marketId: r.market_id as string,
      side: r.side as TradeSide,
      shares: String(r.shares),
      phase: r.phase as Phase,
      outcome: (r.outcome as Side | null) ?? null,
      claimable: !!r.claimable,
      claimed: !!r.claimed,
    }));
  },

  async getMarkets(ids) {
    if (!ids.length) return [];
    const { data, error } = await getDb().from("markets").select(MARKET_COLUMNS).in("id", ids);
    if (error) fail("markets");
    return ((data ?? []) as MarketRow[]).map(toStoredMarket);
  },

  async recentTrades(limit) {
    const { data, error } = await getDb()
      .from("trades")
      .select(TRADE_COLUMNS)
      .order("block_time", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) fail("recent trades");
    return ((data ?? []) as TradeRow[]).map(toStoredTrade);
  },

  async counts() {
    const db = getDb();
    const head = { count: "exact" as const, head: true };
    const [m, c, t, r] = await Promise.all([
      db.from("markets").select("id", head),
      db.from("trader_stats").select("wallet", head),
      db.from("trades").select("id", head),
      db.from("markets").select("id", head).eq("status", "resolved"),
    ]);
    if (m.error || c.error || t.error || r.error) fail("counts");
    return { markets: m.count ?? 0, callers: c.count ?? 0, trades: t.count ?? 0, resolved: r.count ?? 0 };
  },

  async lastSyncedAt() {
    const { data, error } = await getDb()
      .from("trader_stats")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail("last synced");
    return data ? sec(data.updated_at as string) : null;
  },

  async follow(userId, wallet, max) {
    // One DB step under a row lock on the user (follow_capped): the cap can't be raced (B2-03).
    const { data, error } = await getDb().rpc("follow_capped", { p_user_id: userId, p_wallet: wallet, p_max: max });
    if (error || (data !== "followed" && data !== "already" && data !== "limit")) fail("follow");
    return data as FollowResult;
  },

  async unfollow(userId, wallet) {
    const { data, error } = await getDb()
      .from("follows")
      .delete()
      .eq("user_id", userId)
      .eq("leader_wallet", wallet)
      .select("leader_wallet");
    if (error) fail("unfollow");
    return (data ?? []).length > 0;
  },

  async listFollows(userId) {
    const { data, error } = await getDb()
      .from("follows")
      .select("leader_wallet, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) fail("list follows");
    return (data ?? []).map((r) => ({
      wallet: r.leader_wallet as string,
      createdAt: sec(r.created_at as string) ?? 0,
    }));
  },

  async getSettings(userId) {
    const { data, error } = await getDb().from("users").select(SETTINGS_COLUMNS).eq("id", userId).maybeSingle();
    if (error) fail("get settings");
    return data ? toSettings(data as SettingsRow) : null;
  },

  async updateSettings(userId, u) {
    const { data, error } = await getDb()
      .from("users")
      .update({ max_stake_usdc: u.maxStakeUsdc, slippage_bps: u.slippageBps, alerts_enabled: u.alertsEnabled })
      .eq("id", userId)
      .select(SETTINGS_COLUMNS)
      .single();
    if (error || !data) fail("update settings");
    return toSettings(data as SettingsRow);
  },

  async createLinkCode(userId, _wallet, codeHash, expiresAtSec) {
    const db = getDb();
    const del = await db.from("telegram_link_codes").delete().eq("user_id", userId);
    if (del.error) fail("clear link codes");
    const { error } = await db
      .from("telegram_link_codes")
      .insert({ code: codeHash, user_id: userId, expires_at: iso(expiresAtSec) });
    if (error) fail("create link code");
  },

  async peekLinkCode(codeHash) {
    const { data, error } = await getDb().rpc("peek_link_code", { p_code_hash: codeHash });
    if (error) fail("peek link code");
    const row = (data ?? [])[0] as { user_id: string; wallet: string } | undefined;
    return row ? { userId: row.user_id, wallet: row.wallet } : null;
  },

  async linkedWalletForChat(chatId) {
    const { data, error } = await getDb().rpc("linked_wallet_for_chat", { p_chat_id: chatId });
    if (error) fail("linked wallet for chat");
    return typeof data === "string" ? data : null;
  },

  async linkTelegramChat(codeHash, chatId) {
    const { data, error } = await getDb().rpc("link_telegram_chat", { p_code_hash: codeHash, p_chat_id: chatId });
    if (error) fail("link telegram chat");
    const r = (data ?? [])[0] as
      | {
          user_id: string;
          wallet: string;
          previous_user_id: string | null;
          previous_wallet: string | null;
          previous_chat_id: number | string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      userId: r.user_id,
      wallet: r.wallet,
      previousUserId: r.previous_user_id,
      previousWallet: r.previous_wallet,
      previousChatId: r.previous_chat_id === null ? null : Number(r.previous_chat_id),
    };
  },

  async pauseAlertsForChat(chatId) {
    const { data, error } = await getDb()
      .from("users")
      .update({ alerts_enabled: false })
      .eq("telegram_chat_id", chatId)
      .eq("alerts_enabled", true)
      .select("id");
    if (error) fail("pause alerts");
    return (data ?? []).length;
  },

  async alertSubscriptions() {
    const { data, error } = await getDb().rpc("alert_subscriptions");
    if (error) fail("alert subscriptions");
    return (
      (data ?? []) as {
        user_id: string;
        leader_wallet: string;
        followed_at: string;
        telegram_chat_id: number | string | null;
      }[]
    ).map((r) => ({
      userId: r.user_id,
      leaderWallet: r.leader_wallet,
      followedAt: sec(r.followed_at) ?? 0,
      chatId: r.telegram_chat_id === null ? null : Number(r.telegram_chat_id),
    }));
  },

  async tradesBySignatures(sigs) {
    if (!sigs.length) return [];
    const { data, error } = await getDb().from("trades").select(TRADE_COLUMNS).in("signature", sigs);
    if (error) fail("trades by signature");
    return ((data ?? []) as TradeRow[]).map(toStoredTrade);
  },

  async getTradeById(id) {
    const { data, error } = await getDb().from("trades").select(TRADE_COLUMNS).eq("id", id).maybeSingle();
    if (error) fail("trade by id");
    return data ? toStoredTrade(data as TradeRow) : null;
  },

  async createAlerts(rows) {
    if (!rows.length) return [];
    // ON CONFLICT (user_id, trade_id) DO NOTHING RETURNING: overlapping runs can't double-send.
    const { data, error } = await getDb()
      .from("alerts")
      .upsert(
        rows.map((r) => ({ user_id: r.userId, trade_id: r.tradeId, status: "pending" })),
        { onConflict: "user_id,trade_id", ignoreDuplicates: true },
      )
      .select("id, user_id, trade_id");
    if (error) fail("create alerts");
    return (data ?? []).map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      tradeId: r.trade_id as string,
    }));
  },

  async setAlertStatus(id, status, sentAtSec) {
    const { error } = await getDb().rpc("set_alert_status", {
      p_id: id,
      p_status: status,
      p_sent_at: sentAtSec === null ? null : iso(sentAtSec),
    });
    if (error) fail("set alert status");
  },

  async claimAlertRetries(p) {
    const { data, error } = await getDb().rpc("claim_alert_retries", {
      p_limit: p.limit,
      p_max_attempts: p.maxAttempts,
      p_max_age_sec: p.maxAgeSec,
      p_min_gap_sec: p.minGapSec,
    });
    if (error) fail("claim alert retries");
    return ((data ?? []) as { id: string; user_id: string; trade_id: string }[]).map((r) => ({
      id: r.id,
      userId: r.user_id,
      tradeId: r.trade_id,
    }));
  },
};

const SETTINGS_COLUMNS = "max_stake_usdc, slippage_bps, alerts_enabled, telegram_chat_id, telegram_unlinked_at";
type SettingsRow = {
  max_stake_usdc: string | number;
  slippage_bps: number;
  alerts_enabled: boolean;
  telegram_chat_id: number | string | null;
  telegram_unlinked_at: string | null;
};
function toSettings(r: SettingsRow): UserSettings {
  return {
    maxStakeUsdc: Number(r.max_stake_usdc).toFixed(2),
    slippageBps: r.slippage_bps,
    alertsEnabled: r.alerts_enabled,
    telegramLinked: r.telegram_chat_id !== null,
    telegramUnlinkedAt: r.telegram_chat_id === null ? sec(r.telegram_unlinked_at) : null,
  };
}
