import "server-only";
/**
 * Read models for pages and the public API. Everything comes from our own
 * store (filled by the cron job), never from Panta on a page load
 * (hard requirement 9). Titles are cleaned and truncated here (addendum G).
 */
import type { StoredStats } from "./data-store";
import { ensureMockData, getDataStore } from "./data";
import { getMinResolvedCalls, isMockMode } from "./env";
import { FIXTURE_NOW } from "./leaderboard-preview";
import { safeTitle } from "./text";
import type { LeaderRow, ProfileTrade, StreakResult, TapeItem, TraderProfile } from "./view-types";

/** "Now" for relative times: the fixture clock in mock mode, else the real clock. */
export function displayNowSec(): number {
  return isMockMode() ? FIXTURE_NOW : Math.floor(Date.now() / 1000);
}

const lower = (s: "YES" | "NO") => (s === "YES" ? "yes" : "no") as "yes" | "no";

function toLeaderRow(s: StoredStats, rank: number): LeaderRow {
  return {
    rank,
    wallet: s.wallet,
    resolvedCalls: s.resolvedCalls,
    correctCalls: s.correctCalls,
    hitRate: s.hitRate,
    openPositions: s.openPositions,
    lastActive: s.lastActive,
    creatorTradeCount: s.creatorTradeCount,
    creatorVerified: false, // getMarketCreator() is unverified until its TODO is resolved
    streak: s.recentResults.split("").filter((c): c is StreakResult => c === "W" || c === "L"),
  };
}

/** Ranked leaderboard: only wallets with >= MIN_RESOLVED_CALLS resolved positions. */
export async function getLeaderboard(limit = 50): Promise<{ rows: LeaderRow[]; minResolved: number; updatedAt: number | null }> {
  await ensureMockData();
  const store = getDataStore();
  const minResolved = getMinResolvedCalls();
  const [stats, updatedAt] = await Promise.all([store.leaderboard(minResolved, limit), store.lastSyncedAt()]);
  return { rows: stats.map((s, i) => toLeaderRow(s, i + 1)), minResolved, updatedAt };
}

export async function getTape(limit = 14): Promise<TapeItem[]> {
  await ensureMockData();
  const store = getDataStore();
  const trades = await store.recentTrades(limit);
  const markets = new Map((await store.getMarkets([...new Set(trades.map((t) => t.marketId))])).map((m) => [m.id, m]));
  return trades.map((t) => ({
    signature: t.signature,
    wallet: t.wallet,
    side: lower(t.side),
    shares: Number(t.shares).toFixed(2),
    title: safeTitle(markets.get(t.marketId)?.title),
    blockTime: t.blockTime,
    isCreatorTrade: t.isCreatorTrade,
  }));
}

export async function getCounts() {
  await ensureMockData();
  return getDataStore().counts();
}

/** Profile for /trader/[wallet]; null if we have never seen the wallet. `wallet` must already be validated. */
export async function getTraderProfile(wallet: string): Promise<TraderProfile | null> {
  await ensureMockData();
  const store = getDataStore();
  const minResolved = getMinResolvedCalls();
  const [stats, trades, positions] = await Promise.all([
    store.getTraderStats(wallet),
    store.tradesForWallet(wallet, 12),
    store.positionsForWallet(wallet),
  ]);
  if (!stats && trades.length === 0) return null;

  const open = positions.filter((p) => p.phase === "primary" || p.phase === "secondary");
  const ids = [...new Set([...trades.map((t) => t.marketId), ...open.map((p) => p.marketId)])];
  const markets = new Map((await store.getMarkets(ids)).map((m) => [m.id, m]));

  let rank = 0;
  if (stats && stats.resolvedCalls >= minResolved) {
    const board = await store.leaderboard(minResolved, 1000);
    rank = board.findIndex((s) => s.wallet === wallet) + 1;
  }

  const recent: ProfileTrade[] = trades.map((t) => ({
    id: t.id,
    title: safeTitle(markets.get(t.marketId)?.title),
    side: lower(t.side),
    shares: Number(t.shares).toFixed(2),
    blockTime: t.blockTime,
    isPrimary: t.isPrimary,
    isCreatorTrade: t.isCreatorTrade,
    creatorVerified: false,
    marketStatus: markets.get(t.marketId)?.status ?? null,
  }));

  return {
    wallet,
    stats: stats ? toLeaderRow(stats, rank) : null,
    minResolved,
    trades: recent,
    openPositions: open.map((p) => ({
      marketId: p.marketId,
      title: safeTitle(markets.get(p.marketId)?.title),
      side: lower(p.side),
      shares: Number(p.shares).toFixed(2),
      phase: p.phase,
    })),
    updatedAt: stats?.updatedAt ?? null,
  };
}
