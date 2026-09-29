import { describe, expect, it } from "vitest";
import { computeTraderStats, rankTraders } from "@/lib/stats";
import type { PantaPosition, PantaTradeRow } from "@/lib/schemas";

const W = "Wallet1111111111111111111111111111111111111";
const pos = (marketId: string, side: "yes" | "no", phase: PantaPosition["phase"], outcome: "yes" | "no" | null): PantaPosition => ({
  marketId, side, phase, outcome, shares: "10.00", claimable: false, claimed: false, category: null,
});

describe("hit rate", () => {
  it("matches a hand calculation", () => {
    // 4 resolved: 3 correct (A, B, D-yes), 1 wrong (D-no both-sides row). Cancelled and open are excluded.
    const positions = [
      pos("A", "yes", "resolved", "yes"),
      pos("B", "no", "resolved", "no"),
      pos("D", "yes", "resolved", "yes"),
      pos("D", "no", "resolved", "yes"),
      pos("C", "yes", "cancelled", null),
      pos("E", "yes", "primary", null),
      pos("F", "no", "secondary", null),
    ];
    const trades = [
      { wallet: W, marketId: "A", blockTime: 100 },
      { wallet: W, marketId: "E", blockTime: 300 },
      { wallet: W, marketId: "E", blockTime: null },
    ] as unknown as PantaTradeRow[];
    const s = computeTraderStats(W, positions, trades, { E: W });
    expect(s.resolvedCalls).toBe(4);
    expect(s.correctCalls).toBe(3);
    expect(s.hitRate).toBe(0.75);
    expect(s.openPositions).toBe(2);
    expect(s.lastActive).toBe(300);
    expect(s.creatorTradeCount).toBe(2);
  });

  it("never ranks wallets under MIN_RESOLVED_CALLS", () => {
    const base = { openPositions: 0, lastActive: null, creatorTradeCount: 0 };
    const ranked = rankTraders(
      [
        { wallet: "a", resolvedCalls: 4, correctCalls: 4, hitRate: 1, ...base },
        { wallet: "b", resolvedCalls: 5, correctCalls: 3, hitRate: 0.6, ...base },
        { wallet: "c", resolvedCalls: 10, correctCalls: 8, hitRate: 0.8, ...base },
      ],
      5,
    );
    expect(ranked.map((r) => r.wallet)).toEqual(["c", "b"]);
  });
});
