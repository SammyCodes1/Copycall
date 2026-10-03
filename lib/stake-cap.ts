/**
 * Launch cap (pure; no server-only so scripts and tests can use it).
 *  MAX_STAKE_USDC: the most USDC any single copy may move, fee included. Server-enforced at
 *  quote, build, simulation and confirm. A saved max stake above it is refused at quote and
 *  build (STAKE_ABOVE_CAP, H-05), never silently clamped; only confirm clamps the limit.
 *  - Real mode: REQUIRED. Missing, malformed, zero or above STAKE_CAP_CEILING_USDC
 *    fails closed (copies answer 503); it never falls back to "no limit".
 *  - Mock mode: defaults to 5 when unset (a bad value is still an error).
 *  - Plain decimal, at most 6 dp, > 0 and <= 1000. Errors name the variable, never its value.
 */
import { MIN_STAKE_USDC, toMicro, usdcExact } from "./copy-math";

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

/** Q-01: config code when MAX_STAKE_USDC is below MIN_STAKE_USDC (no stake could ever be saved). */
export const STAKE_CAP_BELOW_MIN = "STAKE_CAP_BELOW_MIN";

/**
 * Q-01: the config error when the launch cap is below the minimum stake, or null. Copying is then
 * disabled (quote and build refuse with STAKE_CAP_BELOW_MIN). Names the variables, never the value.
 */
export function stakeCapBelowMinError(capBase: bigint): string | null {
  return capBase < toMicro(String(MIN_STAKE_USDC))
    ? `MAX_STAKE_USDC is below the ${MIN_STAKE_USDC} USDC minimum stake (MIN_STAKE_USDC): copying is disabled`
    : null;
}

/**
 * Startup check (instrumentation.ts register(), once per server instance): logs the
 * below-minimum config error once and returns it. A missing or invalid cap is reported by
 * the existing checks (stakeCapOrNull), so it's not logged again here.
 */
export function checkStakeCapAtBoot(
  env: Record<string, string | undefined>,
  mock: boolean,
  log: (msg: string) => void = (m) => console.error(m),
): string | null {
  let cap: bigint;
  try {
    cap = stakeCapFromEnv(env, mock);
  } catch (err) {
    if (err instanceof StakeCapError) return null;
    throw err;
  }
  const msg = stakeCapBelowMinError(cap);
  if (msg) log(`[copy] ${msg}`);
  return msg;
}

/** For display: "5" -> "5.00", "2.5" -> "2.50". */
export function formatCap(base: bigint): string {
  return usdcExact(base);
}
