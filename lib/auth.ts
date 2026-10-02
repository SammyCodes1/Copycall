import "server-only";
/**
 * Server wiring for wallet login: picks the AuthStore, reads config from env,
 * and manages the session cookie. Logic lives in lib/auth-core.ts.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AuthError, resolveSession, type AuthDeps } from "./auth-core";
import type { AuthStore } from "./auth-store";
import { supabaseAuthStore } from "./auth-store-supabase";
import { getAppOrigin, getSessionSecret, isMockMode } from "./env";
import { getSharedMemoryAuthStore } from "./mock/auth-store-memory";
import { SESSION_COOKIE, SESSION_TTL_SEC, type SessionPayload } from "./session";

/** Mock mode uses the in-memory store (never in production); otherwise Supabase. */
export function getAuthStore(): AuthStore {
  return isMockMode() ? getSharedMemoryAuthStore() : supabaseAuthStore;
}

export function getAuthDeps(): AuthDeps {
  return { store: getAuthStore(), appOrigin: getAppOrigin(), sessionSecret: getSessionSecret() };
}

/** Cookie flags required by addendum E. */
export function sessionCookieOptions(maxAge = SESSION_TTL_SEC) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge };
}

/**
 * Current session from the request cookie, or null. For server components and
 * routes. Checks the signature, expiry and the server-side session_version
 * (so logged-out tokens are rejected).
 */
export async function getSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await resolveSession({ store: getAuthStore(), sessionSecret: getSessionSecret() }, token);
  } catch {
    return null; // e.g. SESSION_SECRET not configured yet
  }
}

/** Uniform JSON error response. Never includes stack traces or env values. */
export function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ ...err.details, code: err.code, message: err.message }, { status: err.status });
  }
  console.error("[auth] unexpected error", err instanceof Error ? err.message : err);
  return NextResponse.json({ code: "INTERNAL_ERROR", message: "Something went wrong" }, { status: 500 });
}
