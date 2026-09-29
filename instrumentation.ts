import { assertBootSafe } from "./lib/boot";

/**
 * Runs once when a Next.js server instance starts (see Next.js "instrumentation").
 * Throwing here stops the server from serving requests (security addendum I).
 */
export function register() {
  assertBootSafe(process.env);
}
