import { authErrorResponse } from "@/lib/auth";
import { getUserDeps, json } from "@/lib/data";
import { createTelegramLink } from "@/lib/telegram-routes";
import { botStartLink, isTelegramConfigured } from "@/lib/telegram";

/**
 * POST /api/telegram/link -> { url: "https://t.me/<bot>?start=<code>", expiresAt }
 * One-time code, 10-minute expiry, stored hashed. Session + Origin required.
 */
export async function POST(request: Request) {
  try {
    const { code, expiresAt } = await createTelegramLink(
      getUserDeps(),
      request,
      Math.floor(Date.now() / 1000),
      isTelegramConfigured(),
    );
    return json({ url: await botStartLink(code), expiresAt: new Date(expiresAt * 1000).toISOString() });
  } catch (err) {
    return authErrorResponse(err);
  }
}
