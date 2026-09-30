/**
 * Background jobs (MVP features 2 and 7).
 *
 * Alerts (runAlerts, below) poll followed wallets every 2 minutes.
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
 * Any other error only affects its own item, which is backed off (audit B2-04).
 *
 * Dependencies are injected so the job is unit-testable with fixtures.
 */
import { createHash } from "node:crypto";
import { formatAlert } from "./alert-message";
import type { DataStore, StoredPosition, StoredTrade } from "./data-store";
import { PantaError } from "./panta-error";
import type {
  MarketListResponse,
  MarketTradesResponse,
  PantaMarket,
  PositionsResponse,
  WalletTradesResponse,
} from "./schemas";
import { computeTraderStats, recentResults } from "./stats";
import { deriveSide, toTradeInsert, type TradeInsert } from "./trades";

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
/** After a failed creator lookup (RPC error), try again after about an hour. */
const CREATOR_RETRY_SEC = 3600;

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
  /** Items that failed with a non-429 error this run (each is backed off, the run continues). */
  failed: { marketPages: number; tapes: number; creators: number; wallets: number };
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
    failed: { marketPages: 0, tapes: 0, creators: 0, wallets: 0 },
  };
  const canRead = () => out.pantaCalls.read < budget.read;

  // Per-item isolation (audit B2-04): a non-429 error on one market tape or
  // wallet is logged, counted and backed off (skipped for 10 min .. 24 h), and
  // the run carries on. Only 429 stops a phase; the next run resumes it.
  const itemFailed = (what: string, err: unknown) =>
    log(
      `${what} failed: ${err instanceof PantaError ? `Panta ${err.status}` : err instanceof Error ? err.name : "error"}`,
    );

  // 1. Market catalog. A bad page ends paging for this run (there is no way to
  // skip past a cursor), but the other phases still run.
  let cursor: string | undefined;
  for (let page = 0; page < budget.marketPages && canRead(); page++) {
    try {
      out.pantaCalls.read++;
      const res = await panta.listMarkets({ cursor, limit: 50 });
      await store.upsertMarkets(res.items.map((m) => ({ id: m.marketId, title: m.title, status: m.phase })));
      out.marketsSeen += res.items.length;
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    } catch (err) {
      if (isRateLimited(err)) {
        out.stoppedEarly.push("markets:rate_limited");
      } else {
        out.failed.marketPages++;
        itemFailed("market page", err);
      }
      break;
    }
  }

  // 2. Trade tapes for markets that can still change (least recently synced first).
  const due = await store.marketsNeedingTrades(Math.max(0, budget.read - out.pantaCalls.read), nowSec());
  for (const m of due) {
    if (!canRead()) break;
    try {
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
      await store.clearSyncFailure("tape", m.id);
    } catch (err) {
      if (isRateLimited(err)) {
        out.stoppedEarly.push("trades:rate_limited");
        break;
      }
      out.failed.tapes++;
      itemFailed(`tape for ${m.id}`, err);
      await store.recordSyncFailure("tape", m.id, nowSec()).catch(() => {});
    }
  }

  // 3. Creators (on-chain, cached forever once found).
  const needCreator = await store.marketsNeedingCreator(budget.creators, nowSec() - CREATOR_RECHECK_SEC);
  for (const id of needCreator) {
    try {
      const found = await deps.getMarketCreator(id); // marketId == market address (Panta docs)
      await store.setMarketCreator(id, found?.creator ?? null, nowSec());
      if (found) out.creatorsResolved++;
    } catch (err) {
      // RPC hiccup: retry in about an hour rather than first in line every run.
      out.failed.creators++;
      itemFailed(`creator lookup for ${id}`, err);
      await store.setMarketCreator(id, null, nowSec() - CREATOR_RECHECK_SEC + CREATOR_RETRY_SEC).catch(() => {});
    }
  }

  // 4. Positions + trader_stats for tracked wallets (stalest first).
  const wallets = await store.walletsToRefresh(budget.positions, nowSec());
  for (const wallet of wallets) {
    try {
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
      for (const p of positions)
        if (p.phase === "resolved" && p.outcome) await store.setMarketOutcome(p.marketId, p.outcome);

      const s = computeTraderStats(wallet, positions, trades, creators);
      await store.upsertTraderStats({ ...s, recentResults: recentResults(positions, trades), updatedAt: nowSec() });
      await store.clearSyncFailure("wallet", wallet);
      out.walletsRefreshed++;
    } catch (err) {
      if (isRateLimited(err)) {
        out.stoppedEarly.push("positions:rate_limited");
        break;
      }
      out.failed.wallets++;
      itemFailed(`positions for ${wallet}`, err);
      await store.recordSyncFailure("wallet", wallet, nowSec()).catch(() => {});
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Copy alerts: GET /api/cron/alerts every 2 minutes (MVP feature 7)
// ---------------------------------------------------------------------------

export type AlertDeps = {
  store: DataStore;
  panta: {
    getWalletTrades(wallet: string, limit?: number): Promise<WalletTradesResponse>;
    getMarket(marketId: string): Promise<PantaMarket>;
  };
  getMarketCreator(marketAddress: string): Promise<{ creator: string } | null>;
  /** Sends a Telegram message; null when Telegram isn't configured (alerts are logged). */
  send: ((chatId: number, text: string) => Promise<void>) | null;
  appOrigin: string;
  mock: boolean;
  now?: () => number; // ms
  budget?: Partial<AlertBudget>;
  log?: (msg: string) => void;
};

export type AlertBudget = {
  /** Panta "read" calls per run (wallet tapes + unknown markets). Runs every 2 min => <= 45/min. */
  read: number;
  /** On-chain creator lookups per run. */
  creators: number;
  /** Messages per run. */
  messages: number;
};
export const ALERT_BUDGET: AlertBudget = { read: 90, creators: 5, messages: 200 };

/**
 * Bounded retries (audit B2-11): failed sends and pending alerts a run never
 * got to (crash, timeout, message budget) are retried at most 3 times in
 * total, 2+ minutes apart, and only while the alert is under 30 minutes old.
 */
export const ALERT_RETRY = { limit: 50, maxAttempts: 3, maxAgeSec: 30 * 60, minGapSec: 110 };

/** Trades older than this when first seen are not alerted (e.g. after downtime). */
export const MAX_ALERT_AGE_SEC = 30 * 60;

export type AlertSummary = {
  leaders: number;
  leadersPolled: number;
  newTrades: number;
  alertsCreated: number;
  sent: number;
  logged: number;
  skipped: number;
  failed: number;
  retried: number;
  pantaCalls: number;
  stoppedEarly: string[];
};

/** Rotate which leaders get polled first so a large follow list is covered across runs. */
function rotation(wallet: string, bucket: number): string {
  return createHash("sha256").update(`${bucket}:${wallet}`).digest("hex");
}

export async function runAlerts(deps: AlertDeps): Promise<AlertSummary> {
  const { store, panta } = deps;
  const budget = { ...ALERT_BUDGET, ...deps.budget };
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  const log = deps.log ?? (() => {});
  const out: AlertSummary = {
    leaders: 0,
    leadersPolled: 0,
    newTrades: 0,
    alertsCreated: 0,
    sent: 0,
    logged: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    pantaCalls: 0,
    stoppedEarly: [],
  };

  const subs = await store.alertSubscriptions();
  const byLeader = new Map<string, typeof subs>();
  for (const s of subs) byLeader.set(s.leaderWallet, [...(byLeader.get(s.leaderWallet) ?? []), s]);
  out.leaders = byLeader.size;
  const bucket = Math.floor(nowSec / 120);
  const leaders = [...byLeader.keys()].sort((a, b) => rotation(a, bucket).localeCompare(rotation(b, bucket)));

  let creatorLookups = 0;
  for (const leader of leaders) {
    if (out.pantaCalls >= budget.read) {
      out.stoppedEarly.push("read_budget");
      break;
    }
    let tape: WalletTradesResponse;
    try {
      out.pantaCalls++;
      tape = await panta.getWalletTrades(leader, 50);
    } catch (err) {
      if (isRateLimited(err)) {
        out.stoppedEarly.push("rate_limited");
        break;
      }
      log(`wallet tape failed for ${leader}: ${err instanceof Error ? err.message : "error"}`);
      continue;
    }
    out.leadersPolled++;

    // New buys only: primary-phase rows (the copy flow is a primary buy), a
    // clear side, recent, and from the leader themselves.
    const fresh = tape.items.filter(
      (t) =>
        t.wallet === leader &&
        t.isPrimary &&
        t.blockTime !== null &&
        t.blockTime >= nowSec - MAX_ALERT_AGE_SEC &&
        deriveSide(t),
    );
    if (fresh.length === 0) continue;

    // Make sure every market exists (trades.market_id FK) and try to know its creator.
    const marketIds = [...new Set(fresh.map((t) => t.marketId))];
    const known = new Set((await store.getMarkets(marketIds)).map((m) => m.id));
    for (const id of marketIds) {
      if (known.has(id) || out.pantaCalls >= budget.read) continue;
      try {
        out.pantaCalls++;
        const m = await panta.getMarket(id);
        await store.upsertMarkets([{ id: m.marketId, title: m.title, status: m.phase }]);
        known.add(id);
      } catch (err) {
        log(`market lookup failed for ${id}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
    let creators = await store.getCreators(marketIds);
    for (const id of marketIds) {
      if (creators[id] || !known.has(id) || creatorLookups >= budget.creators) continue;
      creatorLookups++;
      try {
        const found = await deps.getMarketCreator(id);
        await store.setMarketCreator(id, found?.creator ?? null, nowSec);
      } catch {
        log(`creator lookup failed for ${id}`);
      }
    }
    creators = await store.getCreators(marketIds);

    const rows = fresh
      .filter((t) => known.has(t.marketId))
      .flatMap((t) => toTradeInsert(t, creators[t.marketId]) ?? []);
    out.newTrades += (await store.insertTrades(rows)).length;
    // Includes trades the leaderboard sync stored first: they still deserve an alert.
    const stored = await store.tradesBySignatures(rows.map((r) => r.signature));

    const followers = byLeader.get(leader) ?? [];
    const wanted = stored.flatMap((t) =>
      followers
        .filter((f) => t.blockTime !== null && t.blockTime >= f.followedAt)
        .map((f) => ({ userId: f.userId, tradeId: t.id })),
    );
    const created = await store.createAlerts(wanted);
    out.alertsCreated += created.length;
    if (created.length === 0) continue;

    const tradeById = new Map(stored.map((t) => [t.id, t]));
    const outcome = await deliver(
      created.map((a) => ({ ...a, trade: tradeById.get(a.tradeId)! })),
      false,
    );
    if (outcome === "budget") break;
  }

  // Retry earlier failures / stragglers (bounded). Only when Telegram is on:
  // without it every alert is logged immediately and never fails.
  if (deps.send && !out.stoppedEarly.includes("message_budget")) {
    const again = await store.claimAlertRetries(ALERT_RETRY);
    const items = [];
    for (const a of again) {
      const trade = await store.getTradeById(a.tradeId);
      if (trade) items.push({ ...a, trade });
      else await store.setAlertStatus(a.id, "skipped", null);
    }
    await deliver(items, true);
  }
  return out;

  /** Format and send (or log) alerts. Returns "budget" when the message budget ran out. */
  async function deliver(
    items: { id: string; userId: string; trade: StoredTrade }[],
    retry: boolean,
  ): Promise<"ok" | "budget"> {
    for (const a of items) {
      const t = a.trade;
      const leader = t.wallet;
      const f = (byLeader.get(leader) ?? []).find((x) => x.userId === a.userId);
      if (!f) {
        await store.setAlertStatus(a.id, "skipped", null); // unfollowed or alerts turned off since
        continue;
      }
      const [stats, markets] = await Promise.all([store.getTraderStats(leader), store.getMarkets([t.marketId])]);
      const m = markets[0];
      const text = formatAlert({
        appOrigin: deps.appOrigin,
        tradeId: t.id,
        leaderWallet: leader,
        hitRate: stats && stats.resolvedCalls > 0 ? stats.hitRate : null,
        resolvedCalls: stats?.resolvedCalls ?? 0,
        side: t.side,
        title: m?.title ?? "Untitled market",
        isCreatorTrade: t.isCreatorTrade,
        creatorVerified: m?.creatorVerified ?? false,
        mock: deps.mock,
      });
      if (!deps.send) {
        log(`alert (Telegram not configured) user=${a.userId}\n${text}`);
        await store.setAlertStatus(a.id, "logged", nowSec);
        out.logged++;
      } else if (f.chatId === null) {
        await store.setAlertStatus(a.id, "skipped", null); // user hasn't linked Telegram
        out.skipped++;
      } else if (out.sent + out.failed >= budget.messages) {
        out.stoppedEarly.push("message_budget"); // stays pending; retried by a later run
        return "budget";
      } else {
        try {
          await deps.send(f.chatId, text);
          await store.setAlertStatus(a.id, "sent", nowSec);
          out.sent++;
          if (retry) out.retried++;
        } catch (err) {
          log(`telegram send failed: ${err instanceof Error ? err.message : "error"}`);
          await store.setAlertStatus(a.id, "failed", null);
          out.failed++;
        }
      }
    }
    return "ok";
  }
}
