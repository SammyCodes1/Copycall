import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GET as alertsCron } from "@/app/api/cron/alerts/route";
import { POST as linkRoute } from "@/app/api/telegram/link/route";
import { POST as webhookRoute } from "@/app/api/telegram/webhook/route";
import { copyUrl, defang, formatAlert, type AlertInput } from "@/lib/alert-message";
import { createMemoryDataStore, createMemoryState, type MemoryState } from "@/lib/mock/data-store-memory";
import * as panta from "@/lib/panta";
import { MOCK_LIVE_TRADE_EVERY_SEC, mockLiveTrade } from "@/lib/mock/panta-mock";
import type { PantaTradeRow } from "@/lib/schemas";
import { runAlerts, runLeaderboardSync, type AlertDeps } from "@/lib/sync";
import { createLinkCode, handleLinkConfirm, handleStart, handleStop, hashLinkCode } from "@/lib/telegram-core";
import type { DataStore } from "@/lib/data-store";
import { safeTitle } from "@/lib/text";
import creatorsJson from "@/fixtures/creators.json";
import { apiRequest, signedInUser } from "./helpers/session";

const creators = creatorsJson as Record<string, string>;
const ORIGIN = "http://localhost:3000";
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WALLET = "2UqHDhTNCV9HD3ZAeHjRtSBkyWsB2x3Uzzc8WmWbUELj";

/** /start <code> then press the "Link wallet" button, as a user would. Returns the final reply text. */
async function startAndConfirm(store: DataStore, chat: { id: number; type: string }, code: string): Promise<string> {
  const q = await handleStart(store, chat, code);
  const data = q.buttons?.[0]?.[0]?.callback_data;
  if (!data) return q.text;
  return (await handleLinkConfirm(store, { chat, fromId: chat.id, data })).reply;
}

describe("POST /api/telegram/webhook", () => {
  const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: "private" }, text: "/stop" } };
  const req = (headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(update),
    });

  it("returns 401 without the secret header, with a wrong one, or when no secret is configured", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = randomBytes(32).toString("base64url");
    expect((await webhookRoute(req())).status).toBe(401);
    expect((await webhookRoute(req({ "x-telegram-bot-api-secret-token": "" }))).status).toBe(401);
    expect(
      (await webhookRoute(req({ "x-telegram-bot-api-secret-token": randomBytes(32).toString("base64url") }))).status,
    ).toBe(401);
    const good = process.env.TELEGRAM_WEBHOOK_SECRET;
    expect((await webhookRoute(req({ "x-telegram-bot-api-secret-token": good.slice(0, -1) }))).status).toBe(401);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect((await webhookRoute(req({ "x-telegram-bot-api-secret-token": good }))).status).toBe(401);
  });

  it("accepts the right header; after a valid secret malformed bodies are dropped with 200 (B2-06)", async () => {
    const secret = randomBytes(32).toString("base64url");
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    const bad = new Request(`${ORIGIN}/api/telegram/webhook`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: "not json",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await webhookRoute(bad)).status).toBe(200);
    warn.mockRestore();
    // Valid update, no bot token configured: handled (logged) and acknowledged.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await webhookRoute(req({ "x-telegram-bot-api-secret-token": secret }))).status).toBe(200);
    err.mockRestore();
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });
});

