/**
 * Signed-in user routes: follow/unfollow and settings (MVP feature 5).
 * Rules for every state-changing request (addendum E):
 *  - Origin must equal APP_URL (checked first)
 *  - a live session (signature, expiry AND server-side session_version)
 *  - a zod-validated body; unknown fields are rejected
 * user_id always comes from the session, never from the request.
 * Dependencies are injected so this is unit-testable.
 */
import { AuthError, assertSameOrigin, readJsonBody, resolveSession, type AuthDeps } from "./auth-core";
import type { DataStore } from "./data-store";
import { FollowRequestSchema, SettingsRequestSchema } from "./schemas";
import { SESSION_COOKIE, type SessionPayload } from "./session";

export type UserDeps = { auth: AuthDeps; data: DataStore };

export const FOLLOW_RATE_LIMIT = 30; // per user per minute
export const SETTINGS_RATE_LIMIT = 20; // per user per minute
export const MAX_FOLLOWS = 50; // bounds the alerts job per user

/** Session cookie from a raw Cookie header (route handlers and tests alike). */
export function sessionTokenFrom(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

export async function requireSession(deps: UserDeps, request: Request): Promise<SessionPayload> {
  const session = await resolveSession(deps.auth, sessionTokenFrom(request));
  if (!session) throw new AuthError(401, "UNAUTHENTICATED", "Sign in with your wallet first");
  return session;
}

/** Origin check, then session, then per-user rate limit. */
async function requireWrite(deps: UserDeps, request: Request, bucket: string, limit: number) {
  assertSameOrigin(request, deps.auth.appOrigin);
  const session = await requireSession(deps, request);
  const ok = await deps.auth.store.hitRateLimit(`${bucket}:user:${session.uid}`, limit, 60);
  if (!ok) throw new AuthError(429, "RATE_LIMITED", "Too many requests. Try again in a minute.");
  return session;
}

async function parseFollow(request: Request) {
  const parsed = FollowRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_WALLET", "Invalid wallet address");
  return parsed.data.wallet;
}

/** POST /api/follow { wallet } */
export async function followTrader(deps: UserDeps, request: Request) {
  const session = await requireWrite(deps, request, "follow", FOLLOW_RATE_LIMIT);
  const wallet = await parseFollow(request);
  if (wallet === session.w) throw new AuthError(400, "SELF_FOLLOW", "You can't follow your own wallet");
  // Only wallets we track can be followed (keeps the alerts job bounded to real traders).
  if (!(await deps.data.getTraderStats(wallet)))
    throw new AuthError(404, "TRADER_NOT_FOUND", "We don't track this wallet yet");
  // The cap is enforced inside the store in one atomic step (B2-03), not check-then-act here.
  const r = await deps.data.follow(session.uid, wallet, MAX_FOLLOWS);
  if (r === "limit") throw new AuthError(400, "FOLLOW_LIMIT", `You can follow up to ${MAX_FOLLOWS} traders`);
  return { wallet, following: true };
}

/** DELETE /api/follow { wallet } */
export async function unfollowTrader(deps: UserDeps, request: Request) {
  const session = await requireWrite(deps, request, "follow", FOLLOW_RATE_LIMIT);
  const wallet = await parseFollow(request);
  await deps.data.unfollow(session.uid, wallet);
  return { wallet, following: false };
}

/** GET /api/settings (read-only: session required, no Origin check needed for GET). */
export async function readSettings(deps: UserDeps, request: Request) {
  const session = await requireSession(deps, request);
  const settings = await deps.data.getSettings(session.uid);
  if (!settings) throw new AuthError(401, "UNAUTHENTICATED", "Sign in with your wallet first");
  return settings;
}

/** PUT /api/settings { maxStakeUsdc, slippageBps, alertsEnabled } */
export async function writeSettings(deps: UserDeps, request: Request) {
  const session = await requireWrite(deps, request, "settings", SETTINGS_RATE_LIMIT);
  const parsed = SettingsRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AuthError(400, "INVALID_SETTINGS", issue?.message ?? "Invalid settings");
  }
  return deps.data.updateSettings(session.uid, parsed.data);
}
