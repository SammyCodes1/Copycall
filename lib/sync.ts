/**
 * Background jobs (MVP feature 2; alerts arrive in step 8).
 *
 * Leaderboard sync, run by GET /api/cron/leaderboard every 10-15 minutes:
 *  1. page GET /markets/ and upsert the catalog
 *  2. pull GET /markets/{id}/trades/ for markets that can still change, and
 *     insert every row into trades (dedupe by signature). The tape is capped at
 *     200 rows with no cursor, so we keep history ourselves.
 *  3. resolve and cache market creators on-chain (getMarketCreator)
 *  4. refresh GET /positions/?wallet= and trader_stats for tracked wallets
 *
 * Rate limits: each run spends at most RUN_BUDGET calls per Panta family, well
 * under the documented per-minute limits (read 120, positions 60), and
 * lib/panta.ts also throttles and backs off on 429. If Panta still returns 429,
 * the run stops that phase and the next run carries on (least recently synced first).
 *
 * Dependencies are injected so the job is unit-testable with fixtures.
 */
import type { DataStore, StoredPosition } from "./data-store";
import { PantaError } from "./panta-error";
import type { MarketListResponse, MarketTradesResponse, PositionsResponse } from "./schemas";
import { computeTraderStats, recentResults } from "./stats";
import { toTradeInsert, type TradeInsert } from "./trades";

export type SyncDeps = {
  store: DataStore;
  panta: {
    listMarkets(p: { cursor?: string; limit?: number }): Promise<MarketListResponse>;
    getMarketTrades(marketId: string, limit?: number): Promise<MarketTradesResponse>;
    getPositions(wallet: string): Promise<PositionsResponse>;
  };
  getMarketCreator(marketAddress: string): Promise<{ creator: string } | null>;
  now?: () => number; // ms
  budget?: Partial<RunBudget>;
  log?: (msg: string) => void;
};

export type RunBudget = {
  /** Panta "read" family calls per run (market pages + tapes). Limit is 120/min. */
  read: number;
  /** Panta "positions" family calls per run. Limit is 60/min. */
  positions: number;
  /** On-chain creator lookups per run (RPC, not Panta). */
  creators: number;
  /** Max GET /markets/ pages per run (50 markets each). */
  marketPages: number;
};

export const RUN_BUDGET: RunBudget = { read: 90, positions: 45, creators: 20, marketPages: 20 };

/** Re-try creator lookups that found nothing after a day. */
const CREATOR_RECHECK_SEC = 24 * 3600;

export type SyncSummary = {
  marketsSeen: number;
  tapesFetched: number;
  tapesAtCap: number;
  tradesInserted: number;
  tradesSkippedAmbiguous: number;
  creatorsResolved: number;
  walletsRefreshed: number;
  pantaCalls: { read: number; positions: number };
  stoppedEarly: string[];
};

const FINAL_PHASES = new Set(["resolved", "cancelled"]);

function isRateLimited(err: unknown): boolean {
  return err instanceof PantaError && err.status === 429;
}

export async function runLeaderboardSync(deps: SyncDeps): Promise<SyncSummary> {
  const { store, panta } = deps;
  const budget = { ...RUN_BUDGET, ...deps.budget };
  const nowSec = () => Math.floor((deps.now ?? Date.now)() / 1000);
  const log = deps.log ?? (() => {});
  const out: SyncSummary = {
    marketsSeen: 0,
    tapesFetched: 0,
    tapesAtCap: 0,
    tradesInserted: 0,
    tradesSkippedAmbiguous: 0,
    creatorsResolved: 0,
    walletsRefreshed: 0,
    pantaCalls: { read: 0, positions: 0 },
    stoppedEarly: [],
  };
  const canRead = () => out.pantaCalls.read < budget.read;

  // 1. Market catalog.
  try {
    let cursor: string | undefined;
    for (let page = 0; page < budget.marketPages && canRead(); page++) {
      out.pantaCalls.read++;
      const res = await panta.listMarkets({ cursor, limit: 50 });
      await store.upsertMarkets(res.items.map((m) => ({ id: m.marketId, title: m.title, status: m.phase })));
      out.marketsSeen += res.items.length;
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  } catch (err) {
    if (!isRateLimited(err)) throw err;
    out.stoppedEarly.push("markets:rate_limited");
  }

  // 2. Trade tapes for markets that can still change (least recently synced first).
  try {
    const due = await store.marketsNeedingTrades(Math.max(0, budget.read - out.pantaCalls.read));
    for (const m of due) {
      if (!canRead()) break;
      out.pantaCalls.read++;
      const tape = await panta.getMarketTrades(m.id, 200);
      out.tapesFetched++;
      if (tape.items.length >= 200) {
        out.tapesAtCap++;
        log(`tape for ${m.id} hit the 200-row cap; older rows rely on earlier syncs`);
      }
      const creators = await store.getCreators([m.id]);
      const rows: TradeInsert[] = [];
      for (const t of tape.items) {
        if (t.marketId !== m.id) continue; // defensive: tape rows must belong to this market
        const ins = toTradeInsert(t, creators[m.id]);
        if (ins) rows.push(ins);
        else out.tradesSkippedAmbiguous++;
      }
      out.tradesInserted += (await store.insertTrades(rows)).length;
      await store.markTradesSynced(m.id, FINAL_PHASES.has(m.status), nowSec());
    }
  } catch (err) {
    if (!isRateLimited(err)) throw err;
    out.stoppedEarly.push("trades:rate_limited");
  }

  // 3. Creators (on-chain, cached forever once found).
  const needCreator = await store.marketsNeedingCreator(budget.creators, nowSec() - CREATOR_RECHECK_SEC);
  for (const id of needCreator) {
    try {
      const found = await deps.getMarketCreator(id); // marketId == market address (Panta docs)
      await store.setMarketCreator(id, found?.creator ?? null, nowSec());
      if (found) out.creatorsResolved++;
    } catch (err) {
      // RPC hiccup: leave unchecked so the next run retries. Never log RPC URLs.
      log(`creator lookup failed for ${id}: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  // 4. Positions + trader_stats for tracked wallets (stalest first).
  try {
    const wallets = await store.walletsToRefresh(budget.positions);
    for (const wallet of wallets) {
      out.pantaCalls.positions++;
      const { positions } = await panta.getPositions(wallet);
      const trades = await store.tradesForWallet(wallet, 1000);
      const creators = await store.getCreators([...new Set(trades.map((t) => t.marketId))]);
      const stored: StoredPosition[] = positions.map((p) => ({
        marketId: p.marketId,
        side: p.side === "yes" ? "YES" : "NO",
        shares: p.shares,
        phase: p.phase,
        outcome: p.outcome ?? null,
        claimable: p.claimable,
        claimed: p.claimed,
      }));
      await store.replacePositions(wallet, stored);
      // Panta market rows have no outcome field; resolved positions carry it.
      for (const p of positions) if (p.phase === "resolved" && p.outcome) await store.setMarketOutcome(p.marketId, p.outcome);

      const s = computeTraderStats(wallet, positions, trades, creators);
      await store.upsertTraderStats({ ...s, recentResults: recentResults(positions, trades), updatedAt: nowSec() });
      out.walletsRefreshed++;
    }
  } catch (err) {
    if (!isRateLimited(err)) throw err;
    out.stoppedEarly.push("positions:rate_limited");
  }

  return out;
}
