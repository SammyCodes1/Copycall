/**
 * Telegram route logic, testable without grammY or the network.
 */
import { AuthError, assertSameOrigin } from "./auth-core";
import { safeEqual } from "./cron-auth";
import { createLinkCode } from "./telegram-core";
import { requireSession, type UserDeps } from "./user-core";

export const LINK_RATE_LIMIT = 5; // per user per minute
export const WEBHOOK_BODY_MAX = 64 * 1024;

/** Webhook auth (hard requirement 6): the header must match TELEGRAM_WEBHOOK_SECRET, in constant time. */
export function isAuthorizedWebhook(request: Request, secret: string | undefined): boolean {
  if (!secret) return false; // not configured: reject everything
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
  return createLinkCode(deps.data, session.uid, nowSec);
}
