/**
 * Launch cap (pure; no server-only so scripts and tests can use it).
 *  MAX_STAKE_USDC: the most USDC any single copy may move, fee included, whatever the
 *  user's saved max stake. Server-enforced at quote, build, simulation and confirm.
 *  - Real mode: REQUIRED. Missing, malformed, zero or above STAKE_CAP_CEILING_USDC
 *    fails closed (copies answer 503); it never falls back to "no limit".
 *  - Mock mode: defaults to 5 when unset (a bad value is still an error).
 *  - Plain decimal, at most 6 dp, > 0 and <= 1000. Errors name the variable, never its value.
 */
import { toMicro, usdcExact } from "./copy-math";

export const STAKE_CAP_CEILING_USDC = "1000";
export const MOCK_STAKE_CAP_USDC = "5";
const CAP_RE = /^\d{1,4}(\.\d{1,6})?$/;

export class StakeCapError extends Error {}

/** MAX_STAKE_USDC in USDC base units. Throws StakeCapError when missing (real mode) or invalid. */
export function stakeCapFromEnv(env: Record<string, string | undefined>, mock: boolean): bigint {
  const raw = (env.MAX_STAKE_USDC ?? "").trim();
  if (raw === "") {
    if (mock) return toMicro(MOCK_STAKE_CAP_USDC);
    throw new StakeCapError("MAX_STAKE_USDC is required in real mode (USDC, e.g. 5)");
  }
  const bad = () =>
    new StakeCapError(`MAX_STAKE_USDC must be a plain decimal above 0 and at most ${STAKE_CAP_CEILING_USDC}, max 6 decimals`);
  if (!CAP_RE.test(raw)) throw bad();
  const base = toMicro(raw);
  if (base <= 0n || base > toMicro(STAKE_CAP_CEILING_USDC)) throw bad();
  return base;
}

/** For display: "5" -> "5.00", "2.5" -> "2.50". */
export function formatCap(base: bigint): string {
  return usdcExact(base);
}
