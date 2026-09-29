/**
 * Stateless signed session tokens (HMAC-SHA256 with SESSION_SECRET).
 * Format: base64url(JSON payload) + "." + base64url(HMAC).
 * Server-side only (uses node:crypto), but has no server-only import so tests can use it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-cc_session";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days (addendum E)

export type SessionPayload = {
  v: 1;
  uid: string; // users.id
  w: string; // wallet
  iat: number; // unix seconds
  exp: number; // unix seconds
};

function mac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signSession(p: { uid: string; wallet: string }, secret: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = { v: 1, uid: p.uid, w: p.wallet, iat, exp: iat + SESSION_TTL_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/** Returns the payload if the signature is valid and not expired, else null. */
export function verifySession(token: string | undefined, secret: string, nowMs = Date.now()): SessionPayload | null {
  if (!token || token.length > 2048) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (p.v !== 1 || typeof p.uid !== "string" || typeof p.w !== "string") return null;
    if (typeof p.exp !== "number" || p.exp * 1000 <= nowMs) return null;
    return p;
  } catch {
    return null;
  }
}
