/**
 * In-memory DataStore for MOCK MODE and tests only. Same contract as the
 * Supabase store (dedupe by signature, write-once outcome, etc.). Not shared
 * across server instances, so it refuses to run on a Vercel production deployment.
 */
import { randomUUID } from "node:crypto";
import type {
  DataStore,
  StoredMarket,
  StoredPosition,
  StoredStats,
  StoredTrade,
  UserSettings,
} from "../data-store";
import { assertBootSafe, isVercelProduction } from "../boot";

type MarketRow = StoredMarket & {
  tradesSyncedAt: number | null;
  tradesFinal: boolean;
  creatorCheckedAt: number | null;
};

export type MemoryState = {
  markets: Map<string, MarketRow>;
  trades: Map<string, StoredTrade>; // by signature
  positions: Map<string, StoredPosition[]>; // by wallet
  stats: Map<string, StoredStats>; // by wallet
  follows: Map<string, Map<string, number>>; // userId -> leader wallet -> createdAt
  settings: Map<string, Omit<UserSettings, "telegramLinked"> & { telegramChatId: number | null }>; // by userId
};

/** users-table defaults (see migration 0001). */
const DEFAULT_SETTINGS = { maxStakeUsdc: "5.00", slippageBps: 200, alertsEnabled: true, telegramChatId: null };

export function createMemoryState(): MemoryState {
  return {
    markets: new Map(),
    trades: new Map(),
    positions: new Map(),
    stats: new Map(),
    follows: new Map(),
    settings: new Map(),
  };
}

const byTimeDesc = (a: StoredTrade, b: StoredTrade) => (b.blockTime ?? 0) - (a.blockTime ?? 0);

