/**
 * grammY wiring (audit B2-01 + B2-11): the bot is created with a short API
 * timeout, /start replies with an inline confirmation button, and the button
 * (callback_query) links the chat and notifies the previous chat.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (ctx: Record<string, unknown>) => Promise<void>;
const handlers = new Map<string, Handler>();
const botOptions: unknown[] = [];

vi.mock("grammy", () => ({
  Bot: class {
    botInfo = { username: "copycall_test_bot" };
    api = { sendMessage: vi.fn(async () => ({})) };
    constructor(_token: string, opts: unknown) {
      botOptions.push(opts);
    }
    command(name: string, fn: Handler) {
      handlers.set(`command:${name}`, fn);
    }
    on(filter: string, fn: Handler) {
      handlers.set(`on:${filter}`, fn);
    }
    catch() {}
    async init() {}
  },
}));

describe("Telegram bot wiring", () => {
  let getBot: typeof import("@/lib/telegram").getBot;
  let TELEGRAM_TIMEOUT_SEC: number;
  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    ({ getBot, TELEGRAM_TIMEOUT_SEC } = await import("@/lib/telegram"));
    await getBot();
  });

  it("uses a Telegram API timeout well below the cron's 120 s", () => {
    expect(TELEGRAM_TIMEOUT_SEC).toBeLessThan(120);
    expect(botOptions[0]).toEqual({ client: { timeoutSeconds: TELEGRAM_TIMEOUT_SEC } });
  });

  it("/start asks with an inline button; pressing it links and notifies the old chat", async () => {
    const { getDataStore } = await import("@/lib/data");
    const { createLinkCode } = await import("@/lib/telegram-core");
    const store = getDataStore();
    const userId = crypto.randomUUID();
    const wallet = "BtnWa11et1111111111111111111111111111111111";
    const now = Math.floor(Date.now() / 1000);

    // Linked to chat 500 first (via the same button flow).
    const first = await createLinkCode(store, userId, wallet, now);
    const replies: { text: string; opts: Record<string, unknown> }[] = [];
    const chat500 = { id: 500, type: "private" };
    await handlers.get("command:start")!({
      chat: chat500,
      match: first.code,
      reply: async (text: string, opts: Record<string, unknown>) => void replies.push({ text, opts }),
    });
    expect(replies[0].text).toContain("Link this chat to Copycall wallet BtnW…1111?");
    const kb = (replies[0].opts.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
      .inline_keyboard;
    expect(kb[0][0].callback_data).toBe(`link:${first.code}`);
    expect((await store.getSettings(userId))?.telegramLinked).toBe(false); // not yet

    const press = async (chat: { id: number; type: string }, data: string) => {
      const edits: string[] = [];
      const sent: [number, string][] = [];
      const answered = vi.fn(async () => true);
      await handlers.get("on:callback_query:data")!({
        callbackQuery: { data, message: { chat } },
        from: { id: chat.id },
        answerCallbackQuery: answered,
        editMessageText: async (t: string) => void edits.push(t),
        reply: async () => {},
        api: { sendMessage: async (id: number, t: string) => void sent.push([id, t]) },
      });
      expect(answered).toHaveBeenCalled();
      return { edits, sent };
    };
    const r1 = await press(chat500, kb[0][0].callback_data);
    expect(r1.edits[0]).toMatch(/^Linked to wallet BtnW…1111/);
    expect(r1.sent).toEqual([]);
    expect((await store.getSettings(userId))?.telegramLinked).toBe(true);

    // Moving to chat 600 tells chat 500.
    const second = await createLinkCode(store, userId, wallet, now);
    const r2 = await press({ id: 600, type: "private" }, `link:${second.code}`);
    expect(r2.sent).toEqual([[500, expect.stringMatching(/moved to another Telegram chat/)]]);
  });
});