describe("Telegram link codes", () => {
  const chat = { id: 424242, type: "private" };

  it("are single-use and link the chat", async () => {
    const state = createMemoryState();
    const store = createMemoryDataStore(state);
    const userId = randomUUID();
    const { code } = await createLinkCode(store, userId, WALLET, Math.floor(Date.now() / 1000));
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(state.linkCodes.has(code)).toBe(false); // stored hashed
    expect(state.linkCodes.has(hashLinkCode(code))).toBe(true);

    expect(await startAndConfirm(store, chat, code)).toMatch(/^Linked to wallet 2UqH…UELj/);
    expect((await store.getSettings(userId))?.telegramLinked).toBe(true);
    expect(await startAndConfirm(store, chat, code)).toMatch(/expired or was already used/);
    expect(await startAndConfirm(store, { id: 99, type: "private" }, code)).toMatch(/expired or was already used/);
  });

  it("expire, are replaced by a newer code, and only work in private chats", async () => {
    const store = createMemoryDataStore();
    const userId = randomUUID();
    const old = await createLinkCode(store, userId, WALLET, Math.floor(Date.now() / 1000) - 3600); // expired an hour ago... TTL 10 min
    expect(await startAndConfirm(store, chat, old.code)).toMatch(/expired/);

    const a = await createLinkCode(store, userId, WALLET, Math.floor(Date.now() / 1000));
    const b = await createLinkCode(store, userId, WALLET, Math.floor(Date.now() / 1000));
    expect(await startAndConfirm(store, chat, a.code)).toMatch(/expired or was already used/); // replaced by b
    expect(await startAndConfirm(store, { id: -100, type: "group" }, b.code)).toMatch(/message me directly/);
    expect(await startAndConfirm(store, chat, b.code)).toMatch(/^Linked/);
    expect(await startAndConfirm(store, chat, "short")).toMatch(/isn't valid/);
  });

  it("/stop pauses alerts for the linked chat", async () => {
    const store = createMemoryDataStore();
    const userId = randomUUID();
    const { code } = await createLinkCode(store, userId, WALLET, Math.floor(Date.now() / 1000));
    await startAndConfirm(store, chat, code);
    expect(await handleStop(store, chat)).toMatch(/paused/);
    expect((await store.getSettings(userId))?.alertsEnabled).toBe(false);
    expect(await handleStop(store, chat)).toMatch(/No active alerts/);
  });

  it("POST /api/telegram/link needs Origin and a session (and reports when Telegram is off)", async () => {
    expect((await linkRoute(apiRequest("POST", "/api/telegram/link"))).status).toBe(401);
    const u = await signedInUser();
    expect(
      (await linkRoute(apiRequest("POST", "/api/telegram/link", { cookie: u.cookie, origin: "https://evil.example" })))
        .status,
    ).toBe(403);
    const off = await linkRoute(apiRequest("POST", "/api/telegram/link", { cookie: u.cookie }));
    expect(off.status).toBe(503);
  });
});

describe("alert messages (addendum G)", () => {
  const base: AlertInput = {
    appOrigin: ORIGIN,
    tradeId: randomUUID(),
    leaderWallet: "2UqHDhTNCV9HD3ZAeHjRtSBkyWsB2x3Uzzc8WmWbUELj",
    hitRate: 0.857,
    resolvedCalls: 7,
    side: "YES",
    title: "Will SOL close above $300 on Oct 31?",
    isCreatorTrade: false,
    creatorVerified: false,
    mock: false,
  };

  it("links only to APP_URL/copy/<trade id>", () => {
    const text = formatAlert(base);
    const urls = text.match(/https?:\/\/\S+/g)!;
    expect(urls).toEqual([`${ORIGIN}/copy/${base.tradeId}`]);
    expect(urls[0]).toMatch(new RegExp(`^${ORIGIN}/copy/${UUID_RE}$`));
    expect(urls[0]).not.toMatch(/[?#&=]|amount|side|yes|price|market/i);
    expect(text).toContain("2UqH…UELj (hit rate 86%, 7 calls) bought YES on 'Will SOL close above $300 on Oct 31?'.");
    expect(() => copyUrl(ORIGIN, "abc?amount=100")).toThrow();
    expect(() => copyUrl(ORIGIN, `${base.tradeId}/../x`)).toThrow();
  });

  it("truncates titles to 120 chars, strips control/bidi characters and defangs links", () => {
    // (defang first, then truncate: the quoted title is at most 120 characters, B2-08)
    const long = "A".repeat(300);
    expect(safeTitle(long)).toHaveLength(120);
    expect(safeTitle(long).endsWith("…")).toBe(true);
    expect(safeTitle("Hi\u202e moc.live\u0007\nthere")).toBe("Hi moc.live there");
    const text = formatAlert({ ...base, title: `Claim at https://evil.example/x or @scam_bot ${"B".repeat(200)}` });
    const quoted = text.split("'")[1];
    expect(Array.from(quoted).length).toBeLessThanOrEqual(120);
    expect(text).not.toContain("https://evil");
    expect(text).not.toContain("evil.example");
    expect(text).not.toMatch(/@scam_bot/);
    expect(text.match(/https?:\/\/\S+/g)).toEqual([`${ORIGIN}/copy/${base.tradeId}`]);
    expect(defang("SOL at 3.50?")).toBe("SOL at 3.50?");
  });

  it("includes the creator flag, marked unverified", () => {
    expect(formatAlert({ ...base, isCreatorTrade: true })).toContain("◆ Creator trade (unverified)");
    expect(formatAlert(base)).not.toContain("◆");
  });
});

describe("alerts job", () => {
  async function setup() {
    const state: MemoryState = createMemoryState();
    const store = createMemoryDataStore(state);
    await runLeaderboardSync({
      store,
      panta: {
        listMarkets: panta.listMarkets,
        getMarketTrades: panta.getMarketTrades,
        getPositions: panta.getPositions,
      },
      getMarketCreator: async (id) => (creators[id] ? { creator: creators[id] } : null),
    });
    const leader = (await store.leaderboard(5, 1))[0].wallet;
    return { state, store, leader };
  }
  const deps = (store: AlertDeps["store"], over: Partial<AlertDeps> = {}): AlertDeps => ({
    store,
    panta: { getWalletTrades: panta.getWalletTrades, getMarket: panta.getMarket },
    getMarketCreator: async (id) => (creators[id] ? { creator: creators[id] } : null),
    send: null,
    appOrigin: ORIGIN,
    mock: true,
    ...over,
  });

  it("alerts followers about new buys once, logging them without Telegram", async () => {
    const { store, state, leader } = await setup();
    const userId = randomUUID();
    await store.follow(userId, leader, 50);
    state.follows.get(userId)!.set(leader, 0); // followed long ago
    const logs: string[] = [];
    const s1 = await runAlerts(deps(store, { log: (m) => logs.push(m) }));
    expect(s1.alertsCreated).toBe(1);
    expect(s1.logged).toBe(1);
    expect(logs.join("\n")).toMatch(new RegExp(`Copy: ${ORIGIN}/copy/${UUID_RE}`));
    const alert = [...state.alerts.values()][0];
    expect(alert.status).toBe("logged");

    // Same minute again: nothing new (dedupe by signature + unique (user, trade)).
    const s2 = await runAlerts(deps(store));
    expect(s2.alertsCreated).toBe(0);
  });

  it("sends via Telegram when linked, skips unlinked users, ignores trades before the follow", async () => {
    const { store, state, leader } = await setup();
    const linked = randomUUID();
    const unlinked = randomUUID();
    const late = randomUUID();
    for (const u of [linked, unlinked, late]) await store.follow(u, leader, 50);
    state.follows.get(linked)!.set(leader, 0);
    state.follows.get(unlinked)!.set(leader, 0);
    state.follows.get(late)!.set(leader, Math.floor(Date.now() / 1000) + 3600); // followed "after" the trade
    const { code } = await createLinkCode(store, linked, WALLET, Math.floor(Date.now() / 1000));
    await startAndConfirm(store, { id: 777, type: "private" }, code);

    const sent: { chatId: number; text: string }[] = [];
    const s = await runAlerts(deps(store, { send: async (chatId, text) => void sent.push({ chatId, text }) }));
    expect(s.sent).toBe(1);
    expect(s.skipped).toBe(1);
    expect(sent[0].chatId).toBe(777);
    expect(sent[0].text.match(/https?:\/\/\S+/g)).toHaveLength(1);
    expect([...state.alerts.values()].some((a) => a.userId === late)).toBe(false);
  });

  it("does nothing for users with alerts off", async () => {
    const { store, state, leader } = await setup();
    const userId = randomUUID();
    await store.follow(userId, leader, 50);
    state.follows.get(userId)!.set(leader, 0);
    await store.updateSettings(userId, { maxStakeUsdc: "5.00", slippageBps: 200, alertsEnabled: false });
    expect((await runAlerts(deps(store))).alertsCreated).toBe(0);
  });

  it("mock live trades are deterministic per minute and dedupe by signature", () => {
    const w = Object.values(creators)[0];
    const t0 = 1_800_000_000_000;
    const a = mockLiveTrade(w, t0) as PantaTradeRow;
    expect(mockLiveTrade(w, t0 + 1000)?.signature).toBe(a.signature);
    expect(mockLiveTrade(w, t0 + MOCK_LIVE_TRADE_EVERY_SEC * 1000)?.signature).not.toBe(a.signature);
  });

  it("GET /api/cron/alerts requires the bearer secret", async () => {
    process.env.CRON_SECRET = randomBytes(24).toString("base64url");
    const url = `${ORIGIN}/api/cron/alerts`;
    expect((await alertsCron(new Request(url))).status).toBe(401);
    expect((await alertsCron(new Request(`${url}?secret=${process.env.CRON_SECRET}`))).status).toBe(401);
    const ok = await alertsCron(new Request(url, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    expect(ok.status).toBe(200);
  }, 20_000);
});
