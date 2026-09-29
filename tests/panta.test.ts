import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import creators from "@/fixtures/creators.json";
import markets from "@/fixtures/markets.json";
import positions from "@/fixtures/positions.json";
import trades from "@/fixtures/trades.json";
import {
  BuildRequestSchema,
  BuildResponseSchema,
  ClaimBuildResponseSchema,
  MarketListResponseSchema,
  MarketSchema,
  PositionSchema,
  PositionsResponseSchema,
  QuoteResponseSchema,
  ReportTradeResponseSchema,
  TradeRowSchema,
} from "@/lib/schemas";

const key = () => bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
const sig = () => bs58.encode(crypto.getRandomValues(new Uint8Array(64)));

describe("fixtures match the documented Panta shapes", () => {
  it("has enough data for a realistic demo", () => {
    const wallets = new Set(trades.map((t) => t.wallet));
    expect(markets.length).toBeGreaterThanOrEqual(20);
    expect(wallets.size).toBeGreaterThanOrEqual(15);
    expect(trades.length).toBeGreaterThanOrEqual(300);
    expect(markets.filter((m) => m.phase === "resolved").length).toBeGreaterThan(0);
    const creatorTrades = trades.filter((t) => (creators as Record<string, string>)[t.marketId] === t.wallet);
    expect(creatorTrades.length).toBeGreaterThanOrEqual(1);
  });

  it("every market parses with MarketSchema", () => {
    for (const m of markets) expect(() => MarketSchema.parse(m)).not.toThrow();
  });

  it("every trade row parses with TradeRowSchema and signatures are unique", () => {
    for (const t of trades) expect(() => TradeRowSchema.parse(t)).not.toThrow();
    expect(new Set(trades.map((t) => t.signature)).size).toBe(trades.length);
  });

  it("every position parses; resolved positions carry an outcome", () => {
    for (const rows of Object.values(positions)) {
      for (const p of rows) {
        const parsed = PositionSchema.parse(p);
        if (parsed.phase === "resolved") expect(parsed.outcome).toMatch(/^(yes|no)$/);
      }
    }
  });
});

describe("documented example payloads parse (docs.panta.market)", () => {
  it("GET /markets/ list row", () => {
    const res = MarketListResponseSchema.parse({
      items: [
        {
          marketId: key(), category: "crypto", title: "ETH above 5k?", description: "…", images: ["https://x"],
          phase: "primary", marketType: "standard", startTime: 1767225600, endTime: 1798761599, resolutionTime: 1798765199,
          region: "Global", resolved: false, status: "open", volumeUsdc: "1200.00", campaignId: null, createdByPartner: true,
          yesPrice: null, noPrice: null, primaryYesPrice: null, primaryNoPrice: null, secondaryYesPrice: null, secondaryNoPrice: null,
        },
      ],
      nextCursor: key(),
    });
    expect(res.items[0].phase).toBe("primary");
  });

  it("quote (with avgPrice), build, claim and report responses", () => {
    const wallet = key();
    const marketId = key();
    expect(
      QuoteResponseSchema.parse({
        quoteId: "qt_1", marketId, side: "yes", amountUsdc: "20.00", shares: "38.42", avgPrice: "0.520800",
        feeUsdc: "0.40", expiresAt: "2026-09-04T16:27:00.000000Z", blockhashExpiryHintSec: 60,
      }).avgPrice,
    ).toBe("0.520800");
    const ix = [{ programId: key(), data: "AA==", accounts: [{ pubkey: wallet, isSigner: true, isWritable: true }] }];
    expect(
      BuildResponseSchema.parse({
        orderId: "ord_1", quoteId: "qt_1", wallet, marketId, side: "yes", amountUsdc: "20.00", expectedShares: "38.40",
        feeUsdc: "0.40", status: "built", instructions: ix, derived: { event: marketId }, recentBlockhash: key(),
        lastValidBlockHeight: 123, expiresAt: "2026-09-04T16:28:00.000000Z", blockhashExpiryHintSec: 60,
      }).instructions,
    ).toHaveLength(1);
    // docs show outcome "YES" here; we normalise to lowercase
    expect(
      ClaimBuildResponseSchema.parse({
        wallet, marketId, outcome: "YES", winningShares: "38", instructions: ix, derived: {}, recentBlockhash: key(),
        lastValidBlockHeight: 123,
      }).outcome,
    ).toBe("yes");
    expect(ReportTradeResponseSchema.parse({ signature: sig(), status: "processed", marketId, wallet, side: "yes", kind: "buy" }).kind).toBe("buy");
  });

  it("rejects malformed rows", () => {
    expect(() => TradeRowSchema.parse({ ...trades[0], signature: "not-base58!" })).toThrow();
    expect(() => PositionsResponseSchema.parse({ wallet: key(), positions: [{ marketId: key(), side: "maybe" }] })).toThrow();
  });

  it("our slippage cap is 5% even though Panta allows 5000 bps", () => {
    const base = { quoteId: "qt_1", wallet: key() };
    expect(() => BuildRequestSchema.parse({ ...base, maxSlippageBps: 500 })).not.toThrow();
    expect(() => BuildRequestSchema.parse({ ...base, maxSlippageBps: 501 })).toThrow();
  });
});