export function createMemoryDataStore(s: MemoryState = createMemoryState()): DataStore {
  assertBootSafe(process.env);
  if (isVercelProduction(process.env)) throw new Error("Memory data store is not allowed in production");

  // The memory auth store owns user ids; settings rows are created on first use with the DB defaults.
  const userRow = (id: string) => {
    let row = s.settings.get(id);
    if (!row) s.settings.set(id, (row = { ...DEFAULT_SETTINGS }));
    return row;
  };
  const view = (id: string): UserSettings => {
    const { telegramChatId, ...rest } = userRow(id);
    return { ...rest, telegramLinked: telegramChatId !== null };
  };

  return {
    async upsertMarkets(rows) {
      for (const r of rows) {
        const prev = s.markets.get(r.id);
        s.markets.set(r.id, {
          id: r.id,
          address: r.id, // Panta marketId IS the market address
          title: r.title,
          status: r.status,
          outcome: prev?.outcome ?? null,
          creatorWallet: prev?.creatorWallet ?? null,
          creatorVerified: prev?.creatorVerified ?? false,
          tradesSyncedAt: prev?.tradesSyncedAt ?? null,
          tradesFinal: prev?.tradesFinal ?? false,
          creatorCheckedAt: prev?.creatorCheckedAt ?? null,
        });
      }
    },
    async marketsNeedingTrades(limit) {
      return [...s.markets.values()]
        .filter((m) => !m.tradesFinal)
        .sort((a, b) => (a.tradesSyncedAt ?? -1) - (b.tradesSyncedAt ?? -1) || a.id.localeCompare(b.id))
        .slice(0, Math.max(0, limit))
        .map((m) => ({ id: m.id, status: m.status }));
    },
    async markTradesSynced(id, final, nowSec) {
      const m = s.markets.get(id);
      if (m) Object.assign(m, { tradesSyncedAt: nowSec, tradesFinal: final });
    },
    async marketsNeedingCreator(limit, recheckBeforeSec) {
      return [...s.markets.values()]
        .filter((m) => !m.creatorWallet && (m.creatorCheckedAt === null || m.creatorCheckedAt < recheckBeforeSec))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, Math.max(0, limit))
        .map((m) => m.id);
    },
    async setMarketCreator(id, creator, nowSec) {
      const m = s.markets.get(id);
      if (!m) return;
      m.creatorCheckedAt = nowSec;
      if (!creator) return;
      m.creatorWallet = creator;
      m.creatorVerified = false;
      for (const t of s.trades.values()) if (t.marketId === id && t.wallet === creator) t.isCreatorTrade = true;
    },
    async getCreators(ids) {
      const out: Record<string, string> = {};
      for (const id of ids) {
        const c = s.markets.get(id)?.creatorWallet;
        if (c) out[id] = c;
      }
      return out;
    },
    async setMarketOutcome(id, outcome) {
      const m = s.markets.get(id);
      if (m && !m.outcome) m.outcome = outcome;
    },

    async insertTrades(rows) {
      const inserted: StoredTrade[] = [];
      for (const r of rows) {
        if (s.trades.has(r.signature)) continue; // dedupe by signature (UNIQUE in Postgres)
        if (!s.markets.has(r.marketId)) continue; // FK: trades.market_id -> markets.id
        const row = { ...r, id: randomUUID() };
        s.trades.set(r.signature, row);
        inserted.push({ ...row });
      }
      return inserted;
    },
    async tradesForWallet(wallet, limit) {
      return [...s.trades.values()].filter((t) => t.wallet === wallet).sort(byTimeDesc).slice(0, limit).map((t) => ({ ...t }));
    },

    async walletsToRefresh(limit) {
      const wallets = [...new Set([...s.trades.values()].map((t) => t.wallet))];
      return wallets
        .sort((a, b) => (s.stats.get(a)?.updatedAt ?? -1) - (s.stats.get(b)?.updatedAt ?? -1) || a.localeCompare(b))
        .slice(0, Math.max(0, limit));
    },
    async replacePositions(wallet, rows) {
      s.positions.set(wallet, rows.map((r) => ({ ...r })));
    },
    async upsertTraderStats(row) {
      s.stats.set(row.wallet, { ...row });
    },

    async leaderboard(minResolved, limit) {
      return [...s.stats.values()]
        .filter((x) => x.resolvedCalls >= minResolved)
        .sort((a, b) => b.hitRate - a.hitRate || b.resolvedCalls - a.resolvedCalls || a.wallet.localeCompare(b.wallet))
        .slice(0, limit)
        .map((x) => ({ ...x }));
    },
    async getTraderStats(wallet) {
      const x = s.stats.get(wallet);
      return x ? { ...x } : null;
    },
    async positionsForWallet(wallet) {
      return (s.positions.get(wallet) ?? []).map((p) => ({ ...p }));
    },
    async getMarkets(ids) {
      return ids.flatMap((id) => {
        const m = s.markets.get(id);
        return m
          ? [{ id: m.id, address: m.address, title: m.title, status: m.status, outcome: m.outcome, creatorWallet: m.creatorWallet, creatorVerified: m.creatorVerified }]
          : [];
      });
    },
    async recentTrades(limit) {
      return [...s.trades.values()].sort(byTimeDesc).slice(0, limit).map((t) => ({ ...t }));
    },
    async counts() {
      const markets = [...s.markets.values()];
      return {
        markets: markets.length,
        callers: s.stats.size,
        trades: s.trades.size,
        resolved: markets.filter((m) => m.status === "resolved").length,
      };
    },
    async lastSyncedAt() {
      let max: number | null = null;
      for (const x of s.stats.values()) max = Math.max(max ?? 0, x.updatedAt);
      return max;
    },

    async follow(userId, wallet) {
      let m = s.follows.get(userId);
      if (!m) s.follows.set(userId, (m = new Map()));
      if (m.has(wallet)) return false;
      m.set(wallet, Math.floor(Date.now() / 1000));
      return true;
    },
    async unfollow(userId, wallet) {
      return s.follows.get(userId)?.delete(wallet) ?? false;
    },
    async listFollows(userId) {
      return [...(s.follows.get(userId) ?? new Map<string, number>()).entries()]
        .map(([wallet, createdAt]) => ({ wallet, createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt || a.wallet.localeCompare(b.wallet));
    },

    async getSettings(userId) {
      return view(userId);
    },
    async updateSettings(userId, u) {
      if (u.slippageBps < 0 || u.slippageBps > 500) throw new Error("slippage_bps check violated"); // mirrors the DB check
      Object.assign(userRow(userId), u);
      return view(userId);
    },
  };
}

/** One shared instance per server process (survives Next dev module reloads). */
export function getSharedMemoryDataStore(): DataStore {
  const g = globalThis as unknown as { __copycallMemoryData?: DataStore };
  return (g.__copycallMemoryData ??= createMemoryDataStore());
}
