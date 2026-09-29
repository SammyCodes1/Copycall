/**
 * Boot-time safety checks (security addendum I).
 *
 * This module is deliberately dependency-free and NOT marked server-only so it
 * can be used from next.config.ts, instrumentation.ts and unit tests.
 */

export type BootEnv = Record<string, string | undefined>;

/** True when MOCK_PANTA is exactly "true" (case-insensitive). Anything else is off. */
export function isMockFlagOn(env: BootEnv): boolean {
  return (env.MOCK_PANTA ?? "").trim().toLowerCase() === "true";
}

/** True for a Vercel production deployment. */
export function isVercelProduction(env: BootEnv): boolean {
  return (env.VERCEL_ENV ?? "").trim().toLowerCase() === "production";
}

export class UnsafeBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeBootError";
  }
}

/**
 * Throws if the environment is unsafe to boot:
 *  - MOCK_PANTA=true on a Vercel production deployment (fixtures + simulated
 *    signing + in-memory auth must never serve real users).
 */
export function assertBootSafe(env: BootEnv): void {
  if (isMockFlagOn(env) && isVercelProduction(env)) {
    throw new UnsafeBootError(
      "Refusing to boot: MOCK_PANTA=true is not allowed when VERCEL_ENV=production. " +
        "Set MOCK_PANTA=false (and configure real Panta/Supabase credentials) for production.",
    );
  }
}
