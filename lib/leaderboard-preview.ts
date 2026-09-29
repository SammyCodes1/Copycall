import "server-only";
/**
 * Sample data for the landing page (batch 1), computed from the fixtures.
 * Everything here is always labelled "Sample data" in the UI so simulated data
 * is never presented as live Panta data (Panta Terms of Use).
 * Batch 2 replaces the leaderboard with trader_stats from Supabase.
 */
import creatorsJson from "@/fixtures/creators.json";
import marketsJson from "@/fixtures/markets.json";
import positionsJson from "@/fixtures/positions.json";
import tradesJson from "@/fixtures/trades.json";
import { getMinResolvedCalls } from "./env";
import type { PantaMarket, PantaPosition, PantaTradeRow, Side } from "./schemas";
import { safeTitle } from "./text";
import { computeTraderStats, rankTraders, type TraderStats } from "./stats";

/** "Now" for the fixtures, so relative times stay stable. */
export const FIXTURE_NOW = 1790553600;

const positions = positionsJson as unknown as Record<string, PantaPosition[]>;
const trades = tradesJson as unknown as PantaTradeRow[];
const markets = marketsJson as unknown as PantaMarket[];
const creators = creatorsJson as Record<string, string>;
const marketById = new Map(markets.map((m) => [m.marketId, m]));

export { safeTitle };

export type StreakResult = "W" | "L";

export type PreviewRow = TraderStats & {
  rank: number;
  creatorVerified: false;
  /** Most recent resolved calls, oldest -> newest (max 12). */
  streak: StreakResult[];
};

/** W/L sequence of a wallet's resolved positions, ordered by its last trade in each market. */
function streakFor(wallet: string, rows: PantaPosition[]): StreakResult[] {
  const lastTrade = new Map<string, number>();
  for (const t of trades) {
    if (t.wallet !== wallet || t.blockTime === null) continue;
    lastTrade.set(t.marketId, Math.max(lastTrade.get(t.marketId) ?? 0, t.blockTime));
  }
  return rows
    .filter((p) => p.phase === "resolved" && p.outcome)
    .map((p) => ({ t: lastTrade.get(p.marketId) ?? 0, r: (p.side === p.outcome ? "W" : "L") as StreakResult }))
    .sort((a, b) => a.t - b.t)
    .slice(-12)
    .map((x) => x.r);
}

export function getLeaderboardPreview(limit = 8): PreviewRow[] {
  const stats = Object.entries(positions).map(([wallet, rows]) => computeTraderStats(wallet, rows, trades, creators));
  return rankTraders(stats, getMinResolvedCalls())
    .slice(0, limit)
    .map((s, i) => ({
      ...s,
      rank: i + 1,
      creatorVerified: false as const,
      streak: streakFor(s.wallet, positions[s.wallet]),
    }));
}

export type TapeItem = {
  signature: string;
  wallet: string;
  side: Side;
  shares: string;
  title: string;
  blockTime: number | null;
  isCreatorTrade: boolean;
};

/** Most recent sample calls for the ticker tape. */
export function getSampleTape(limit = 14): TapeItem[] {
  return trades.slice(0, limit).map((t) => {
    const yes = Number(t.yesAmount);
    return {
      signature: t.signature,
      wallet: t.wallet,
      side: yes > 0 ? "yes" : "no",
      shares: Number(yes > 0 ? t.yesAmount : t.noAmount).toFixed(2),
      title: safeTitle(marketById.get(t.marketId)?.title ?? "Unknown market"),
      blockTime: t.blockTime,
      isCreatorTrade: creators[t.marketId] === t.wallet,
    };
  });
}

export type SampleCopy = {
  leader: string;
  leaderHitRate: number;
  leaderCalls: number;
  title: string;
  side: Side;
  leaderShares: string;
  leaderTime: number | null;
  isCreatorTrade: boolean;
  stakeUsdc: string;
  avgPrice: string;
  shares: string;
  feeUsdc: string;
  slippageBps: number;
};

/**
 * An illustrative copy of the top caller's latest primary-market buy, re-quoted
 * with default settings (5 USDC max stake, 2% slippage). Uses the same curve
 * approximation as the mock quote; it is a preview, not a real quote.
 */
export function getSampleCopy(): SampleCopy | null {
  const top = getLeaderboardPreview(3);
  for (const leader of top) {
    const t = trades.find((x) => x.wallet === leader.wallet && marketById.get(x.marketId)?.phase === "primary");
    if (!t) continue;
    const m = marketById.get(t.marketId)!;
    const side: Side = Number(t.yesAmount) > 0 ? "yes" : "no";
    const spot = Number((side === "yes" ? m.primaryYesPrice : m.primaryNoPrice) ?? "0.5");
    const stake = 5;
    const fee = stake * 0.02;
    const avg = Math.min(0.99, spot * (1 + stake / 2000));
    return {
      leader: leader.wallet,
      leaderHitRate: leader.hitRate,
      leaderCalls: leader.resolvedCalls,
      title: safeTitle(m.title),
      side,
      leaderShares: Number(side === "yes" ? t.yesAmount : t.noAmount).toFixed(2),
      leaderTime: t.blockTime,
      isCreatorTrade: creators[t.marketId] === t.wallet,
      stakeUsdc: stake.toFixed(2),
      avgPrice: avg.toFixed(4),
      shares: ((stake - fee) / avg).toFixed(2),
      feeUsdc: fee.toFixed(2),
      slippageBps: 200,
    };
  }
  return null;
}

/** Headline counts for the sample dataset. */
export function getSampleCounts() {
  return {
    markets: markets.length,
    callers: new Set(trades.map((t) => t.wallet)).size,
    trades: trades.length,
    resolved: markets.filter((m) => m.phase === "resolved").length,
  };
}
