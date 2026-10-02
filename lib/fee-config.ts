/**
 * Fee configuration per deployment (pure; no server-only so scripts and tests can use it).
 *  - PANTA_FEE_MODEL = inclusive | on_top: the pinned model. REQUIRED in real mode.
 *    Mock mode defaults to MOCK_PANTA_FEE_MODEL (default inclusive).
 *  - PANTA_FEE_CAP_BPS: fee sanity cap as bps of the stake (D-01). Default 500, 1..1000.
 * Errors name the variable but never echo its value.
 */
import { DEFAULT_FEE_CAP_BPS, MAX_FEE_CAP_BPS } from "./copy-math";
import type { PinnedFeeModel } from "./fee-quote";

export type FeeConfig = { model: PinnedFeeModel; feeCapBps: number };

export class FeeConfigError extends Error {}

function parseModel(v: string | undefined): PinnedFeeModel | null {
  const s = (v ?? "").trim().toLowerCase();
  return s === "inclusive" || s === "on_top" ? s : null;
}

export function feeConfigFromEnv(env: Record<string, string | undefined>, mock: boolean): FeeConfig {
  let model = parseModel(env.PANTA_FEE_MODEL);
  if (!model && (env.PANTA_FEE_MODEL ?? "").trim() !== "")
    throw new FeeConfigError("PANTA_FEE_MODEL must be inclusive or on_top");
  if (!model) {
    if (!mock) throw new FeeConfigError("PANTA_FEE_MODEL is required in real mode (inclusive or on_top)");
    model = parseModel(env.MOCK_PANTA_FEE_MODEL) ?? "inclusive";
  }
  const rawCap = (env.PANTA_FEE_CAP_BPS ?? "").trim();
  // E-07: plain decimal digits only (no 1e2, 0x1f4, +300, 500.0).
  if (rawCap !== "" && !/^\d{1,4}$/.test(rawCap))
    throw new FeeConfigError(`PANTA_FEE_CAP_BPS must be an integer from 1 to ${MAX_FEE_CAP_BPS}`);
  const feeCapBps = rawCap === "" ? DEFAULT_FEE_CAP_BPS : Number(rawCap);
  if (!Number.isInteger(feeCapBps) || feeCapBps < 1 || feeCapBps > MAX_FEE_CAP_BPS)
    throw new FeeConfigError(`PANTA_FEE_CAP_BPS must be an integer from 1 to ${MAX_FEE_CAP_BPS}`);
  return { model, feeCapBps };
}
