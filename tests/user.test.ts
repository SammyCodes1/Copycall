import { beforeAll, describe, expect, it } from "vitest";
import { DELETE as unfollowRoute, POST as followRoute } from "@/app/api/follow/route";
import { GET as getSettingsRoute, PUT as putSettingsRoute } from "@/app/api/settings/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { ensureMockData, getDataStore } from "@/lib/data";
import { apiRequest, signedInUser } from "./helpers/session";

let leader: string;

beforeAll(async () => {
  await ensureMockData();
  leader = (await getDataStore().leaderboard(5, 1))[0].wallet;
}, 20_000);

const valid = { maxStakeUsdc: "12.50", slippageBps: 300, alertsEnabled: false };

describe("POST/DELETE /api/follow", () => {
  it("requires a session", async () => {
    const res = await followRoute(apiRequest("POST", "/api/follow", { body: { wallet: leader } }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("UNAUTHENTICATED");
    expect((await unfollowRoute(apiRequest("DELETE", "/api/follow", { body: { wallet: leader } }))).status).toBe(401);
  });

  it("requires Origin == APP_URL, even with a valid session", async () => {
    const u = await signedInUser();
    for (const origin of ["https://evil.example", "http://localhost:3001", null]) {
      const res = await followRoute(
        apiRequest("POST", "/api/follow", { body: { wallet: leader }, cookie: u.cookie, origin }),
      );
      expect(res.status).toBe(403);
    }
    expect(await getDataStore().listFollows(u.userId)).toEqual([]);
  });

  it("follows and unfollows with a session and the right Origin", async () => {
    const u = await signedInUser();
    const res = await followRoute(apiRequest("POST", "/api/follow", { body: { wallet: leader }, cookie: u.cookie }));
    expect(res.status).toBe(200);
    expect((await getDataStore().listFollows(u.userId)).map((f) => f.wallet)).toEqual([leader]);
    const del = await unfollowRoute(
      apiRequest("DELETE", "/api/follow", { body: { wallet: leader }, cookie: u.cookie }),
    );
    expect(del.status).toBe(200);
    expect(await getDataStore().listFollows(u.userId)).toEqual([]);
  });

  it("rejects invalid bodies, unknown wallets, self-follows and revoked sessions", async () => {
    const u = await signedInUser();
    const post = (body: unknown, cookie = u.cookie) => followRoute(apiRequest("POST", "/api/follow", { body, cookie }));
    expect((await post({ wallet: "nope" })).status).toBe(400);
    expect((await post({ wallet: leader, userId: "someone-else" })).status).toBe(400); // strict: no extra fields
    expect((await post({ wallet: "Vote111111111111111111111111111111111111111" })).status).toBe(404);
    expect((await post({ wallet: u.wallet })).status).toBe(400);

    await logoutRoute(apiRequest("POST", "/api/auth/logout", { cookie: u.cookie }));
    expect((await post({ wallet: leader })).status).toBe(401);
  });
});

describe("GET/PUT /api/settings", () => {
  it("returns defaults (5 USDC, 200 bps, alerts on) and needs a session", async () => {
    expect((await getSettingsRoute(apiRequest("GET", "/api/settings"))).status).toBe(401);
    const u = await signedInUser();
    const res = await getSettingsRoute(apiRequest("GET", "/api/settings", { cookie: u.cookie }));
    expect(await res.json()).toEqual({
      maxStakeUsdc: "5.00",
      slippageBps: 200,
      alertsEnabled: true,
      telegramLinked: false,
      telegramUnlinkedAt: null,
    });
  });

  it("saves valid settings", async () => {
    const u = await signedInUser();
    const res = await putSettingsRoute(apiRequest("PUT", "/api/settings", { body: valid, cookie: u.cookie }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ maxStakeUsdc: "12.50", slippageBps: 300, alertsEnabled: false });
  });

  it("rejects slippage above 500 bps (5%) even if the client sends it", async () => {
    const u = await signedInUser();
    for (const slippageBps of [501, 1000, 5000, -1, 2.5]) {
      const res = await putSettingsRoute(
        apiRequest("PUT", "/api/settings", { body: { ...valid, slippageBps }, cookie: u.cookie }),
      );
      expect(res.status, String(slippageBps)).toBe(400);
    }
    const res = await putSettingsRoute(
      apiRequest("PUT", "/api/settings", { body: { ...valid, slippageBps: 500 }, cookie: u.cookie }),
    );
    expect(res.status).toBe(200);
    const after = await (await getSettingsRoute(apiRequest("GET", "/api/settings", { cookie: u.cookie }))).json();
    expect(after.slippageBps).toBe(500);
  });

  it("rejects bad stakes, extra fields, bad Origin and no session", async () => {
    const u = await signedInUser();
    const put = (body: unknown, o: { origin?: string | null; cookie?: string } = {}) =>
      putSettingsRoute(apiRequest("PUT", "/api/settings", { body, cookie: o.cookie ?? u.cookie, origin: o.origin }));
    for (const maxStakeUsdc of ["0", "0.99", "1000.01", "5.001", "abc", -5]) {
      expect((await put({ ...valid, maxStakeUsdc })).status, String(maxStakeUsdc)).toBe(400);
    }
    expect((await put({ ...valid, telegramChatId: 1 })).status).toBe(400);
    expect((await put(valid, { origin: "https://evil.example" })).status).toBe(403);
    expect((await putSettingsRoute(apiRequest("PUT", "/api/settings", { body: valid }))).status).toBe(401);
  });
});
