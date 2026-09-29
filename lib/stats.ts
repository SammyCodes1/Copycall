/**
 * Hit-rate calculation (MVP feature 3). Pure functions, no I/O.
 *
 * hit rate = resolved positions where side == outcome / resolved positions.
 * A "resolved position" is a Panta position row with phase "resolved" and a
 * non-null outcome. Cancelled markets are not counted. A wallet holding both
 * YES and NO in one market has two rows (per Panta docs) and both count.
 */
import type { PantaPosition, PantaTradeRow } from "./schemas";

export type TraderStats = {
  wallet: string;
  resolvedCalls: number;
  correctCalls: number;
  hitRate: number; // 0..1
  openPositions: number;
  lastActive: number | null; // unix seconds
  creatorTradeCount: number;
};

export function computeTraderStats(
  wallet: string,
  positions: PantaPosition[],
  trades: PantaTradeRow[],
  creatorByMarket: Record<string, string | null | undefined>,
): TraderStats {
  const resolved = positions.filter((p) => p.phase === "resolved" && p.outcome);
  const correct = resolved.filter((p) => p.side === p.outcome).length;
  const open = positions.filter((p) => p.phase === "primary" || p.phase === "secondary").length;
  const own = trades.filter((t) => t.wallet === wallet);
  const times = own.map((t) => t.blockTime).filter((t): t is number => t !== null);
  return {
    wallet,
    resolvedCalls: resolved.length,
    correctCalls: correct,
    hitRate: resolved.length ? correct / resolved.length : 0,
    openPositions: open,
    lastActive: times.length ? Math.max(...times) : null,
    creatorTradeCount: own.filter((t) => creatorByMarket[t.marketId] === wallet).length,
  };
}

/** Leaderboard ordering: only wallets with >= minResolved calls, by hit rate then volume of calls. */
export function rankTraders(stats: TraderStats[], minResolved: number): TraderStats[] {
  return stats
    .filter((s) => s.resolvedCalls >= minResolved)
    .sort((a, b) => b.hitRate - a.hitRate || b.resolvedCalls - a.resolvedCalls || a.wallet.localeCompare(b.wallet));
}
