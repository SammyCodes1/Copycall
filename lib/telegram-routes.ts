/**
 * Telegram route logic, testable without grammY or the network.
 */
import { AuthError, assertSameOrigin } from "./auth-core";
import { safeEqual } from "./cron-auth";
import { createLinkCode } from "./telegram-core";
import { requireSession, type UserDeps } from "./user-core";

export const LINK_RATE_LIMIT = 5; // per user per minute
export const WEBHOOK_BODY_MAX = 64 * 1024;

/**
 * Read at most `max` bytes of the body. Returns null (without buffering the
 * rest) when it is larger, so an oversized update can be dropped cheaply.
 */
export async function readBodyCapped(request: Request, max = WEBHOOK_BODY_MAX): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Telegram's secret_token is 1-256 chars of A-Z a-z 0-9 _ -; we also require >= 32
 * for strength. Enforced here, not only in the setup script (audit B2-05).
 */
export const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
export function isValidWebhookSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && WEBHOOK_SECRET_RE.test(secret);
}

/** Webhook auth (hard requirement 6): the header must match TELEGRAM_WEBHOOK_SECRET, in constant time. */
export function isAuthorizedWebhook(request: Request, secret: string | undefined): boolean {
  if (!isValidWebhookSecret(secret)) return false; // missing or weak: fail closed, reject everything
  const header = request.headers.get("x-telegram-bot-api-secret-token");
  if (header === null) return false;
  return safeEqual(header, secret);
}

/** POST /api/telegram/link: new one-time code for the signed-in user. */
export async function createTelegramLink(deps: UserDeps, request: Request, nowSec: number, configured = true) {
  assertSameOrigin(request, deps.auth.appOrigin);
  const session = await requireSession(deps, request);
  // Checked after auth so anonymous callers learn nothing about server config.
  if (!configured) {
    throw new AuthError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "Telegram isn't set up on this server. Alerts are logged instead.",
    );
  }
  const ok = await deps.auth.store.hitRateLimit(`tglink:user:${session.uid}`, LINK_RATE_LIMIT, 60);
  if (!ok) throw new AuthError(429, "RATE_LIMITED", "Too many requests. Try again in a minute.");
  return createLinkCode(deps.data, session.uid, session.w, nowSec);
}
