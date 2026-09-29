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

/** Minimal trade shape needed for stats: Panta rows and our stored trades both fit. */
export type StatsTrade = Pick<PantaTradeRow, "wallet" | "marketId" | "blockTime">;

export function computeTraderStats(
  wallet: string,
  positions: PantaPosition[],
  trades: StatsTrade[],
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

/**
 * W/L letters for a wallet's resolved positions, oldest -> newest (max 12),
 * ordered by the wallet's last trade in each market.
 */
export function recentResults(
  positions: { marketId: string; side: string; phase: string; outcome?: string | null }[],
  trades: { marketId: string; blockTime: number | null }[],
  max = 12,
): string {
  const lastTrade = new Map<string, number>();
  for (const t of trades) {
    if (t.blockTime !== null) lastTrade.set(t.marketId, Math.max(lastTrade.get(t.marketId) ?? 0, t.blockTime));
  }
  return positions
    .filter((p) => p.phase === "resolved" && p.outcome)
    .map((p) => ({ t: lastTrade.get(p.marketId) ?? 0, r: p.side.toLowerCase() === p.outcome ? "W" : "L" }))
    .sort((a, b) => a.t - b.t)
    .slice(-max)
    .map((x) => x.r)
    .join("");
}
