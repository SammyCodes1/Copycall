/**
 * Regression tests for the batch 2 audit (copycall-audit/batch2-report.md):
 * B2-01 link hijack, B2-02 defang, B2-03 follow-cap race, B2-04 sync stall,
 * B2-05/06 webhook secret + always-200, B2-07 rank + public rate limits,
 * B2-11 alert retries.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import creatorsJson from "@/fixtures/creators.json";
import { GET as leaderboardRoute } from "@/app/api/leaderboard/route";
import { GET as traderRoute } from "@/app/api/trader/[wallet]/route";
import { POST as webhookRoute } from "@/app/api/telegram/webhook/route";
import { alertTitle, defang, formatAlert } from "@/lib/alert-message";
import { getAuthDeps } from "@/lib/auth";
import type { DataStore, StoredStats } from "@/lib/data-store";
import { ensureMockData, getDataStore } from "@/lib/data";
import { createMemoryDataStore, createMemoryState } from "@/lib/mock/data-store-memory";
import { createMemoryAuthStore } from "@/lib/mock/auth-store-memory";
import * as panta from "@/lib/panta";
import { PantaError } from "@/lib/panta-error";
import { allowPublicRead, PUBLIC_READ_LIMIT } from "@/lib/public-limit";
import { getTraderProfile } from "@/lib/queries";
import { ALERT_RETRY, runAlerts, runLeaderboardSync, type AlertDeps, type SyncDeps } from "@/lib/sync";
import { createLinkCode, handleLinkConfirm, handleStart } from "@/lib/telegram-core";
import { isValidWebhookSecret } from "@/lib/telegram-routes";
import { cleanText } from "@/lib/text";
import { MAX_FOLLOWS, followTrader } from "@/lib/user-core";
import { apiRequest, signedInUser } from "./helpers/session";
import { testWallet } from "./helpers/wallet";

const creators = creatorsJson as Record<string, string>;
const ORIGIN = "http://localhost:3000";
const nowSec = () => Math.floor(Date.now() / 1000);
const VICTIM_WALLET = "VicTim1111111111111111111111111111111111111";
const ATTACKER_WALLET = "AttAck2222222222222222222222222222222222222";

afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------ B2-01
describe("B2-01 Telegram linking needs an explicit, informed confirmation", () => {
  const victimChat = { id: 1001, type: "private" };

  async function setup() {
    const state = createMemoryState();
    const store = createMemoryDataStore(state);
    const victim = randomUUID();
    const attacker = randomUUID();
    // The victim links their own chat first.
    const v = await createLinkCode(store, victim, VICTIM_WALLET, nowSec());
    const q = await handleStart(store, victimChat, v.code);
    await handleLinkConfirm(store, { chat: victimChat, fromId: victimChat.id, data: q.buttons![0][0].callback_data });
    return { state, store, victim, attacker };
  }

  it("/start only shows the wallet and asks; nothing is linked until the button", async () => {
    const { store, victim, attacker } = await setup();
    const { code } = await createLinkCode(store, attacker, ATTACKER_WALLET, nowSec());
    const q = await handleStart(store, victimChat, code);
    expect(q.text).toContain("Link this chat to Copycall wallet Att…".slice(0, 36)); // shows the wallet
    expect(q.text).toContain("AttA…2222");
    expect(q.text).toContain("currently gets alerts for wallet VicT…1111"); // warns about the move
    expect(q.buttons?.[0]?.[0]).toEqual({ text: "Link wallet AttA…2222", callback_data: `link:${code}` });
    expect(q.buttons?.[1]?.[0]?.callback_data).toBe("cancel");
    // Still linked to the victim, code not consumed.
    expect((await store.getSettings(victim))?.telegramLinked).toBe(true);
    expect((await store.getSettings(attacker))?.telegramLinked).toBe(false);
    expect(await store.peekLinkCode((await import("@/lib/telegram-core")).hashLinkCode(code))).not.toBeNull();
    // Cancel changes nothing.
    expect((await handleLinkConfirm(store, { chat: victimChat, fromId: victimChat.id, data: "cancel" })).reply).toMatch(
      /Nothing was linked/,
    );
    expect((await store.getSettings(victim))?.telegramLinked).toBe(true);
  });

  it("if confirmed anyway, the victim is told in-chat and their settings show 'Telegram unlinked'", async () => {
    const { store, victim, attacker } = await setup();
    const { code } = await createLinkCode(store, attacker, ATTACKER_WALLET, nowSec());
    const r = await handleLinkConfirm(store, { chat: victimChat, fromId: victimChat.id, data: `link:${code}` });
    expect(r.reply).toMatch(/^Linked to wallet AttA…2222/);
    expect(r.reply).toContain("Wallet VicT…1111 was unlinked from this chat");
    const vs = await store.getSettings(victim);
    expect(vs?.telegramLinked).toBe(false);
    expect(vs?.telegramUnlinkedAt).toBeGreaterThan(0);
    // Relinking clears the marker.
    const again = await createLinkCode(store, victim, VICTIM_WALLET, nowSec());
    await handleLinkConfirm(store, { chat: victimChat, fromId: victimChat.id, data: `link:${again.code}` });
    expect((await store.getSettings(victim))?.telegramUnlinkedAt).toBeNull();
  });

  it("moving an account to a new chat notifies the old chat", async () => {
    const { store, victim } = await setup();
    const { code } = await createLinkCode(store, victim, VICTIM_WALLET, nowSec());
    const newChat = { id: 2002, type: "private" };
    const r = await handleLinkConfirm(store, { chat: newChat, fromId: newChat.id, data: `link:${code}` });
    expect(r.notices).toEqual([
      { chatId: victimChat.id, text: expect.stringMatching(/moved to another Telegram chat/) },
    ]);
    expect(await store.linkedWalletForChat(victimChat.id)).toBeNull();
    expect(await store.linkedWalletForChat(newChat.id)).toBe(VICTIM_WALLET);
  });

  it("rejects button presses from groups, from someone else, and forged data", async () => {
    const { store, attacker } = await setup();
    const { code } = await createLinkCode(store, attacker, ATTACKER_WALLET, nowSec());
    const data = `link:${code}`;
    expect((await handleLinkConfirm(store, { chat: { id: -5, type: "group" }, fromId: 7, data })).reply).toMatch(
      /directly/,
    );
    expect((await handleLinkConfirm(store, { chat: victimChat, fromId: 999, data })).reply).toMatch(/directly/);
    expect((await handleLinkConfirm(store, { chat: undefined, fromId: 1, data })).reply).toMatch(/directly/);
    for (const bad of ["link:short", "link:" + "a".repeat(65), "unlink:" + code, "", undefined]) {
      expect((await handleLinkConfirm(store, { chat: victimChat, fromId: victimChat.id, data: bad })).reply).toMatch(
        /isn't valid/,
      );
    }
    expect((await store.getSettings(attacker))?.telegramLinked).toBe(false);
  });
});

// ------------------------------------------------------------------ B2-02
describe("B2-02 alert titles are defanged with an allow-list", () => {
  const cases: [string, string][] = [
    ["evile\u0301.com/x", "evilé[.]com/x"],
    ["evil\u200d.com", "evil[.]com"],
    ["evil\u200b.com", "evil[.]com"],
    ["evil\u00ad.com", "evil[.]com"],
    ["evil\u2060.com", "evil[.]com"],
    ["evil\ufeff.com", "evil[.]com"],
    ["evil\u061c.com", "evil[.]com"],
    ["evil。com", "evil[.]com"],
    ["evil．com", "evil[.]com"],
    ["evil｡com", "evil[.]com"],
    ["ｅｖｉｌ.ｃｏｍ", "evil[.]com"], // fullwidth letters (NFKC)
    ["1.2.3.4/x", "1[.]2[.]3[.]4/x"],
    ["10.0.0.1:8080", "10[.]0[.]0[.]1:8080"],
    ["tap /stop now", "tap [/]stop now"],
    ["/start abc", "[/]start abc"],
    ["join #pump", "join [#]pump"],
    ["ask @support_bot", "ask @\u200bsupport_bot"],
    ["see https://x.io", "see https[:]//x[.]io"],
    ["x\u0332.y\u0332", "x[.]y"],
  ];
  it.each(cases)("%j -> %j", (input, want) => {
    expect(alertTitle(input)).toBe(want);
  });

  it("keeps plain decimals and ordinary slashes readable", () => {
    expect(alertTitle("Will SOL close above $3.50 by 0.1%?")).toBe("Will SOL close above $3.50 by 0.1%?");
    expect(alertTitle("50/50 odds, yes/no")).toBe("50/50 odds, yes/no");
  });

  it("no dot survives between alphanumerics (fuzz)", () => {
    const pieces = ["a", "7", "é", "\u0301", "\u200b", "\u00ad", ".", "。", "．", "｡", " ", "/", "@", "#", ":", "-"];
    for (let i = 0; i < 3000; i++) {
      let s = "";
      for (let j = 0; j < 10; j++) s += pieces[Math.floor(Math.random() * pieces.length)];
      const out = alertTitle(s);
      const bare = out.replace(/\[\.\]/g, "");
      // A remaining "." between two alphanumerics must be a plain decimal like 7.7
      for (const m of bare.matchAll(/[\p{L}\p{N}]\.[\p{L}\p{N}]/gu)) {
        expect(m[0], JSON.stringify({ s, out })).toMatch(/^\d\.\d$/);
      }
      expect(out).not.toMatch(/\p{Cf}(?<!@\u200b)/u);
    }
  });

  it("defangs first, then truncates to 120 without splitting a [.] (B2-08)", () => {
    for (let n = 110; n < 125; n++) {
      const out = alertTitle(`${"x".repeat(n)}.com and more text here`);
      expect(Array.from(out).length).toBeLessThanOrEqual(120);
      expect(out).not.toMatch(/\[\.?…$|\[…/);
    }
    const t = formatAlert({
      appOrigin: ORIGIN,
      tradeId: randomUUID(),
      leaderWallet: VICTIM_WALLET,
      hitRate: 0.5,
      resolvedCalls: 6,
      side: "YES",
      title: "a.b ".repeat(80),
      isCreatorTrade: false,
      creatorVerified: false,
      mock: false,
    });
    expect(Array.from(t.split("'")[1]).length).toBeLessThanOrEqual(120);
  });

  it("cleanText strips every Cf character (B2-09)", () => {
    expect(cleanText("a\u061cb\u200bc\u200cd\u200de\u2060f\u2061g\u2062h\u2063i\u2064j\ufeffk\u00adl")).toBe(
      "abcdefghijkl",
    );
    expect(defang("evil.com")).toBe("evil[.]com");
  });
});

// ------------------------------------------------------------------ B2-03
describe("B2-03 the 50-follow cap holds under concurrency", () => {
  it("49 follows + 20 concurrent requests end at exactly 50", async () => {
    const state = createMemoryState();
    const inner = createMemoryDataStore(state);
    const wallets = Array.from({ length: 70 }, () => testWallet().address);
    for (const w of wallets) {
      await inner.upsertTraderStats({
        wallet: w,
        resolvedCalls: 5,
        correctCalls: 3,
        hitRate: 0.6,
        openPositions: 0,
        lastActive: null,
        creatorTradeCount: 0,
        recentResults: "",
        updatedAt: nowSec(),
      });
    }
    // Yield on every read so concurrent requests interleave like real DB round trips.
    const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
    const data: DataStore = {
      ...inner,
      getTraderStats: async (w) => (await tick(), inner.getTraderStats(w)),
      listFollows: async (u) => (await tick(), inner.listFollows(u)),
      follow: async (u, w, max) => (await tick(), inner.follow(u, w, max)),
    };
    const u = await signedInUser();
    for (const w of wallets.slice(0, 49)) expect(await inner.follow(u.userId, w, MAX_FOLLOWS)).toBe("followed");

    const deps = { auth: getAuthDeps(), data };
    const results = await Promise.all(
      wallets.slice(49, 69).map((w) =>
        followTrader(deps, apiRequest("POST", "/api/follow", { body: { wallet: w }, cookie: u.cookie })).then(
          () => "ok",
          (e: { code?: string }) => e.code ?? "error",
        ),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "FOLLOW_LIMIT")).toHaveLength(19);
    expect(await inner.listFollows(u.userId)).toHaveLength(MAX_FOLLOWS);
    // Re-following an existing wallet at the cap is fine (idempotent, not a new row).
    expect(await inner.follow(u.userId, wallets[0], MAX_FOLLOWS)).toBe("already");
  });
});

// ------------------------------------------------------------------ B2-04
describe("B2-04 one bad item no longer stalls the sync", () => {
  function deps(over: Partial<SyncDeps["panta"]> = {}, now = () => Date.now()) {
    const state = createMemoryState();
    const store = createMemoryDataStore(state);
    const d: SyncDeps = {
      store,
      panta: {
        listMarkets: panta.listMarkets,
        getMarketTrades: panta.getMarketTrades,
        getPositions: panta.getPositions,
        ...over,
      },
      getMarketCreator: async (id) => (creators[id] ? { creator: creators[id] } : null),
      now,
      log: () => {},
    };
    return { d, state, store };
  }

  it("a failing market tape is skipped and backed off; the rest sync", async () => {
    let t = Date.now();
    let bad: string | null = null;
    let badCalls = 0;
    const { d, store } = deps(
      {
        getMarketTrades: async (id, n) => {
          bad ??= id; // the first market in line is the poisoned one
          if (id === bad) {
            badCalls++;
            throw new PantaError(500, "INTERNAL", "boom");
          }
          return panta.getMarketTrades(id, n);
        },
      },
      () => t,
    );
    const s1 = await runLeaderboardSync(d);
    expect(s1.failed.tapes).toBe(1);
    expect(s1.tapesFetched).toBeGreaterThan(0);
    expect(s1.walletsRefreshed).toBeGreaterThan(0);
    expect(s1.stoppedEarly).toEqual([]);
    // Next run a minute later: the bad market is backing off, not first in line again.
    t += 60_000;
    const due = await store.marketsNeedingTrades(1000, Math.floor(t / 1000));
    expect(due.map((m) => m.id)).not.toContain(bad);
    await runLeaderboardSync(d);
    expect(badCalls).toBe(1);
    // After the 10-minute backoff it is retried.
    t += 11 * 60_000;
    expect((await store.marketsNeedingTrades(1000, Math.floor(t / 1000))).map((m) => m.id)).toContain(bad);
  });

  it("non-Panta errors (e.g. a schema error) are isolated too", async () => {
    let first = true;
    const { d } = deps({
      getMarketTrades: async (id, n) => {
        if (first) {
          first = false;
          throw new TypeError("unexpected shape");
        }
        return panta.getMarketTrades(id, n);
      },
    });
    const s = await runLeaderboardSync(d);
    expect(s.failed.tapes).toBe(1);
    expect(s.tapesFetched).toBeGreaterThan(0);
  });

  it("a failing wallet is skipped and backed off; other wallets refresh", async () => {
    let bad: string | null = null;
    const { d, store } = deps({
      getPositions: async (w) => {
        bad ??= w;
        if (w === bad) throw new PantaError(502, "BAD_GATEWAY", "upstream");
        return panta.getPositions(w);
      },
    });
    const s = await runLeaderboardSync(d);
    expect(s.failed.wallets).toBe(1);
    expect(s.walletsRefreshed).toBeGreaterThan(0);
    expect(await store.walletsToRefresh(1000, nowSec() + 60)).not.toContain(bad);
  });

  it("a failing market page doesn't stop tapes, creators or positions", async () => {
    const { d } = deps({
      listMarkets: async (p) => {
        if (p.cursor) throw new PantaError(500, "INTERNAL", "page 2 broken");
        return panta.listMarkets(p);
      },
    });
    const s = await runLeaderboardSync(d);
    expect(s.marketsSeen).toBeGreaterThan(0);
    expect(s.tapesFetched).toBeGreaterThan(0);
    expect(s.walletsRefreshed).toBeGreaterThan(0);
  });

  it("only 429 aborts a phase", async () => {
    let n = 0;
    const { d } = deps({
      getMarketTrades: async (id, lim) => {
        if (++n === 2) throw new PantaError(429, "RATE_LIMITED", "slow");
        return panta.getMarketTrades(id, lim);
      },
    });
    const s = await runLeaderboardSync(d);
    expect(s.stoppedEarly).toContain("trades:rate_limited");
    expect(s.tapesFetched).toBe(1);
    expect(s.failed.tapes).toBe(0);
  });
});

// ------------------------------------------------------------------ B2-05 / B2-06
describe("B2-05/06 webhook secret policy and always-200", () => {
  const body = JSON.stringify({ update_id: 1 });
  const req = (secret: string, b: BodyInit = body, extra: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/telegram/webhook`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json", ...extra },
      body: b,
    });
  afterEach(() => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it("the route rejects weak or malformed configured secrets, even with a matching header", async () => {
    for (const weak of [
      "a",
      "x".repeat(31),
      "has space".padEnd(40, "x"),
      "é".repeat(40),
      "x".repeat(257),
      "abc+/=".padEnd(40, "y"),
    ]) {
      process.env.TELEGRAM_WEBHOOK_SECRET = weak;
      expect(isValidWebhookSecret(weak)).toBe(false);
      expect((await webhookRoute(req(weak))).status, weak).toBe(401);
    }
    const good = randomBytes(32).toString("base64url");
    expect(isValidWebhookSecret(good)).toBe(true);
    expect(isValidWebhookSecret("x".repeat(256))).toBe(true);
  });

  it("isTelegramConfigured is false with a weak secret", async () => {
    const { isTelegramConfigured } = await import("@/lib/telegram");
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.TELEGRAM_WEBHOOK_SECRET = "short";
    expect(isTelegramConfigured()).toBe(false);
    process.env.TELEGRAM_WEBHOOK_SECRET = randomBytes(32).toString("base64url");
    expect(isTelegramConfigured()).toBe(true);
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("after a valid secret: oversized, malformed and wrong-shape bodies all get 200 (dropped)", async () => {
    const secret = randomBytes(32).toString("base64url");
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const big = JSON.stringify({ update_id: 1, pad: "x".repeat(70_000) });
    expect((await webhookRoute(req(secret, big))).status).toBe(200);
    expect((await webhookRoute(req(secret, "{}", { "content-length": "999999" }))).status).toBe(200);
    expect((await webhookRoute(req(secret, "not json"))).status).toBe(200);
    expect((await webhookRoute(req(secret, JSON.stringify({ update_id: "x" })))).status).toBe(200);
    expect((await webhookRoute(req(secret, "[]"))).status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
    // Wrong secret is still 401.
    expect((await webhookRoute(req(randomBytes(32).toString("base64url")))).status).toBe(401);
  });
});

// ------------------------------------------------------------------ B2-07
describe("B2-07 rank without loading the board, and public read limits", () => {
  beforeAll(async () => {
    await ensureMockData();
  }, 20_000);

  it("traderRank matches the leaderboard order for every ranked wallet", async () => {
    const store = getDataStore();
    const board = await store.leaderboard(5, 1000);
    expect(board.length).toBeGreaterThan(0);
    for (const [i, s] of board.entries()) expect(await store.traderRank(s.wallet, 5)).toBe(i + 1);
  });

  it("the trader profile never calls leaderboard()", async () => {
    const store = getDataStore();
    const spy = vi.spyOn(store, "leaderboard");
    const top = (await store.leaderboard(5, 1))[0] as StoredStats;
    spy.mockClear();
    const p = await getTraderProfile(top.wallet);
    expect(p?.stats?.rank).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("/api/leaderboard and /api/trader are limited per IP", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const get = (path: string, from = ip) => new Request(`${ORIGIN}${path}`, { headers: { "x-forwarded-for": from } });
    for (let i = 0; i < PUBLIC_READ_LIMIT; i++)
      expect((await leaderboardRoute(get("/api/leaderboard"))).status).toBe(200);
    const limited = await leaderboardRoute(get("/api/leaderboard"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await leaderboardRoute(get("/api/leaderboard", "203.0.113.9"))).status).toBe(200); // other IPs unaffected

    const wallet = (await getDataStore().leaderboard(5, 1))[0].wallet;
    const ctx = { params: Promise.resolve({ wallet }) } as Parameters<typeof traderRoute>[1];
    for (let i = 0; i < PUBLIC_READ_LIMIT; i++)
      expect((await traderRoute(get(`/api/trader/${wallet}`), ctx)).status).toBe(200);
    expect((await traderRoute(get(`/api/trader/${wallet}`), ctx)).status).toBe(429);
  }, 30_000);

  it("the limiter fails open for reads if its store is down", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = { hitRateLimit: async () => Promise.reject(new Error("db down")) };
    expect(await allowPublicRead(store, new Request(ORIGIN), "leaderboard")).toBe(true);
    err.mockRestore();
    const mem = createMemoryAuthStore();
    const r = new Request(ORIGIN, { headers: { "x-forwarded-for": "192.0.2.77" } });
    for (let i = 0; i < 3; i++) expect(await allowPublicRead(mem, r, "trader-page", 3)).toBe(true);
    expect(await allowPublicRead(mem, r, "trader-page", 3)).toBe(false);
  });
});

// ------------------------------------------------------------------ B2-11 alert retries
describe("B2-11 failed alerts are retried, bounded", () => {
  async function setup() {
    const state = createMemoryState();
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
    const userId = randomUUID();
    await store.follow(userId, leader, 50);
    state.follows.get(userId)!.set(leader, 0);
    const { code } = await createLinkCode(store, userId, VICTIM_WALLET, nowSec());
    await handleLinkConfirm(store, { chat: { id: 31337, type: "private" }, fromId: 31337, data: `link:${code}` });
    return { state, store };
  }
  const alertDeps = (store: DataStore, send: AlertDeps["send"]): AlertDeps => ({
    store,
    panta: { getWalletTrades: panta.getWalletTrades, getMarket: panta.getMarket },
    getMarketCreator: async () => null,
    send,
    appOrigin: ORIGIN,
    mock: true,
    log: () => {},
  });

  it("retries a failed send on a later run and stops after 3 attempts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:10Z")); // start of a mock-trade minute
    const { state, store } = await setup();
    let fail = true;
    const sent: number[] = [];
    const send = async (chatId: number) => {
      if (fail) throw new Error("telegram 502");
      sent.push(chatId);
    };
    const s1 = await runAlerts(alertDeps(store, send));
    expect(s1.failed).toBe(1);
    const alert = [...state.alerts.values()][0];
    expect(alert).toMatchObject({ status: "failed", attempts: 1 });

    // Too soon: no retry.
    vi.setSystemTime(new Date("2026-09-30T10:00:40Z"));
    expect((await runAlerts(alertDeps(store, send))).retried).toBe(0);

    // Two minutes later it is retried and succeeds.
    fail = false;
    vi.setSystemTime(new Date("2026-09-30T10:02:30Z"));
    const s3 = await runAlerts(alertDeps(store, send));
    expect(s3.retried).toBe(1);
    expect(sent).toContain(31337);
    expect(alert).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("gives up after maxAttempts and never retries alerts older than 30 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T11:00:10Z"));
    const { state, store } = await setup();
    const send = async () => {
      throw new Error("down");
    };
    await runAlerts(alertDeps(store, send));
    const alert = [...state.alerts.values()][0];
    for (let i = 1; i <= 4; i++) {
      vi.setSystemTime(new Date(Date.parse("2026-09-30T11:00:10Z") + i * 3 * 60_000));
      await runAlerts(alertDeps(store, send));
    }
    expect(alert.attempts).toBe(ALERT_RETRY.maxAttempts);
    expect(alert.status).toBe("failed");

    // A stale pending alert (e.g. a crashed run) is retried only while fresh.
    alert.status = "pending";
    alert.attempts = 0;
    alert.lastAttemptAt = null;
    vi.setSystemTime(new Date(alert.createdAt * 1000 + 31 * 60_000));
    expect((await store.claimAlertRetries(ALERT_RETRY)).map((a) => a.id)).not.toContain(alert.id);
  });
});
