import { z } from "zod";
import { readEnv } from "@/lib/env";
import { isAuthorizedWebhook, readBodyCapped } from "@/lib/telegram-routes";

export const dynamic = "force-dynamic";

const UpdateSchema = z.object({ update_id: z.number().int() }).passthrough();

const ok = () => Response.json({ ok: true });

/**
 * POST /api/telegram/webhook - Telegram updates.
 *  - 401 unless TELEGRAM_WEBHOOK_SECRET is valid (32-256 of [A-Za-z0-9_-]) and
 *    X-Telegram-Bot-Api-Secret-Token matches it in constant time (fails closed).
 *  - After a valid secret the answer is ALWAYS 200 (audit B2-06): oversized,
 *    malformed or failing updates are dropped, so Telegram never retries them.
 */
export async function POST(request: Request) {
  if (!isAuthorizedWebhook(request, readEnv().TELEGRAM_WEBHOOK_SECRET)) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }
  let update: z.infer<typeof UpdateSchema> | null = null;
  try {
    const text = await readBodyCapped(request);
    if (text === null) {
      console.warn("[telegram/webhook] dropped oversized update");
      return ok();
    }
    const parsed = UpdateSchema.safeParse(JSON.parse(text));
    if (parsed.success) update = parsed.data;
  } catch {
    update = null;
  }
  if (!update) {
    console.warn("[telegram/webhook] dropped malformed update");
    return ok();
  }

  try {
    const { getBot } = await import("@/lib/telegram");
    const bot = await getBot();
    // grammY validates the update shape itself; handlers only reply in plain text.
    await bot.handleUpdate(update as unknown as Parameters<typeof bot.handleUpdate>[0]);
  } catch (err) {
    console.error("[telegram/webhook] update failed", err instanceof Error ? err.message : "error");
  }
  return ok();
}
