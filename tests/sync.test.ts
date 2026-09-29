import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import creatorsJson from "@/fixtures/creators.json";
import positionsJson from "@/fixtures/positions.json";
import tradesJson from "@/fixtures/trades.json";
import { GET as leaderboardCron } from "@/app/api/cron/leaderboard/route";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { createMemoryDataStore, createMemoryState } from "@/lib/mock/data-store-memory";
import * as panta from "@/lib/panta";
import { PantaError } from "@/lib/panta-error";
import type { PantaPosition, PantaTradeRow } from "@/lib/schemas";
import { computeTraderStats } from "@/lib/stats";
import { runLeaderboardSync, type SyncDeps } from "@/lib/sync";
import { deriveSide, toTradeInsert } from "@/lib/trades";

const creators = creatorsJson as Record<string, string>;
const fixtureTrades = tradesJson as unknown as PantaTradeRow[];
const fixturePositions = positionsJson as unknown as Record<string, PantaPosition[]>;

function syncDeps(overrides: Partial<SyncDeps> = {}) {
  const state = createMemoryState();
  const store = createMemoryDataStore(state);
  const calls = { read: 0, positions: 0 };
  const deps: SyncDeps = {
    store,
    panta: {
      listMarkets: (p) => (calls.read++, panta.listMarkets(p)),
      getMarketTrades: (id, n) => (calls.read++, panta.getMarketTrades(id, n)),
      getPositions: (w) => (calls.positions++, panta.getPositions(w)),
    },
    getMarketCreator: async (id) => (creators[id] ? { creator: creators[id] } : null),
    ...overrides,
  };
  return { deps, state, store, calls };
}

describe("cron auth (addendum D)", () => {
  const SECRET = randomBytes(24).toString("base64url"); // random per run, never hardcoded
  const url = "http://localhost:3000/api/cron/leaderboard";

  it("returns 401 without a secret, with a wrong one, and with the secret only in the query string", async () => {
    process.env.CRON_SECRET = SECRET;
    for (const req of [
      new Request(url),
      new Request(url, { headers: { authorization: `Bearer ${randomBytes(24).toString("base64url")}` } }),
      new Request(url, { headers: { authorization: SECRET } }), // missing "Bearer "
      new Request(`${url}?secret=${SECRET}`),
      new Request(`${url}?CRON_SECRET=${SECRET}&authorization=Bearer%20${SECRET}`),
    ]) {
      const res = await leaderboardCron(req);
      expect(res.status).toBe(401);
    }
  });

  it("fails closed when CRON_SECRET is unset or short", () => {
    const req = new Request(url, { headers: { authorization: "Bearer x" } });
    expect(isAuthorizedCron(req, undefined)).toBe(false);
    expect(isAuthorizedCron(req, "x")).toBe(false);
  });

  it("runs the sync with the right bearer token (mock mode)", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await leaderboardCron(new Request(url, { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.summary.tradesInserted).toBeGreaterThan(0);
  }, 20_000);
});

describe("trades", () => {
  it("derives the side from yes/no amounts and skips ambiguous rows", () => {
    expect(deriveSide({ yesAmount: "10.5", noAmount: "0" })).toEqual({ side: "YES", shares: 10.5 });
    expect(deriveSide({ yesAmount: 0, noAmount: 3 })).toEqual({ side: "NO", shares: 3 });
    expect(deriveSide({ yesAmount: "1", noAmount: "1" })).toBeNull();
    expect(deriveSide({ yesAmount: "0", noAmount: "0" })).toBeNull();
  });

  it("dedupes by signature (within a batch and across runs)", async () => {
    const { deps, store } = syncDeps();
    const first = await runLeaderboardSync(deps);
    expect(first.tradesInserted).toBe(new Set(fixtureTrades.map((t) => t.signature)).size);

    // Same tape again: nothing new.
    const again = await runLeaderboardSync({ ...deps, now: () => Date.now() + 1000 });
    expect(again.tradesInserted).toBe(0);

    // Direct insert of an existing signature and a duplicate inside one batch.
    const row = toTradeInsert(fixtureTrades[0], null)!;
    const fresh = { ...row, signature: row.signature.slice(0, -4) + "1111" };
    const inserted = await store.insertTrades([row, fresh, fresh]);
    expect(inserted.map((t) => t.signature)).toEqual([fresh.signature]);
  }, 20_000);
});

describe("leaderboard sync", () => {
  it("stores markets, creators, outcomes and stats that match the fixtures", async () => {
    const { deps, state } = syncDeps();
    const s = await runLeaderboardSync(deps);
    expect(s.marketsSeen).toBeGreaterThanOrEqual(20);
    expect(s.creatorsResolved).toBe(Math.min(Object.keys(creators).length, 20));
    expect(s.stoppedEarly).toEqual([]);

    // Creator trades are flagged.
    const flagged = [...state.trades.values()].filter((t) => t.isCreatorTrade);
    expect(flagged.length).toBeGreaterThan(0);
    for (const t of flagged) expect(creators[t.marketId]).toBe(t.wallet);

    // Outcomes come from resolved positions.
    const resolved = [...state.markets.values()].filter((m) => m.status === "resolved");
    expect(resolved.some((m) => m.outcome)).toBe(true);

    // trader_stats equal the pure calculation over the same data.
    expect(state.stats.size).toBeGreaterThanOrEqual(15);
    for (const [wallet, stats] of state.stats) {
      const expected = computeTraderStats(wallet, fixturePositions[wallet] ?? [], fixtureTrades, creators);
      expect(stats.resolvedCalls).toBe(expected.resolvedCalls);
      expect(stats.correctCalls).toBe(expected.correctCalls);
      expect(stats.hitRate).toBeCloseTo(expected.hitRate, 10);
      expect(stats.recentResults).toMatch(/^[WL]{0,12}$/);
    }
  }, 20_000);

  it("never spends more than the per-run Panta budget", async () => {
    const { deps, calls } = syncDeps({ budget: { read: 5, positions: 3 } });
    const s = await runLeaderboardSync(deps);
    expect(calls.read).toBeLessThanOrEqual(5);
    expect(calls.positions).toBeLessThanOrEqual(3);
    expect(s.pantaCalls).toEqual(calls);
  });

  it("stops a phase on 429 and keeps going with the rest", async () => {
    const base = syncDeps();
    const deps: SyncDeps = {
      ...base.deps,
      panta: {
        ...base.deps.panta,
        getMarketTrades: async () => {
          throw new PantaError(429, "RATE_LIMITED", "slow down");
        },
      },
    };
    const s = await runLeaderboardSync(deps);
    expect(s.stoppedEarly).toContain("trades:rate_limited");
    expect(s.marketsSeen).toBeGreaterThan(0);
  });
});

describe("panta per-family budgets", () => {
  it("stays at or under ~83% of every documented family limit", () => {
    for (const f of Object.keys(panta.PANTA_FAMILY_LIMITS) as (keyof typeof panta.PANTA_FAMILY_LIMITS)[]) {
      expect(panta.FAMILY_BUDGET_PER_MINUTE[f]).toBeLessThanOrEqual(Math.floor(panta.PANTA_FAMILY_LIMITS[f] * 0.84));
    }
    expect(panta.FAMILY_BUDGET_PER_MINUTE.read).toBeLessThanOrEqual(100);
  });
});
