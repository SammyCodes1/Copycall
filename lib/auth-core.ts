/**
 * Wallet login core logic (hard requirement 8 + addenda E, F, H).
 * Dependencies (store, clock, config) are injected so this is unit-testable;
 * lib/auth.ts wires in the real env, store and cookies.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AuthStore } from "./auth-store";
import { NonceRequestSchema, VerifyRequestSchema } from "./schemas";
import { signSession } from "./session";
import { NONCE_TTL_MS, buildSignInMessage, verifyWalletSignature } from "./siws";

export const NONCE_RATE_LIMIT = 10; // per IP
export const NONCE_RATE_WINDOW_SEC = 60;

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

/** Best-effort client IP (Vercel sets x-forwarded-for). Hashed before storage. */
export function clientIpKey(request: Request): string {
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = xff || request.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
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
  if (!allowed) throw new AuthError(429, "RATE_LIMITED", "Too many sign-in attempts. Try again in a minute.");

  const parsed = NonceRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_WALLET", "Invalid wallet address");
  const { wallet } = parsed.data;

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
  const parsed = VerifyRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_REQUEST", "Invalid sign-in request");
  const { wallet, nonce, signature } = parsed.data;

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

  const userId = await deps.store.upsertUser(wallet);
  const token = signSession({ uid: userId, wallet }, deps.sessionSecret, nowMs);
  return { wallet, userId, token };
}
