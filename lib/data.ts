import "server-only";
/**
 * Server wiring for app data: picks the DataStore (memory in mock mode,
 * Supabase otherwise) and the real Panta / Solana dependencies for jobs.
 */
import { getAuthDeps } from "./auth";
import type { DataStore } from "./data-store";
import { supabaseDataStore } from "./data-store-supabase";
import { isMockMode } from "./env";
import { getSharedMemoryDataStore } from "./mock/data-store-memory";
import * as panta from "./panta";
import { getMarketCreator } from "./solana";
import { runLeaderboardSync, type SyncDeps } from "./sync";
import type { UserDeps } from "./user-core";

export function getDataStore(): DataStore {
  return isMockMode() ? getSharedMemoryDataStore() : supabaseDataStore;
}

/** Deps for signed-in user routes (lib/user-core.ts). */
export function getUserDeps(): UserDeps {
  return { auth: getAuthDeps(), data: getDataStore() };
}

/** Uniform JSON response for route handlers. */
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
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
