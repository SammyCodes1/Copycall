/**
 * Mapping Panta trade rows to our trades table. Pure, shared with tests.
 *
 * Panta trade rows have no `side` field (docs: /api-reference/markets/trades):
 * they carry `yesAmount` / `noAmount` share amounts. We derive the side from
 * which amount is positive. Rows with both or neither positive are ambiguous
 * and are skipped rather than guessed.
 */
import type { PantaTradeRow } from "./schemas";

export type TradeSide = "YES" | "NO";

export type TradeInsert = {
  signature: string;
  marketId: string;
  wallet: string;
  side: TradeSide;
  shares: string; // decimal string
  fee: string; // decimal string
  blockTime: number | null; // unix seconds
  isPrimary: boolean;
  isCreatorTrade: boolean;
  pantaId: string;
};

function num(v: string | number): number {
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Side and share count from yes/no amounts, or null if ambiguous. */
export function deriveSide(row: Pick<PantaTradeRow, "yesAmount" | "noAmount">): { side: TradeSide; shares: number } | null {
  const yes = num(row.yesAmount);
  const no = num(row.noAmount);
  if (yes > 0 && no <= 0) return { side: "YES", shares: yes };
  if (no > 0 && yes <= 0) return { side: "NO", shares: no };
  return null;
}

/** Convert a Panta row to an insert. `creator` = known creator of that market, if any. */
export function toTradeInsert(row: PantaTradeRow, creator: string | null | undefined): TradeInsert | null {
  const d = deriveSide(row);
  if (!d) return null;
  return {
    signature: row.signature,
    marketId: row.marketId,
    wallet: row.wallet,
    side: d.side,
    shares: d.shares.toFixed(6),
    fee: Math.max(0, num(row.feePaid)).toFixed(6),
    blockTime: row.blockTime,
    isPrimary: row.isPrimary,
    isCreatorTrade: !!creator && creator === row.wallet,
    pantaId: String(row.id),
  };
}
