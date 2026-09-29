/**
 * Storage interface for app data (markets, trades, positions, stats, and in
 * later steps follows, settings, Telegram links and alerts). Two implementations:
 *  - lib/data-store-supabase.ts (real; service role, see migrations)
 *  - lib/mock/data-store-memory.ts (MOCK_PANTA=true and tests only)
 * Times are unix seconds throughout.
 */
import type { Phase, Side } from "./schemas";
import type { TradeInsert, TradeSide } from "./trades";

export type MarketUpsert = { id: string; title: string; status: Phase };

export type StoredMarket = {
  id: string;
  address: string;
  title: string;
  status: Phase;
  outcome: Side | null;
  creatorWallet: string | null;
  creatorVerified: boolean;
};

export type StoredTrade = TradeInsert & { id: string };

export type StoredPosition = {
  marketId: string;
  side: TradeSide;
  shares: string;
  phase: Phase;
  outcome: Side | null;
  claimable: boolean;
  claimed: boolean;
};

export type StoredStats = {
  wallet: string;
  resolvedCalls: number;
  correctCalls: number;
  hitRate: number; // 0..1
  openPositions: number;
  lastActive: number | null;
  creatorTradeCount: number;
  recentResults: string; // "WWLW…" oldest -> newest, max 12
  updatedAt: number;
};

export type UserSettings = {
  maxStakeUsdc: string; // decimal string, 2 dp
  slippageBps: number; // 0..500 (hard max enforced in zod AND a DB check)
  alertsEnabled: boolean;
  telegramLinked: boolean;
};

export type SettingsUpdate = Pick<UserSettings, "maxStakeUsdc" | "slippageBps" | "alertsEnabled">;

export type AlertSubscription = {
  userId: string;
  leaderWallet: string;
  followedAt: number;
  chatId: number | null; // null = Telegram not linked
};

export type AlertStatus = "pending" | "sent" | "logged" | "failed" | "skipped";

export interface DataStore {
  // ---- markets
  /** Insert or update id/address/title/status. Never touches outcome or creator fields. */
  upsertMarkets(rows: MarketUpsert[]): Promise<void>;
  /** Markets whose tape still needs pulling (not final), least recently synced first. */
  marketsNeedingTrades(limit: number): Promise<{ id: string; status: Phase }[]>;
  /** Record a tape pull; `final` = the market was resolved/cancelled at the time. */
  markTradesSynced(marketId: string, final: boolean, nowSec: number): Promise<void>;
  /** Markets with no cached creator that were never checked (or last checked before `recheckBeforeSec`). */
  marketsNeedingCreator(limit: number, recheckBeforeSec: number): Promise<string[]>;
  /**
   * Cache a creator lookup (creator_verified stays false until the TODO in
   * lib/solana.ts is resolved). A non-null creator also flags that wallet's
   * trades in the market as creator trades. null = looked up, not found.
   */
  setMarketCreator(marketId: string, creator: string | null, nowSec: number): Promise<void>;
  /** creator_wallet for the given markets (only those that have one). */
  getCreators(marketIds: string[]): Promise<Record<string, string>>;
  /** Set markets.outcome once (Panta market rows have no outcome; it comes from resolved positions). */
  setMarketOutcome(marketId: string, outcome: Side): Promise<void>;

  // ---- trades
  /** Insert trades, skipping any signature already stored. Returns only the rows actually inserted. */
  insertTrades(rows: TradeInsert[]): Promise<StoredTrade[]>;
  /** A wallet's stored trades, newest first. */
  tradesForWallet(wallet: string, limit: number): Promise<StoredTrade[]>;

  // ---- positions + stats
  /** Tracked wallets (seen in a stored trade), stalest stats first. */
  walletsToRefresh(limit: number): Promise<string[]>;
  /** Replace a wallet's positions snapshot atomically. */
  replacePositions(wallet: string, rows: StoredPosition[]): Promise<void>;
  upsertTraderStats(row: StoredStats): Promise<void>;

  // ---- reads for pages and public API (never call Panta on a page load)
  /** Wallets with >= minResolved resolved calls, by hit rate, then resolved calls, then wallet. */
  leaderboard(minResolved: number, limit: number): Promise<StoredStats[]>;
  getTraderStats(wallet: string): Promise<StoredStats | null>;
  positionsForWallet(wallet: string): Promise<StoredPosition[]>;
  getMarkets(ids: string[]): Promise<StoredMarket[]>;
  /** Newest stored trades across all wallets (for the tape). */
  recentTrades(limit: number): Promise<StoredTrade[]>;
  /** Headline counts. callers = wallets with stats. */
  counts(): Promise<{ markets: number; callers: number; trades: number; resolved: number }>;
  /** Most recent trader_stats refresh (unix seconds), or null before the first sync. */
  lastSyncedAt(): Promise<number | null>;

  // ---- follows (user_id from a verified session only)
  /** Returns false if already following. */
  follow(userId: string, leaderWallet: string): Promise<boolean>;
  /** Returns false if not following. */
  unfollow(userId: string, leaderWallet: string): Promise<boolean>;
  listFollows(userId: string): Promise<{ wallet: string; createdAt: number }[]>;

  // ---- settings (users row)
  getSettings(userId: string): Promise<UserSettings | null>;
  updateSettings(userId: string, s: SettingsUpdate): Promise<UserSettings>;

  // ---- Telegram linking (codes are stored as sha256 hex, never in clear)
  /** Replace any previous code for this user with a new one. */
  createLinkCode(userId: string, codeHash: string, expiresAtSec: number): Promise<void>;
  /** Atomically consume a code (single use, unexpired) and link the chat. Returns the user id or null. */
  linkTelegramChat(codeHash: string, chatId: number): Promise<string | null>;
  /** /stop: turn alerts off for the user(s) linked to this chat. Returns how many. */
  pauseAlertsForChat(chatId: number): Promise<number>;

  // ---- alerts
  /** Follows of users with alerts enabled. */
  alertSubscriptions(): Promise<AlertSubscription[]>;
  tradesBySignatures(signatures: string[]): Promise<StoredTrade[]>;
  /** Create alerts, skipping (user, trade) pairs that already exist. Returns only new ones. */
  createAlerts(rows: { userId: string; tradeId: string }[]): Promise<{ id: string; userId: string; tradeId: string }[]>;
  setAlertStatus(id: string, status: AlertStatus, sentAtSec: number | null): Promise<void>;
}
