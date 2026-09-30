import "server-only";
/**
 * grammY bot, running as a webhook route inside Next.js (MVP features 6-7).
 *  - POST /api/telegram/webhook checks X-Telegram-Bot-Api-Secret-Token first
 *    (constant time) and only then hands the update to grammY.
 *  - /start <code> shows the wallet and asks for an inline-button confirmation;
 *    the button (callback_query) links the chat (audit B2-01). /stop pauses alerts.
 *  - API calls time out after 10 s, well under the crons' 120 s (B2-11).
 *  - Every message is plain text (no parse_mode) with link previews off.
 * If TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET are missing, Telegram is
 * "not configured": the webhook rejects everything and alerts are logged.
 */
import { Bot } from "grammy";
import { getDataStore } from "./data";
import { readEnv } from "./env";
import { HELP_TEXT, handleLinkConfirm, handleStart, handleStop } from "./telegram-core";
import { isValidWebhookSecret } from "./telegram-routes";

/** Telegram API timeout (seconds). Must stay well below the cron maxDuration (120 s). */
export const TELEGRAM_TIMEOUT_SEC = 10;

/** A weak or malformed webhook secret counts as "not configured" (fail closed, B2-05). */
export function isTelegramConfigured(): boolean {
  const env = readEnv();
  return !!env.TELEGRAM_BOT_TOKEN && isValidWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET);
}

function createBot(token: string): Bot {
  const bot = new Bot(token, { client: { timeoutSeconds: TELEGRAM_TIMEOUT_SEC } });
  const plain = { link_preview_options: { is_disabled: true } };
  bot.command("start", async (ctx) => {
    if (!ctx.chat) return;
    const r = await handleStart(getDataStore(), ctx.chat, ctx.match ?? "");
    await ctx.reply(r.text, r.buttons ? { ...plain, reply_markup: { inline_keyboard: r.buttons } } : plain);
  });
  bot.on("callback_query:data", async (ctx) => {
    const msg = ctx.callbackQuery.message;
    const { reply, notices } = await handleLinkConfirm(getDataStore(), {
      chat: msg?.chat,
      fromId: ctx.from.id,
      data: ctx.callbackQuery.data,
    });
    await ctx.answerCallbackQuery().catch(() => {});
    // Replace the question (and its buttons) with the outcome.
    if (msg) await ctx.editMessageText(reply, plain).catch(() => ctx.reply(reply, plain));
    for (const n of notices) {
      await ctx.api.sendMessage(n.chatId, n.text, plain).catch((err) => {
        console.error("[telegram] notice failed", err instanceof Error ? err.message : "error");
      });
    }
  });
  bot.command("stop", async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(await handleStop(getDataStore(), ctx.chat));
  });
  bot.on("message", async (ctx) => {
    if (ctx.chat.type === "private") await ctx.reply(HELP_TEXT);
  });
  bot.catch((err) =>
    console.error("[telegram] handler error", err.error instanceof Error ? err.error.message : "error"),
  );
  return bot;
}

/** One initialised bot per server instance (bot.init() calls getMe once). */
export async function getBot(): Promise<Bot> {
  const token = readEnv().TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured");
  const g = globalThis as unknown as { __copycallBot?: Promise<Bot> };
  g.__copycallBot ??= (async () => {
    const bot = createBot(token);
    await bot.init();
    return bot;
  })().catch((err) => {
    g.__copycallBot = undefined;
    throw err;
  });
  return g.__copycallBot;
}

/** t.me deep link for a one-time code. */
export async function botStartLink(code: string): Promise<string> {
  const bot = await getBot();
  return `https://t.me/${encodeURIComponent(bot.botInfo.username)}?start=${encodeURIComponent(code)}`;
}

/** Send a plain-text alert. */
export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const bot = await getBot();
  await bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
}
