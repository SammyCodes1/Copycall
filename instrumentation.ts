import { assertBootSafe, isMockFlagOn } from "./lib/boot";
import { checkStakeCapAtBoot } from "./lib/stake-cap";

/**
 * Runs once when a Next.js server instance starts (see Next.js "instrumentation").
 * Throwing here stops the server from serving requests (security addendum I).
 */
export function register() {
  assertBootSafe(process.env);
  // Q-01: MAX_STAKE_USDC below MIN_STAKE_USDC disables copying; say so once at startup.
  checkStakeCapAtBoot(process.env, isMockFlagOn(process.env));
}
