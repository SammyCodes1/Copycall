import "server-only";
/**
 * Server wiring for app data: picks the DataStore (memory in mock mode,
 * Supabase otherwise) and the real Panta / Solana dependencies for jobs.
 */
import type { DataStore } from "./data-store";
import { supabaseDataStore } from "./data-store-supabase";
import { isMockMode } from "./env";
import { getSharedMemoryDataStore } from "./mock/data-store-memory";
import * as panta from "./panta";
import { getMarketCreator } from "./solana";
import { runLeaderboardSync, type SyncDeps } from "./sync";

export function getDataStore(): DataStore {
  return isMockMode() ? getSharedMemoryDataStore() : supabaseDataStore;
}

export function getSyncDeps(): SyncDeps {
  return {
    store: getDataStore(),
    panta: { listMarkets: panta.listMarkets, getMarketTrades: panta.getMarketTrades, getPositions: panta.getPositions },
    getMarketCreator,
    log: (m) => console.info(`[sync] ${m}`),
  };
}

/**
 * Mock mode only: the in-memory store starts empty on every server start, so
 * the first page view runs one sync over the fixtures (no network; fixtures
 * only). In real mode data only ever comes from the cron job.
 */
export async function ensureMockData(): Promise<void> {
  if (!isMockMode()) return;
  const g = globalThis as unknown as { __copycallMockSync?: Promise<unknown> };
  g.__copycallMockSync ??= runLeaderboardSync({ ...getSyncDeps(), log: () => {} }).catch((err) => {
    g.__copycallMockSync = undefined;
    throw err;
  });
  await g.__copycallMockSync;
}