describe("lib/panta.ts in mock mode", () => {
  it("paginates markets 50 per page max and follows nextCursor", async () => {
    const panta = await import("@/lib/panta");
    const first = await panta.listMarkets({ limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.items[0].yesPrice).toBeNull(); // list rows have no prices (docs)
    const second = await panta.listMarkets({ limit: 10, cursor: first.nextCursor! });
    expect(second.items[0].marketId).not.toBe(first.items[0].marketId);
    const resolved = await panta.listMarkets({ status: "resolved" });
    expect(resolved.items.every((m) => m.phase === "resolved")).toBe(true);
  });

  it("returns trade tapes, wallet trades and positions", async () => {
    const panta = await import("@/lib/panta");
    const m = markets[0].marketId;
    const tape = await panta.getMarketTrades(m);
    expect(tape.items.length).toBeGreaterThan(0);
    expect(tape.items.length).toBeLessThanOrEqual(200);
    const wallet = tape.items[0].wallet;
    expect((await panta.getWalletTrades(wallet)).items.every((t) => t.wallet === wallet)).toBe(true);
    expect((await panta.getPositions(wallet)).positions.length).toBeGreaterThan(0);
  });

  it("quote -> build round trip, and the build refuses slippage > 5%", async () => {
    const panta = await import("@/lib/panta");
    const primary = markets.find((m) => m.phase === "primary")!;
    const wallet = key();
    const q = await panta.quotePrimaryOrder({ wallet, marketId: primary.marketId, side: "yes", amountUsdc: "5.00" });
    expect(Number(q.avgPrice)).toBeGreaterThan(0);
    const b = await panta.buildPrimaryOrder({ quoteId: q.quoteId, wallet, maxSlippageBps: 200 });
    expect(b.instructions.length).toBeGreaterThan(0);
    await expect(panta.buildPrimaryOrder({ quoteId: q.quoteId, wallet, maxSlippageBps: 900 })).rejects.toThrow();
  });

  it("rejects path params that are not base58 pubkeys (no path injection)", async () => {
    const panta = await import("@/lib/panta");
    await expect(panta.getMarket("../../account/keys")).rejects.toThrow();
    await expect(panta.getWalletTrades("abc/../../x")).rejects.toThrow();
  });
});

describe("lib/panta.ts real client (fetch mocked)", () => {
  beforeEach(() => {
    process.env.MOCK_PANTA = "false";
    process.env.PANTA_API_KEY = "test-key-" + Math.random().toString(36).slice(2);
    process.env.PANTA_BASE_URL = "https://live-api.panta.market/api/v1";
  });
  afterEach(() => {
    process.env.MOCK_PANTA = "true";
    delete process.env.PANTA_API_KEY;
    delete process.env.PANTA_BASE_URL;
    vi.unstubAllGlobals();
  });

  it("sends X-Api-Key, uses trailing slashes, retries on 429 then validates", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const responses = [
      new Response(JSON.stringify({ code: "RATE_LIMITED" }), { status: 429, headers: { "retry-after": "0" } }),
      new Response(JSON.stringify({ wallet: markets[0].marketId, items: [trades[0]] }), { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      return responses.shift()!;
    }));
    const panta = await import("@/lib/panta");
    const res = await panta.getWalletTrades(trades[0].wallet);
    expect(res.items).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://live-api.panta.market/api/v1/wallets/${trades[0].wallet}/trades/?limit=200`);
    expect(calls[0].headers.get("x-api-key")).toBe(process.env.PANTA_API_KEY);
    expect(calls[0].headers.get("authorization")).toBeNull();
  });

  it("surfaces Panta error codes and rejects unexpected shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "MARKET_NOT_FOUND", message: "nope" }), { status: 404 })));
    const panta = await import("@/lib/panta");
    await expect(panta.getMarket(markets[0].marketId)).rejects.toMatchObject({ code: "MARKET_NOT_FOUND", status: 404 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 })));
    await expect(panta.getMarket(markets[0].marketId)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("refuses to send the key to any host other than live-api.panta.market", async () => {
    process.env.PANTA_BASE_URL = "https://evil.example/api/v1";
    vi.stubGlobal("fetch", vi.fn());
    const panta = await import("@/lib/panta");
    await expect(panta.getMarket(markets[0].marketId)).rejects.toThrow(/PANTA_BASE_URL/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
