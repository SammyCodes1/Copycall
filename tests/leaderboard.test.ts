import { describe, expect, it } from "vitest";
import positionsJson from "@/fixtures/positions.json";
import { GET as leaderboardApi } from "@/app/api/leaderboard/route";
import { GET as traderApi } from "@/app/api/trader/[wallet]/route";
import { createMemoryDataStore } from "@/lib/mock/data-store-memory";
import type { PantaPosition } from "@/lib/schemas";
import type { LeaderRow } from "@/lib/view-types";

const positions = positionsJson as unknown as Record<string, PantaPosition[]>;
const resolvedCount = (w: string) => (positions[w] ?? []).filter((p) => p.phase === "resolved" && p.outcome).length;

const traderReq = (wallet: string) =>
  traderApi(new Request(`http://localhost:3000/api/trader/${wallet}`), { params: Promise.resolve({ wallet }) });

describe("leaderboard", () => {
  it("GET /api/leaderboard excludes wallets below MIN_RESOLVED_CALLS", async () => {
    for (const min of [5, 8]) {
      process.env.MIN_RESOLVED_CALLS = String(min);
      const res = await leaderboardApi(new Request("http://localhost:3000/api/leaderboard?limit=100"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: LeaderRow[]; minResolvedCalls: number; sample: boolean };
      expect(body.minResolvedCalls).toBe(min);
      expect(body.sample).toBe(true);
      const below = Object.keys(positions).filter((w) => resolvedCount(w) < min);
      expect(below.length).toBeGreaterThan(0); // the fixtures include wallets that must be hidden
      for (const r of body.rows) {
        expect(r.resolvedCalls).toBeGreaterThanOrEqual(min);
        expect(below).not.toContain(r.wallet);
      }
      // ranked by hit rate
      for (let i = 1; i < body.rows.length; i++) expect(body.rows[i - 1].hitRate).toBeGreaterThanOrEqual(body.rows[i].hitRate);
    }
    delete process.env.MIN_RESOLVED_CALLS;
  }, 20_000);

  it("store.leaderboard applies the minimum at the storage layer too", async () => {
    const store = createMemoryDataStore();
    const base = { correctCalls: 1, openPositions: 0, lastActive: null, creatorTradeCount: 0, recentResults: "", updatedAt: 1 };
    await store.upsertTraderStats({ wallet: "a", resolvedCalls: 4, hitRate: 1, ...base });
    await store.upsertTraderStats({ wallet: "b", resolvedCalls: 5, hitRate: 0.2, ...base });
    expect((await store.leaderboard(5, 10)).map((s) => s.wallet)).toEqual(["b"]);
  });

  it("rejects bad limits", async () => {
    for (const q of ["limit=0", "limit=101", "limit=abc"]) {
      expect((await leaderboardApi(new Request(`http://localhost:3000/api/leaderboard?${q}`))).status).toBe(400);
    }
  });
});

describe("GET /api/trader/[wallet]", () => {
  it("validates the wallet as a base58 pubkey", async () => {
    for (const w of ["not-a-wallet", "0OIl" + "1".repeat(40), "", "1".repeat(50), "%2e%2e%2fmarkets"]) {
      expect((await traderReq(w)).status).toBe(400);
    }
  });

  it("returns 404 for a valid but unseen wallet and a profile for a tracked one", async () => {
    expect((await traderReq("Vote111111111111111111111111111111111111111")).status).toBe(404);
    const known = Object.keys(positions).find((w) => resolvedCount(w) >= 5)!;
    const res = await traderReq(known);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wallet).toBe(known);
    expect(body.stats.rank).toBeGreaterThan(0);
    expect(body.trades.length).toBeGreaterThan(0);
    for (const t of body.trades) expect(t.title.length).toBeLessThanOrEqual(120);
  }, 20_000);
});
