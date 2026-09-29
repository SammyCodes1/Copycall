import { z } from "zod";
import { readEnv } from "@/lib/env";
import { WEBHOOK_BODY_MAX, isAuthorizedWebhook } from "@/lib/telegram-routes";

export const dynamic = "force-dynamic";

const UpdateSchema = z.object({ update_id: z.number().int() }).passthrough();

/**
 * POST /api/telegram/webhook - Telegram updates. Rejected with 401 unless
 * X-Telegram-Bot-Api-Secret-Token matches TELEGRAM_WEBHOOK_SECRET (set via
 * setWebhook secret_token; see scripts/telegram-set-webhook.mjs).
 */
export async function POST(request: Request) {
  if (!isAuthorizedWebhook(request, readEnv().TELEGRAM_WEBHOOK_SECRET)) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }
  const text = await request.text();
  if (text.length > WEBHOOK_BODY_MAX) return Response.json({ code: "BODY_TOO_LARGE" }, { status: 413 });
  let parsed;
  try {
    parsed = UpdateSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) return Response.json({ code: "INVALID_UPDATE" }, { status: 400 });

  try {
    const { getBot } = await import("@/lib/telegram");
    const bot = await getBot();
    // grammY validates the update shape itself; handlers only reply in plain text.
    await bot.handleUpdate(parsed.data as unknown as Parameters<typeof bot.handleUpdate>[0]);
  } catch (err) {
    // Answer 200 anyway so Telegram doesn't retry the same update forever.
    console.error("[telegram/webhook] update failed", err instanceof Error ? err.message : "error");
  }
  return Response.json({ ok: true });
}
