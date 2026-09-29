import "server-only";
/**
 * grammY bot, running as a webhook route inside Next.js (MVP features 6-7).
 *  - POST /api/telegram/webhook checks X-Telegram-Bot-Api-Secret-Token first
 *    (constant time) and only then hands the update to grammY.
 *  - Commands: /start <code> links the chat, /stop pauses alerts.
 *  - Every message is plain text (no parse_mode) with link previews off.
 * If TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET are missing, Telegram is
 * "not configured": the webhook rejects everything and alerts are logged.
 */
import { Bot } from "grammy";
import { getDataStore } from "./data";
import { readEnv } from "./env";
import { HELP_TEXT, handleStart, handleStop } from "./telegram-core";

export function isTelegramConfigured(): boolean {
  const env = readEnv();
  return !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_WEBHOOK_SECRET;
}

function createBot(token: string): Bot {
  const bot = new Bot(token);
  bot.command("start", async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(await handleStart(getDataStore(), ctx.chat, ctx.match ?? ""), {
      link_preview_options: { is_disabled: true },
    });
  });
  bot.command("stop", async (ctx) => {
    if (!ctx.chat) return;
    await ctx.reply(await handleStop(getDataStore(), ctx.chat));
  });
  bot.on("message", async (ctx) => {
    if (ctx.chat.type === "private") await ctx.reply(HELP_TEXT);
  });
  bot.catch((err) => console.error("[telegram] handler error", err.error instanceof Error ? err.error.message : "error"));
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
