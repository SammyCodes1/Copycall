import "server-only";
/**
 * Server wiring for the copy and claim flows: mock chain + memory stores in
 * mock mode, SOLANA_RPC_URL + Supabase otherwise.
 */
import { AuthError } from "./auth-core";
import type { FlowDeps } from "./copy-core";
import { supabaseCopyStore } from "./copy-store-supabase";
import { getUserDeps } from "./data";
import { isMockMode, readEnv } from "./env";
import { MOCK_PROGRAM_ID, getSharedMockChain } from "./mock/chain-mock";
import { getSharedMemoryCopyStore } from "./mock/copy-store-memory";
import * as panta from "./panta";
import { PubkeySchema } from "./schemas";
import { rpcChain } from "./solana";

/** PANTA_PROGRAM_IDS as a set. Real mode fails closed if it's missing or malformed. */
export function pantaProgramIds(): ReadonlySet<string> {
  if (isMockMode()) return new Set([MOCK_PROGRAM_ID]);
  const raw = readEnv().PANTA_PROGRAM_IDS ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => PubkeySchema.safeParse(id).success)) {
    throw new AuthError(503, "NOT_CONFIGURED", "Copying isn't configured on this server yet");
  }
  return new Set(ids);
}

export function getFlowDeps(): FlowDeps {
  const mock = isMockMode();
  return {
    ...getUserDeps(),
    copy: mock ? getSharedMemoryCopyStore() : supabaseCopyStore,
    panta: {
      quotePrimaryOrder: panta.quotePrimaryOrder,
      buildPrimaryOrder: panta.buildPrimaryOrder,
      buildClaim: panta.buildClaim,
      reportTrade: panta.reportTrade,
      getPositions: panta.getPositions,
    },
    chain: mock ? getSharedMockChain() : rpcChain,
    pantaProgramIds: pantaProgramIds(),
    mock,
    log: (m) => console.info(`[copy] ${m}`),
  };
}
