/**
 * Per-IP rate limits for public reads (audit B2-07): /api/leaderboard,
 * /api/trader/[wallet] and the /trader/[wallet] page. Uses the same
 * rate_limit_hit store as sign-in (IPs are hashed before storage).
 */
import { clientIpKey } from "./auth-core";
import type { AuthStore } from "./auth-store";

export const PUBLIC_READ_LIMIT = 60; // per IP per minute, per bucket
export type PublicBucket = "leaderboard" | "trader" | "trader-page";

/**
 * True when the request may proceed. If the limiter itself is down, public
 * reads stay available (fail open, logged): they are cached, read-only and
 * never call Panta on a request.
 */
export async function allowPublicRead(
  store: Pick<AuthStore, "hitRateLimit">,
  request: Request | { headers: Pick<Headers, "get"> },
  bucket: PublicBucket,
  limit = PUBLIC_READ_LIMIT,
): Promise<boolean> {
  try {
    return await store.hitRateLimit(`pub:${bucket}:ip:${clientIpKey(request)}`, limit, 60);
  } catch (err) {
    console.error("[rate-limit] public read limiter unavailable", err instanceof Error ? err.message : "error");
    return true;
  }
}

export function rateLimitedResponse(): Response {
  return Response.json(
    { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." },
    { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
  );
}
