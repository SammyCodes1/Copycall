import "server-only";
import { z } from "zod";
import { assertBootSafe, isMockFlagOn } from "./boot";

/**
 * Server-side environment handling. Every value here is server-only.
 * Values are validated lazily (on first use) so `next build` does not need
 * production secrets, but any route that needs a value fails loudly if it is
 * missing or malformed.
 */

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  PANTA_API_KEY: optionalString,
  PANTA_BASE_URL: optionalString,
  SOLANA_RPC_URL: optionalString,
  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_WEBHOOK_SECRET: optionalString,
  CRON_SECRET: optionalString,
  SESSION_SECRET: optionalString,
  PANTA_PROGRAM_IDS: optionalString,
  MIN_RESOLVED_CALLS: optionalString,
  MOCK_PANTA: optionalString,
  APP_URL: optionalString,
  VERCEL_ENV: optionalString,
});

export type ServerEnv = z.infer<typeof EnvSchema>;

/** Parse the current process env (re-read each call so tests can change it). */
export function readEnv(): ServerEnv {
  assertBootSafe(process.env);
  return EnvSchema.parse(process.env);
}

/** Mock mode: fixtures + simulated signing + in-memory auth store. Never on in production. */
export function isMockMode(): boolean {
  assertBootSafe(process.env);
  return isMockFlagOn(process.env);
}

/** Throws a clear error naming the missing variable. Never echoes values. */
export function requireEnv<K extends keyof ServerEnv>(key: K): string {
  const value = readEnv()[key];
  if (!value) throw new Error(`Missing required environment variable: ${String(key)}`);
  return value;
}

/** Exact origin of the app, e.g. "https://copycall.app" (no trailing slash). */
export function getAppOrigin(): string {
  const raw = requireEnv("APP_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("APP_URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("APP_URL must use https (http is only allowed for localhost)");
  }
  return url.origin;
}

/** SIWS "domain" = host of APP_URL (includes port for localhost). */
export function getAppDomain(): string {
  return new URL(getAppOrigin()).host;
}

/** HMAC key for session cookies; must be long enough to resist brute force. */
export function getSessionSecret(): string {
  const secret = requireEnv("SESSION_SECRET");
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return secret;
}

export function getMinResolvedCalls(): number {
  const raw = readEnv().MIN_RESOLVED_CALLS;
  const n = raw ? Number.parseInt(raw, 10) : 5;
  return Number.isFinite(n) && n > 0 ? n : 5;
}
