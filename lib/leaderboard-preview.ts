import "server-only";
/**
 * Placeholder leaderboard for the landing page (batch 1), computed from the
 * sample fixtures. It is always labelled "sample data" in the UI so simulated
 * data is never presented as live Panta data (Panta Terms of Use: do not present simulated data as live).
 * Batch 2 replaces this with trader_stats from Supabase.
 */
import creatorsJson from "@/fixtures/creators.json";
import positionsJson from "@/fixtures/positions.json";
import tradesJson from "@/fixtures/trades.json";
import { getMinResolvedCalls } from "./env";
import type { PantaPosition, PantaTradeRow } from "./schemas";
import { computeTraderStats, rankTraders, type TraderStats } from "./stats";

export type PreviewRow = TraderStats & { rank: number; creatorVerified: false };

export function getLeaderboardPreview(limit = 8): PreviewRow[] {
  const positions = positionsJson as unknown as Record<string, PantaPosition[]>;
  const trades = tradesJson as unknown as PantaTradeRow[];
  const creators = creatorsJson as Record<string, string>;
  const stats = Object.entries(positions).map(([wallet, rows]) => computeTraderStats(wallet, rows, trades, creators));
  return rankTraders(stats, getMinResolvedCalls())
    .slice(0, limit)
    .map((s, i) => ({ ...s, rank: i + 1, creatorVerified: false as const }));
}
