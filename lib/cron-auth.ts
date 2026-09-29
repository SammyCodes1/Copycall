/**
 * Cron route auth (hard requirement 7 + addendum D).
 * Only "Authorization: Bearer <CRON_SECRET>" is accepted, compared in constant
 * time. The query string is never consulted, so ?secret=... does nothing.
 * Fails closed if CRON_SECRET is missing or too short.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_CRON_SECRET_LENGTH = 16;

function digest(v: string): Buffer {
  return createHash("sha256").update(v, "utf8").digest();
}

/** Constant-time string equality (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function isAuthorizedCron(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return safeEqual(match[1], secret);
}

export function unauthorizedCron(): Response {
  return Response.json(
    { code: "UNAUTHORIZED", message: "Unauthorized" },
    { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" } },
  );
}
