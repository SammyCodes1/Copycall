/**
 * Wallet login core logic (hard requirement 8 + addenda E, F, H).
 * Dependencies (store, clock, config) are injected so this is unit-testable;
 * lib/auth.ts wires in the real env, store and cookies.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AuthStore } from "./auth-store";
import { NonceRequestSchema, VerifyRequestSchema } from "./schemas";
import { signSession, verifySession, type SessionPayload } from "./session";
import { NONCE_TTL_MS, buildSignInMessage, isAllowedSignInWallet, verifyWalletSignature } from "./siws";

export const NONCE_RATE_LIMIT = 10; // per IP
export const NONCE_RATE_WINDOW_SEC = 60;
export const VERIFY_RATE_LIMIT = 10; // per IP and, separately, per wallet
export const VERIFY_RATE_WINDOW_SEC = 60;

const RATE_LIMITED_MESSAGE = "Too many sign-in attempts. Try again in a minute.";

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthDeps = {
  store: AuthStore;
  appOrigin: string; // exact origin of APP_URL
  sessionSecret: string;
  now?: () => number;
};

function domainOf(origin: string): string {
  return new URL(origin).host;
}

/**
 * CSRF guard (addendum E): state-changing requests must carry an Origin header
 * exactly equal to APP_URL's origin. A missing Origin is rejected too.
 */
export function assertSameOrigin(request: Request, appOrigin: string): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== appOrigin) {
    throw new AuthError(403, "BAD_ORIGIN", "Request origin not allowed");
  }
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Best-effort client IP (Vercel sets x-forwarded-for). Hashed before storage. */
export function clientIpKey(request: Request): string {
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = xff || request.headers.get("x-real-ip")?.trim() || "unknown";
  return hashKey(ip);
}

/** Read and parse a small JSON body (rejects bodies over 2 KB). */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 2048) throw new AuthError(413, "BODY_TOO_LARGE", "Request body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthError(400, "INVALID_JSON", "Invalid JSON body");
  }
}

/** POST /api/auth/nonce */
export async function issueNonce(deps: AuthDeps, request: Request) {
  assertSameOrigin(request, deps.appOrigin);
  const allowed = await deps.store.hitRateLimit(
    `nonce:ip:${clientIpKey(request)}`,
    NONCE_RATE_LIMIT,
    NONCE_RATE_WINDOW_SEC,
  );
  if (!allowed) throw new AuthError(429, "RATE_LIMITED", RATE_LIMITED_MESSAGE);

  const parsed = NonceRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_WALLET", "Invalid wallet address");
  const { wallet } = parsed.data;
  // Programs, sysvars, PDAs (off-curve) and small-order keys have no private
  // key; refuse to start a sign-in for them (audit F-01).
  if (!isAllowedSignInWallet(wallet)) {
    throw new AuthError(400, "UNSUPPORTED_WALLET", "This address can't be used to sign in");
  }

  const nowMs = (deps.now ?? Date.now)();
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + NONCE_TTL_MS);
  await deps.store.createNonce(nonce, wallet, expiresAt);

  const message = buildSignInMessage({
    domain: domainOf(deps.appOrigin),
    uri: deps.appOrigin,
    wallet,
    nonce,
    issuedAt,
    expiresAt,
  });
  return { nonce, message, expiresAt: expiresAt.toISOString() };
}

/** POST /api/auth/verify - returns a signed session token on success. */
export async function verifyLogin(deps: AuthDeps, request: Request) {
  assertSameOrigin(request, deps.appOrigin);
  // 0. Rate-limit per IP before doing any work, then per wallet once parsed.
  const ipOk = await deps.store.hitRateLimit(
    `verify:ip:${clientIpKey(request)}`,
    VERIFY_RATE_LIMIT,
    VERIFY_RATE_WINDOW_SEC,
  );
  if (!ipOk) throw new AuthError(429, "RATE_LIMITED", RATE_LIMITED_MESSAGE);

  const parsed = VerifyRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_REQUEST", "Invalid sign-in request");
  const { wallet, nonce, signature } = parsed.data;

  const walletOk = await deps.store.hitRateLimit(
    `verify:wallet:${hashKey(wallet)}`,
    VERIFY_RATE_LIMIT,
    VERIFY_RATE_WINDOW_SEC,
  );
  if (!walletOk) throw new AuthError(429, "RATE_LIMITED", RATE_LIMITED_MESSAGE);
  if (!isAllowedSignInWallet(wallet)) {
    throw new AuthError(400, "UNSUPPORTED_WALLET", "This address can't be used to sign in");
  }

  // 1. Burn the nonce first (atomic). Any later failure still leaves it used,
  //    so a nonce can never be retried or reused.
  const expiresAt = await deps.store.consumeNonce(nonce, wallet);
  if (!expiresAt) throw new AuthError(401, "INVALID_NONCE", "Sign-in request is invalid or already used");

  // 2. Reject expired nonces.
  const nowMs = (deps.now ?? Date.now)();
  if (expiresAt.getTime() <= nowMs) throw new AuthError(401, "NONCE_EXPIRED", "Sign-in request expired. Try again.");

  // 3. Rebuild the exact message from server-side values and verify the
  //    ed25519 signature against the wallet's own key (signer must == wallet).
  const message = buildSignInMessage({
    domain: domainOf(deps.appOrigin),
    uri: deps.appOrigin,
    wallet,
    nonce,
    issuedAt: new Date(expiresAt.getTime() - NONCE_TTL_MS),
    expiresAt,
  });
  if (!verifyWalletSignature(message, signature, wallet)) {
    throw new AuthError(401, "BAD_SIGNATURE", "Signature does not match this wallet");
  }

  const user = await deps.store.upsertUser(wallet);
  const token = signSession({ uid: user.id, wallet, sessionVersion: user.sessionVersion }, deps.sessionSecret, nowMs);
  return { wallet, userId: user.id, token };
}

/**
 * Resolve a session cookie to its payload, or null. Checks the HMAC and expiry
 * and then the user's current session_version in the store, so a token is
 * dead as soon as the user logs out (or the version is bumped for any reason).
 * Fails closed: if the store can't be reached, there is no session.
 */
export async function resolveSession(
  deps: Pick<AuthDeps, "store" | "sessionSecret" | "now">,
  token: string | undefined,
): Promise<SessionPayload | null> {
  const nowMs = (deps.now ?? Date.now)();
  const payload = verifySession(token, deps.sessionSecret, nowMs);
  if (!payload) return null;
  try {
    const current = await deps.store.getSessionVersion(payload.uid);
    return current !== null && current === payload.sv ? payload : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/logout. Requires a same-origin request; if the cookie holds a
 * live session, bumps the user's session_version so this token (and any copy
 * of it) is rejected from now on. The route always clears the cookie.
 */
export async function logout(deps: AuthDeps, request: Request, token: string | undefined): Promise<{ revoked: boolean }> {
  assertSameOrigin(request, deps.appOrigin);
  const session = await resolveSession(deps, token);
  if (!session) return { revoked: false };
  await deps.store.bumpSessionVersion(session.uid);
  return { revoked: true };
}
