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
import { FeeConfigError, feeConfigFromEnv, type FeeConfig } from "./fee-config";
import { MOCK_PROGRAM_ID, getSharedMockChain } from "./mock/chain-mock";
import { getSharedMemoryCopyStore } from "./mock/copy-store-memory";
import * as panta from "./panta";
import { PubkeySchema } from "./schemas";
import type { ReportDeps } from "./report-retry";
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

/** Pinned fee model + fee cap. Real mode fails closed (503) without PANTA_FEE_MODEL. */
// E-09: getFlowDeps passes null instead, so only quote and build answer 503 (see feePin in copy-core).
function feeConfigOrNull(): FeeConfig | null {
  try {
    return feeConfig();
  } catch (err) {
    if (err instanceof AuthError) return null;
    throw err;
  }
}

export function feeConfig(): FeeConfig {
  try {
    return feeConfigFromEnv(readEnv(), isMockMode());
  } catch (err) {
    if (err instanceof FeeConfigError) {
      console.error(`[copy] ${err.message}`); // names the variable, never its value
      throw new AuthError(503, "NOT_CONFIGURED", "Copying isn't configured on this server yet");
    }
    throw err;
  }
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
    ...(() => {
      const f = feeConfigOrNull();
      return { feeModel: f?.model ?? null, feeCapBps: f?.feeCapBps ?? null };
    })(),
    mock,
    log: (m) => console.info(`[copy] ${m}`),
    alert: (m) => console.error(`[ALERT] ${m}`),
  };
}

/** Deps for the report-retry cron step (B3-07): only the store and Panta's report endpoint. */
export function getReportDeps(): ReportDeps {
  return {
    copy: isMockMode() ? getSharedMemoryCopyStore() : supabaseCopyStore,
    panta: { reportTrade: panta.reportTrade },
    log: (m) => console.info(`[report] ${m}`),
    alert: (m) => console.error(`[ALERT] ${m}`),
  };
}
