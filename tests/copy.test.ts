/**
 * Copy + claim flows (steps 9-10, hard requirements 2-4, addendum A/C/H).
 * Real signing with test keypairs against the mock chain, plus mock mode's
 * simulated signing.
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Keypair, TransactionInstruction, TransactionMessage, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { GET as quoteRoute } from "@/app/api/copy/[tradeId]/quote/route";
import { POST as buildRoute } from "@/app/api/copy/[tradeId]/build/route";
import { POST as confirmRoute } from "@/app/api/copy/confirm/route";
import { GET as positionsRoute } from "@/app/api/positions/route";
import { AuthError } from "@/lib/auth-core";
import {
  buildClaimTx,
  buildCopy,
  confirmOrder,
  myPositions,
  quoteCopy,
  resetFeeModelAlerts,
  sweepBroadcastOrders,
  type FlowDeps,
} from "@/lib/copy-core";
import { authErrorResponse } from "@/lib/auth";
import { CONFIRM_POLLS, FlowError, pollConfirm } from "@/components/tx-client";
import { ensureMockData, getDataStore, getUserDeps } from "@/lib/data";
import { MOCK_PROGRAM_ID, getSharedMockChain } from "@/lib/mock/chain-mock";
import {
  createCopyMemoryState,
  createMemoryCopyStore,
  setMemoryCopyClock,
  type CopyMemoryState,
} from "@/lib/mock/copy-store-memory";
import { PantaError } from "@/lib/panta-error";
import { REPORT_RETRY, runReportRetries } from "@/lib/report-retry";
import { copyAmounts, totalWithFeeShort } from "@/lib/copy-math";
import * as panta from "@/lib/panta";
import { USDC_MINT, associatedTokenAddress, baseToUsdc, usdcToBase } from "@/lib/solana-constants";
import type { StoredTrade } from "@/lib/data-store";
import { apiRequest, signedInUser } from "./helpers/session";

let trade: StoredTrade;
let closedTrade: StoredTrade | undefined;

beforeAll(async () => {
  await ensureMockData();
  const store = getDataStore();
  const trades = (await store.recentTrades(500)).filter((t) => t.isPrimary);
  const markets = new Map((await store.getMarkets([...new Set(trades.map((t) => t.marketId))])).map((m) => [m.id, m]));
  trade = trades.find((t) => markets.get(t.marketId)?.status === "primary")!;
  closedTrade = trades.find((t) => markets.get(t.marketId)?.status === "resolved");
  expect(trade).toBeTruthy();
}, 20_000);

function deps(over: Partial<FlowDeps> & { state?: CopyMemoryState } = {}): FlowDeps {
  return {
    ...getUserDeps(),
    copy: createMemoryCopyStore(over.state ?? createCopyMemoryState()),
    panta: {
      quotePrimaryOrder: panta.quotePrimaryOrder,
      buildPrimaryOrder: panta.buildPrimaryOrder,
      buildClaim: panta.buildClaim,
      reportTrade: panta.reportTrade,
      getPositions: panta.getPositions,
    },
    chain: getSharedMockChain(),
    pantaProgramIds: new Set([MOCK_PROGRAM_ID]),
    feeModel: "inclusive",
    feeCapBps: 500,
    mock: true,
    confirmTimeoutMs: 0,
    ...over,
  };
}

type User = Awaited<ReturnType<typeof signedInUser>>;
const get = (path: string, u?: User) => apiRequest("GET", path, { cookie: u?.cookie });
const post = (path: string, body: unknown, u?: User, origin?: string | null) =>
  apiRequest("POST", path, { body, cookie: u?.cookie, origin });

/** Sign the exact bytes (like a wallet). Works with any key, so tests can forge a foreign signer. */
function sign(b64: string, secretKey: Uint8Array): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), secretKey);
  return Buffer.from(tx.serialize()).toString("base64");
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof AuthError) return e.code;
    throw e;
  }
}

async function quoteAndBuild(d: FlowDeps, u: User, t = trade) {
  const q = await quoteCopy(d, get(`/api/copy/${t.id}/quote`, u), t.id);
  const b = await buildCopy(d, post(`/api/copy/${t.id}/build`, { quoteToken: q.quoteToken }, u), t.id);
  return { q, b };
}

describe("quote: the link can't change amount, side or market", () => {
  it("requires a session", async () => {
    expect(
      (await quoteRoute(get(`/api/copy/${trade.id}/quote`), { params: Promise.resolve({ tradeId: trade.id }) })).status,
    ).toBe(401);
  });

  it("uses the stored trade's side/market and the saved stake, ignoring query parameters", async () => {
    const u = await signedInUser();
    await getDataStore().updateSettings(u.userId, { maxStakeUsdc: "7.00", slippageBps: 150, alertsEnabled: true });
    const flip = trade.side === "YES" ? "NO" : "YES";
    const url = `/api/copy/${trade.id}/quote?amount=999&amountUsdc=999&side=${flip}&marketId=x&slippageBps=5000`;
    const res = await quoteRoute(get(url, u), { params: Promise.resolve({ tradeId: trade.id }) });
    expect(res.status).toBe(200);
    const q = await res.json();
    expect(q).toMatchObject({ side: trade.side, marketId: trade.marketId, amountUsdc: "7.00", slippageBps: 150 });
  });

  it("404s for non-uuid and unknown ids; 409 for a closed market", async () => {
    const u = await signedInUser();
    const d = deps();
    expect(await code(quoteCopy(d, get("/x", u), "not-a-uuid"))).toBe("TRADE_NOT_FOUND");
    expect(await code(quoteCopy(d, get("/x", u), randomUUID()))).toBe("TRADE_NOT_FOUND");
    if (closedTrade) expect(await code(quoteCopy(d, get("/x", u), closedTrade.id))).toBe("MARKET_CLOSED");
  });

  it("is cached for 10 s and rate limited to 10/min per user (shared store)", async () => {
    const u = await signedInUser();
    const d = deps();
    const a = await quoteCopy(d, get("/q", u), trade.id);
    const b = await quoteCopy(d, get("/q", u), trade.id);
    expect(b.quoteToken).toBe(a.quoteToken); // cache hit, no second Panta quote
    const later = deps({ nowMs: () => Date.now() + 11_000 });
    const c = await quoteCopy({ ...later, copy: d.copy }, get("/q", u), trade.id);
    expect(c.quoteToken).not.toBe(a.quoteToken);
    for (let i = 3; i < 10; i++) await quoteCopy(d, get("/q", u), trade.id);
    expect(await code(quoteCopy(d, get("/q", u), trade.id))).toBe("RATE_LIMITED");
  });

  it("rejects slippage above 500 bps even if stored", async () => {
    const u = await signedInUser();
    const store = getDataStore();
    // The route and the DB check both refuse 600; simulate a bad stored value anyway.
    await expect(
      store.updateSettings(u.userId, { maxStakeUsdc: "5.00", slippageBps: 600, alertsEnabled: true }),
    ).rejects.toThrow();
    const data = {
      ...store,
      getSettings: async (id: string) => ({ ...(await store.getSettings(id))!, slippageBps: 600 }),
    };
    expect(await code(quoteCopy({ ...deps(), data }, get("/q", u), trade.id))).toBe("SLIPPAGE_TOO_HIGH");
    await expect(panta.buildPrimaryOrder({ quoteId: "qt_x", wallet: u.wallet, maxSlippageBps: 501 })).rejects.toThrow();
  });
});

describe("build: server-assembled, validated, simulated", () => {
  it("needs Origin and a session", async () => {
    const u = await signedInUser();
    const q = await quoteCopy(deps(), get("/q", u), trade.id);
    const params = { params: Promise.resolve({ tradeId: trade.id }) };
    expect((await buildRoute(post("/b", { quoteToken: q.quoteToken }), params)).status).toBe(401);
    expect((await buildRoute(post("/b", { quoteToken: q.quoteToken }, u, "https://evil.example"), params)).status).toBe(
      403,
    );
  });

  it("refuses amount/side in the body and never lets them through", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    const body = { quoteToken: q.quoteToken, amountUsdc: "999.00", side: "NO", marketId: "x", maxSlippageBps: 5000 };
    expect(await code(buildCopy(d, post("/b", body, u), trade.id))).toBe("INVALID_REQUEST");
    expect(state.orders.size).toBe(0);
    const b = await buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id);
    const order = state.orders.get(b.orderId)!;
    expect(order).toMatchObject({
      side: trade.side,
      marketId: trade.marketId,
      amountUsdc: "5.00",
      wallet: u.wallet,
      leaderTradeId: trade.id,
    });
    expect(b.checks.usdcOut).toBe("5.00");
    expect(b.checks.programs).toEqual(expect.arrayContaining(["Panta", "Compute Budget", "Associated Token"]));
    // The returned tx is exactly what we hashed, fee payer = session wallet.
    const tx = VersionedTransaction.deserialize(Buffer.from(b.transaction, "base64"));
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(u.wallet);
  });

  it("quote tokens are single-use, per user, per trade, and expire", async () => {
    const [u, other] = [await signedInUser(), await signedInUser()];
    const d = deps();
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, other), trade.id))).toBe("QUOTE_EXPIRED");
    const q2 = await quoteCopy(d, get("/q", u), trade.id);
    const late = { ...deps({ nowMs: () => Date.now() + 120_000 }), copy: d.copy };
    expect(await code(buildCopy(late, post("/b", { quoteToken: q2.quoteToken }, u), trade.id))).toBe("QUOTE_EXPIRED");
  });

  it("a settings change after the quote means refresh", async () => {
    const u = await signedInUser();
    const d = deps();
    const q = await quoteCopy(d, get("/q", u), trade.id);
    await getDataStore().updateSettings(u.userId, { maxStakeUsdc: "50.00", slippageBps: 200, alertsEnabled: true });
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("QUOTE_EXPIRED");
  });

  it("rejects a build Panta returned for a different amount (tampered upstream)", async () => {
    const u = await signedInUser();
    const d = deps({
      panta: {
        ...deps().panta,
        buildPrimaryOrder: async (req) => ({ ...(await panta.buildPrimaryOrder(req)), amountUsdc: "500.00" }),
      },
    });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("TX_REJECTED");
  });

  it("rejects a build with an unknown program before any wallet prompt", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({
      state,
      panta: {
        ...deps().panta,
        buildPrimaryOrder: async (req) => {
          const b = await panta.buildPrimaryOrder(req);
          return {
            ...b,
            instructions: [
              ...b.instructions,
              { programId: Keypair.generate().publicKey.toBase58(), data: "AA==", accounts: [] },
            ],
          };
        },
      },
    });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("TX_REJECTED");
    expect(state.orders.size).toBe(0);
  });
});

describe("fee model: the max stake is the hard total, fee included", () => {
  it("the quote says so: limit == stake, fee inside it, estimate from stake - fee", async () => {
    const u = await signedInUser();
    const q = await quoteCopy(deps(), get("/q", u), trade.id);
    expect(q.amountUsdc).toBe("5.00");
    expect(q.maxUsdcOut).toBe("5.00");
    expect(q).toMatchObject({ feeModel: "inclusive", totalUsdc: "5.00" });
    const a = copyAmounts({ ...q, depositUsdc: q.amountUsdc });
    expect(a.feeBase).toBeGreaterThan(0n);
    expect(a.feeBase + a.toSharesBase).toBe(usdcToBase(q.maxUsdcOut));
    // Mock Panta prices (stake - fee) / avgPrice and rounds; we round down, so at most 0.01 below.
    expect(usdcToBase(q.shares) - usdcToBase(a.estShares)).toBeGreaterThanOrEqual(0n);
    expect(usdcToBase(q.shares) - usdcToBase(a.estShares)).toBeLessThanOrEqual(10_000n);
  });

  it("build: the guard limit is 5.00, not 5.00 + fee, and the simulated total fits it", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { q, b } = await quoteAndBuild(d, u);
    expect(b.checks.maxUsdcOut).toBe("5.00");
    expect(b.checks.maxUsdcOut).not.toBe(baseToUsdc(usdcToBase("5.00") + usdcToBase(q.feeUsdc)));
    expect(usdcToBase(b.checks.usdcOut)).toBeLessThanOrEqual(usdcToBase(b.checks.maxUsdcOut));
    expect(state.orders.get(b.orderId)).toMatchObject({ amountUsdc: "5.00", feeUsdc: q.feeUsdc });
  });

  it("rejects a Panta build that pulls the fee on top of the stake (5.10 out for 5.00 approved)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({
      state,
      panta: {
        ...deps().panta,
        buildPrimaryOrder: async (req) => {
          const b = await panta.buildPrimaryOrder(req);
          const ixs = structuredClone(b.instructions);
          const i = ixs.length - 1; // primary_order_usdc
          const data = Buffer.from(ixs[i].data, "base64");
          data.writeBigUInt64LE(usdcToBase(b.amountUsdc) + usdcToBase(b.feeUsdc), 8);
          ixs[i].data = data.toString("base64");
          return { ...b, instructions: ixs };
        },
      },
    });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("TX_REJECTED");
    expect(state.orders.size).toBe(0);
  });

  it("rejects a build whose fee differs from the quoted one", async () => {
    const u = await signedInUser();
    const d = deps({
      panta: {
        ...deps().panta,
        buildPrimaryOrder: async (req) => ({ ...(await panta.buildPrimaryOrder(req)), feeUsdc: "0.50" }),
      },
    });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("TX_REJECTED");
  });

  it("refuses a quote whose fee isn't smaller than the stake", async () => {
    const u = await signedInUser();
    const d = deps({
      panta: {
        ...deps().panta,
        quotePrimaryOrder: async (req) => ({ ...(await panta.quotePrimaryOrder(req)), feeUsdc: "5.00" }),
      },
    });
    expect(await code(quoteCopy(d, get("/q", u), trade.id))).toBe("FEE_TOO_HIGH");
  });

  it("D-01: refuses a quote fee above the cap (500 bps), and a stricter deployment cap", async () => {
    const u = await signedInUser();
    const fee = (feeUsdc: string) =>
      deps({
        panta: {
          ...deps().panta,
          quotePrimaryOrder: async (req) => {
            const q = await panta.quotePrimaryOrder(req);
            // keep the numbers consistent with "inclusive" so only the cap can refuse it
            const shares = ((Number(q.amountUsdc) - Number(feeUsdc)) / Number(q.avgPrice)).toFixed(2);
            return { ...q, feeUsdc, shares };
          },
        },
      });
    expect(await code(quoteCopy(fee("0.26"), get("/q", u), trade.id))).toBe("FEE_TOO_HIGH");
    expect(await code(quoteCopy(fee("0.25"), get("/q", u), trade.id))).toBe("OK");
    const strict = { ...deps(), feeCapBps: 100 };
    expect(await code(quoteCopy(strict, get("/q", await signedInUser()), trade.id))).toBe("FEE_TOO_HIGH");
  });

  it("refuses ambiguous / unknown quotes and quotes that contradict the pinned model", async () => {
    const u = await signedInUser();
    const shaped = (shares: (q: { amountUsdc: string | number; avgPrice: string }) => string, feeUsdc?: string) =>
      deps({
        panta: {
          ...deps().panta,
          quotePrimaryOrder: async (req) => {
            const q = await panta.quotePrimaryOrder(req);
            return { ...q, ...(feeUsdc ? { feeUsdc } : {}), shares: shares(q) };
          },
        },
      });
    // Between the two models.
    const between = shaped((q) => ((Number(q.amountUsdc) - 0.05) / Number(q.avgPrice)).toFixed(2));
    expect(await code(quoteCopy(between, get("/q", u), trade.id))).toBe("FEE_MODEL_UNKNOWN");
    // Fee too small to tell apart.
    const tiny = shaped((q) => (Number(q.amountUsdc) / Number(q.avgPrice)).toFixed(2), "0.001");
    expect(await code(quoteCopy(tiny, get("/q", await signedInUser()), trade.id))).toBe("FEE_MODEL_UNKNOWN");
    // On-top numbers on an inclusive deployment: an error, not a switch.
    const onTop = shaped((q) => (Number(q.amountUsdc) / Number(q.avgPrice)).toFixed(2));
    expect(await code(quoteCopy(onTop, get("/q", await signedInUser()), trade.id))).toBe("FEE_MODEL_MISMATCH");
    // Inclusive numbers on an on_top deployment: same.
    expect(await code(quoteCopy({ ...deps(), feeModel: "on_top" }, get("/q", await signedInUser()), trade.id))).toBe(
      "FEE_MODEL_MISMATCH",
    );
  });

  it("positions list the copy as a total with its fee", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { q, b } = await quoteAndBuild(d, u);
    await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u), "copy");
    const view = await myPositions(d, get("/p", u));
    expect(view.copies[0]).toMatchObject({ amountUsdc: "5.00", feeUsdc: q.feeUsdc });
    expect(totalWithFeeShort(view.copies[0].amountUsdc, view.copies[0].feeUsdc)).toBe(
      `5.00 USDC total (${q.feeUsdc} fee)`,
    );
  });
});

describe("fee on top (MOCK_PANTA_FEE_MODEL=on_top, PANTA_FEE_MODEL=on_top), end to end", () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.MOCK_PANTA_FEE_MODEL;
    process.env.MOCK_PANTA_FEE_MODEL = "on_top";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.MOCK_PANTA_FEE_MODEL;
    else process.env.MOCK_PANTA_FEE_MODEL = prev;
  });
  const onTopDeps = (over: Partial<FlowDeps> & { state?: CopyMemoryState } = {}) => deps({ feeModel: "on_top", ...over });

  it("re-quotes with 4.90, shows 5.00 total incl. 0.10 fee, builds, and moves exactly <= 5.00 on chain", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const seen: string[] = [];
    const d = onTopDeps({
      state,
      panta: {
        ...deps().panta,
        quotePrimaryOrder: async (req) => {
          seen.push(String(req.amountUsdc));
          return panta.quotePrimaryOrder(req);
        },
      },
    });
    const chain = d.chain as ReturnType<typeof getSharedMockChain>;
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(seen).toEqual(["5.00", "4.90"]);
    expect(q).toMatchObject({ feeModel: "on_top", amountUsdc: "4.90", feeUsdc: "0.10", totalUsdc: "5.00", maxUsdcOut: "5.00" });
    const a = copyAmounts({ ...q, depositUsdc: q.amountUsdc });
    expect(a).toMatchObject({ total: "5.00", fee: "0.10", toShares: "4.90" });

    const ata = associatedTokenAddress(u.wallet, USDC_MINT);
    chain.seedWallet(u.wallet);
    const before = chain.state.tokens.get(ata)!.amount;
    const b = await buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id);
    expect(b.checks).toMatchObject({ usdcOut: "5.00", maxUsdcOut: "5.00" });
    expect(state.orders.get(b.orderId)).toMatchObject({ feeModel: "on_top", amountUsdc: "5.00", maxUsdcOut: "5.00" });
    const r = await confirmOrder(
      d,
      post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u),
      "copy",
    );
    expect(r.status).toBe("confirmed");
    const moved = before - chain.state.tokens.get(ata)!.amount;
    expect(moved).toBe(usdcToBase("5.00"));
    expect(moved).toBeLessThanOrEqual(usdcToBase("5.00"));
  });

  it("an on-top build for the full 5.00 (not re-quoted) is refused before any wallet prompt", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = onTopDeps({ state });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    // Tamper the stored quote record to the un-shrunk deposit, as a buggy server would.
    const key = [...state.cache.keys()].find((k) => k.startsWith("qtok:"))!;
    const rec = state.cache.get(key)!;
    const tok = rec.value as { quote: { quoteId: string }; depositUsdc: string };
    const full = await panta.quotePrimaryOrder({ wallet: u.wallet, marketId: trade.marketId, side: trade.side === "YES" ? "yes" : "no", amountUsdc: "5.00" });
    tok.quote = full;
    tok.depositUsdc = "5.000000";
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("TX_REJECTED");
    expect(state.orders.size).toBe(0);
  });

  it("a quote record from another pin can't be built after the deployment pin changes", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const q = await quoteCopy(onTopDeps({ state }), get("/q", u), trade.id);
    const inclusive = deps({ state });
    expect(await code(buildCopy(inclusive, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("QUOTE_EXPIRED");
  });
});

describe("confirm: verified on chain (addendum C)", () => {
  it("signs the exact bytes, broadcasts via our route, records and reports the copy", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b } = await quoteAndBuild(d, u);
    const r = await confirmOrder(
      d,
      post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u),
      "copy",
    );
    expect(r).toMatchObject({ status: "confirmed", reported: true, simulated: false });
    const copies = [...state.copies.values()];
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      leaderTradeId: trade.id,
      side: trade.side,
      amountUsdc: "5.00",
      status: "reported",
    });
    // Idempotent re-confirm returns the same result, records nothing new.
    const again = await confirmOrder(d, post("/c", { orderId: b.orderId, signature: r.signature }, u), "copy");
    expect(again.signature).toBe(r.signature);
    expect(state.copies.size).toBe(1);
  });

  it("rejects a message that differs from the one we built (nothing broadcast)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b } = await quoteAndBuild(d, u);
    const tx = VersionedTransaction.deserialize(Buffer.from(b.transaction, "base64"));
    const decompiled = TransactionMessage.decompile(tx.message);
    decompiled.instructions.push(
      new TransactionInstruction({ programId: new PublicKey(MOCK_PROGRAM_ID), keys: [], data: Buffer.from([1]) }),
    );
    const edited = new VersionedTransaction(decompiled.compileToV0Message());
    edited.sign([Keypair.fromSecretKey(u.secretKey)]);
    const landedBefore = getSharedMockChain().state.landed.size;
    const body = { orderId: b.orderId, signedTransaction: Buffer.from(edited.serialize()).toString("base64") };
    expect(await code(confirmOrder(d, post("/c", body, u), "copy"))).toBe("TX_REJECTED");
    expect(getSharedMockChain().state.landed.size).toBe(landedBefore);
    expect(state.copies.size).toBe(0);
  });

  it("rejects a foreign signer, both as signed bytes and as a landed signature", async () => {
    const u = await signedInUser();
    const other = await signedInUser();
    const d = deps();
    const { b } = await quoteAndBuild(d, u);
    // Our bytes, signed by someone else's key.
    expect(
      await code(
        confirmOrder(
          d,
          post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, other.secretKey) }, u),
          "copy",
        ),
      ),
    ).toBe("TX_REJECTED");
    // Another user's real, successful copy submitted as ours.
    const d2 = deps();
    const theirs = await quoteAndBuild(d2, other);
    const r = await confirmOrder(
      d2,
      post("/c", { orderId: theirs.b.orderId, signedTransaction: sign(theirs.b.transaction, other.secretKey) }, other),
      "copy",
    );
    expect(r.status).toBe("confirmed");
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, signature: r.signature }, u), "copy"))).toBe(
      "TX_REJECTED",
    );
  });

  it("rejects a reused signature", async () => {
    const u = await signedInUser();
    const d = deps();
    const first = await quoteAndBuild(d, u);
    const r = await confirmOrder(
      d,
      post("/c", { orderId: first.b.orderId, signedTransaction: sign(first.b.transaction, u.secretKey) }, u),
      "copy",
    );
    const second = await quoteAndBuild({ ...d, nowMs: () => Date.now() + 11_000 }, u);
    expect(
      await code(confirmOrder(d, post("/c", { orderId: second.b.orderId, signature: r.signature }, u), "copy")),
    ).toBe("SIGNATURE_USED");
    // And the store refuses it too (UNIQUE signature).
    expect(await d.copy.completeOrder(second.b.orderId, u.userId, r.signature)).toBe("signature_used");
  });

  it("rejects a landed tx that failed, another user's order, a missing Origin, and expired bytes", async () => {
    const u = await signedInUser();
    const other = await signedInUser();
    const d = deps();
    const { b } = await quoteAndBuild(d, u);
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, simulated: true }, other), "copy"))).toBe(
      "ORDER_NOT_FOUND",
    );
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, simulated: true }, u, null), "copy"))).toBe(
      "BAD_ORIGIN",
    );
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, simulated: true }, u), "claim"))).toBe(
      "ORDER_NOT_FOUND",
    );
    const late = { ...d, nowMs: () => Date.now() + 5 * 60_000 };
    expect(
      await code(
        confirmOrder(
          late,
          post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u),
          "copy",
        ),
      ),
    ).toBe("QUOTE_EXPIRED");

    // A tx with our exact message that failed on chain.
    const order = await d.copy.getPendingOrder(b.orderId);
    const chain = getSharedMockChain();
    const failedSig = chain.landForeign(
      VersionedTransaction.deserialize(Buffer.from(b.transaction, "base64")).message,
      { InstructionError: [3, "Custom"] },
    );
    expect(order?.status).toBe("pending");
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, signature: failedSig }, u), "copy"))).toBe(
      "TX_FAILED",
    );
    expect((await d.copy.getPendingOrder(b.orderId))?.status).toBe("failed");
  });

  it("simulated signing works in mock mode only", async () => {
    const u = await signedInUser();
    const d = deps();
    const { b } = await quoteAndBuild(d, u);
    expect(
      await code(confirmOrder({ ...d, mock: false }, post("/c", { orderId: b.orderId, simulated: true }, u), "copy")),
    ).toBe("SIMULATION_UNAVAILABLE");
    const r = await confirmOrder(d, post("/c", { orderId: b.orderId, simulated: true }, u), "copy");
    expect(r).toMatchObject({ status: "confirmed", simulated: true, reported: true });
  });

  it("route: 403 cross-origin, 401 anonymous, 400 malformed", async () => {
    const u = await signedInUser();
    expect((await confirmRoute(post("/c", { orderId: randomUUID(), simulated: true }))).status).toBe(401);
    expect(
      (await confirmRoute(post("/c", { orderId: randomUUID(), simulated: true }, u, "https://evil.example"))).status,
    ).toBe(403);
    expect((await confirmRoute(post("/c", { orderId: randomUUID(), simulated: true, signature: "x" }, u))).status).toBe(
      400,
    );
  });
});

describe("positions + claim", () => {
  it("GET /api/positions needs a session and returns only the session wallet", async () => {
    expect((await positionsRoute(get("/api/positions?wallet=someone"))).status).toBe(401);
    const u = await signedInUser();
    const res = await positionsRoute(get("/api/positions?wallet=2UqHDhTNCV9HD3ZAeHjRtSBkyWsB2x3Uzzc8WmWbUELj", u));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wallet).toBe(u.wallet);
    expect(body.positions.map((p: { status: string }) => p.status)).toEqual(
      expect.arrayContaining(["claimable", "lost"]),
    );
  });

  it("claims a win: validated, simulated (USDC only goes up), confirmed on chain, once", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const view = await myPositions(d, get("/p", u));
    const win = view.positions.find((p) => p.status === "claimable")!;
    const b = await buildClaimTx(d, post("/cb", { marketId: win.marketId }, u));
    expect(b.checks.usdcOut).toBe(`-${win.shares}`);
    const r = await confirmOrder(
      d,
      post("/cc", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u),
      "claim",
    );
    expect(r).toMatchObject({ status: "confirmed", reported: true, kind: "claim" });
    expect(state.claims.size).toBe(1);
    const after = await myPositions(d, get("/p", u));
    expect(after.positions.find((p) => p.marketId === win.marketId)?.status).toBe("claimed");
    expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId }, u)))).toBe("NOT_CLAIMABLE");
  });

  it("a claim build that moves USDC out is rejected", async () => {
    const u = await signedInUser();
    const d0 = deps();
    const win = (await myPositions(d0, get("/p", u))).positions.find((p) => p.status === "claimable")!;
    const d = deps({
      panta: {
        ...deps().panta,
        buildClaim: async (req) => {
          const c = await panta.buildClaim(req);
          const ix = c.instructions[2];
          const transfer = {
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]).toString("base64"),
            accounts: [
              { pubkey: ix.accounts[2].pubkey, isSigner: false, isWritable: true },
              { pubkey: ix.accounts[3].pubkey, isSigner: false, isWritable: true },
              { pubkey: req.wallet, isSigner: true, isWritable: false },
            ],
          };
          return { ...c, instructions: [...c.instructions, transfer] };
        },
      },
    });
    expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId, amount: "1" }, u)))).toBe(
      "INVALID_REQUEST",
    );
  });
});

describe("D-02 / B3-02: primary_order_usdc args are decoded strictly", () => {
  /** A build whose Panta instruction data is edited by `edit` (Panta or a MITM tampering). */
  const tampered = (edit: (data: Buffer) => Buffer, logs: string[], over: Partial<{ expectedShares: string }> = {}) =>
    deps({
      log: (m: string) => logs.push(m),
      panta: {
        ...deps().panta,
        buildPrimaryOrder: async (req) => {
          const b = await panta.buildPrimaryOrder(req);
          const ixs = structuredClone(b.instructions);
          const main = ixs.find((i) => i.programId === MOCK_PROGRAM_ID)!;
          main.data = edit(Buffer.from(main.data, "base64")).toString("base64");
          return { ...b, ...over, instructions: ixs };
        },
      },
    });

  const cases: [string, (d: Buffer) => Buffer, string][] = [
    ["slippage 0xFFFF (the PoF)", (d) => (d.writeUInt16LE(0xffff, 25), d), "SLIPPAGE_TOO_HIGH"],
    ["slippage one bp above the setting", (d) => (d.writeUInt16LE(d.readUInt16LE(25) + 1, 25), d), "SLIPPAGE_TOO_HIGH"],
    ["zero shares", (d) => (d.writeBigUInt64LE(0n, 17), d), "ZERO_SHARES"],
    ["the other side", (d) => ((d[16] = d[16] === 1 ? 0 : 1), d), "SIDE_MISMATCH"],
    ["an unreadable side byte", (d) => ((d[16] = 7), d), "ORDER_ARGS"],
    ["a different amount", (d) => (d.writeBigUInt64LE(d.readBigUInt64LE(8) - 1n, 8), d), "DEPOSIT_MISMATCH"],
    ["fewer shares than the review's minimum", (d) => (d.writeBigUInt64LE(d.readBigUInt64LE(17) / 2n, 17), d), "MIN_SHARES_TOO_LOW"],
    ["trailing bytes", (d) => Buffer.concat([d, Buffer.from([0])]), "ORDER_ARGS"],
    ["a truncated layout", (d) => d.subarray(0, 25), "ORDER_ARGS"],
  ];
  for (const [name, edit, why] of cases) {
    it(`refuses ${name} before any wallet prompt (${why})`, async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const logs: string[] = [];
      const d = { ...tampered(edit, logs), copy: createMemoryCopyStore(state) };
      expect(await code(quoteAndBuild(d, u))).toBe("TX_REJECTED");
      expect(logs.join("\n")).toContain(why);
      expect(state.orders.size).toBe(0);
    });
  }

  it("refuses a build whose expectedShares is below the displayed Min. shares", async () => {
    const u = await signedInUser();
    const logs: string[] = [];
    expect(await code(quoteAndBuild(tampered((d) => d, logs, { expectedShares: "0.01" }), u))).toBe("TX_REJECTED");
  });

  it("the untampered build passes: on-chain min >= displayed min", async () => {
    const u = await signedInUser();
    const { q, b } = await quoteAndBuild(deps(), u);
    const shown = copyAmounts({ ...q, depositUsdc: q.amountUsdc, feeModel: q.feeModel });
    const data = Buffer.from(
      VersionedTransaction.deserialize(Buffer.from(b.transaction, "base64")).message.compiledInstructions.find(
        (ix) => ix.data.length === 27, // the only primary_order_usdc-sized instruction
      )!.data,
    );
    const onChainMin = (data.readBigUInt64LE(17) * BigInt(10_000 - data.readUInt16LE(25))) / 10_000n;
    expect(onChainMin).toBeGreaterThanOrEqual(usdcToBase(shown.minShares));
    expect(data.readUInt16LE(25)).toBe(q.slippageBps);
  });
});

describe("D-03: the landed outflow is checked at confirm", () => {
  const withLanded = (adjust: (moved: bigint | null | undefined) => bigint | null) => {
    const chain = getSharedMockChain();
    return {
      ...chain,
      getLandedTransaction: async (sig: string) => {
        const t = await chain.getLandedTransaction(sig);
        return t && { ...t, payerUsdcOutBase: adjust(t.payerUsdcOutBase) };
      },
    };
  };

  it("records the real outflow from token balances (== the stake)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b } = await quoteAndBuild(d, u);
    const r = await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u), "copy");
    expect(r.status).toBe("confirmed");
    const landed = await getSharedMockChain().getLandedTransaction(r.signature);
    expect(landed?.payerUsdcOutBase).toBe(usdcToBase(state.orders.get(b.orderId)!.maxUsdcOut!));
  });

  it("rejects and fails the order when more USDC left the wallet than the stake", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const logs: string[] = [];
    const d = deps({ state, chain: withLanded((m) => (m ?? 0n) + 1n), log: (m: string) => logs.push(m) });
    const { b } = await quoteAndBuild(d, u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(d, req, "copy"))).toBe("OVER_LIMIT");
    expect(state.copies.size).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
    expect(logs.join("\n")).toContain("OVER_LIMIT");
  });

  it("fails closed (retryable, nothing recorded) when the token balances are missing", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state, chain: withLanded(() => null) });
    const { b } = await quoteAndBuild(d, u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(d, req, "copy"))).toBe("VERIFY_UNAVAILABLE");
    expect(state.copies.size).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
  });
});

describe("B3-03: claims must pay the winnings into the user's own USDC ATA", () => {
  const winFor = async (u: User) =>
    (await myPositions(deps(), get("/p", u))).positions.find((p) => p.status === "claimable")!;

  /** Claim build with the payout account (index 2) swapped for someone else's USDC ATA. */
  const rerouted = (keepUserAta: boolean, logs: string[]) => {
    const thief = Keypair.generate().publicKey.toBase58();
    getSharedMockChain().seedWallet(thief);
    const thiefAta = associatedTokenAddress(thief, USDC_MINT);
    return deps({
      log: (m: string) => logs.push(m),
      panta: {
        ...deps().panta,
        buildClaim: async (req) => {
          const c = await panta.buildClaim(req);
          const ixs = structuredClone(c.instructions);
          const main = ixs.find((i) => i.programId === MOCK_PROGRAM_ID)!;
          const userAta = main.accounts[2].pubkey;
          main.accounts[2] = { ...main.accounts[2], pubkey: thiefAta };
          if (keepUserAta) main.accounts.push({ pubkey: userAta, isSigner: false, isWritable: true });
          return { ...c, instructions: ixs };
        },
      },
    });
  };

  it("refuses a claim whose accounts don't include the user's USDC ATA", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const logs: string[] = [];
    expect(await code(buildClaimTx(rerouted(false, logs), post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    expect(logs.join("\n")).toContain("PAYOUT_ACCOUNT");
  });

  it("refuses a claim that lists the user's ATA but pays someone else (simulation)", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const logs: string[] = [];
    expect(await code(buildClaimTx(rerouted(true, logs), post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    expect(logs.join("\n")).toContain("PAYOUT_TOO_LOW");
  });

  it("rejects at confirm when the landed payout is below the winning shares", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const state = createCopyMemoryState();
    const chain = getSharedMockChain();
    const d = deps({
      state,
      chain: {
        ...chain,
        getLandedTransaction: async (sig: string) => {
          const t = await chain.getLandedTransaction(sig);
          return t && { ...t, payerUsdcOutBase: (t.payerUsdcOutBase ?? 0n) + 1n }; // 1 base unit short
        },
      },
    });
    const b = await buildClaimTx(d, post("/cb", { marketId: win.marketId }, u));
    const req = post("/cc", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(d, req, "claim"))).toBe("PAYOUT_TOO_LOW");
    expect(state.claims.size).toBe(0);
  });
});

describe("B3-04: the landed transaction's CPIs are checked at confirm", () => {
  const landedWith = (programs: (p: string[] | null | undefined) => string[] | null) => {
    const chain = getSharedMockChain();
    return {
      ...chain,
      getLandedTransaction: async (sig: string) => {
        const t = await chain.getLandedTransaction(sig);
        return t && { ...t, innerPrograms: programs(t.innerPrograms) };
      },
    };
  };

  it("a landed CPI into an unknown program is refused, the order failed and nothing recorded", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const logs: string[] = [];
    const evil = Keypair.generate().publicKey.toBase58();
    const d = deps({ state, chain: landedWith((p) => [...(p ?? []), evil]), log: (m: string) => logs.push(m) });
    const { b } = await quoteAndBuild(d, u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(d, req, "copy"))).toBe("TX_REJECTED");
    expect(state.copies.size).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
    expect(logs.join("\n")).toContain("UNEXPECTED_CPI");
  });

  it("missing inner instructions fail closed (retryable, nothing recorded)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state, chain: landedWith(() => null) });
    const { b } = await quoteAndBuild(d, u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(d, req, "copy"))).toBe("VERIFY_UNAVAILABLE");
    expect(state.copies.size).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
  });
});

describe("B3-06: confirm race, atomic and idempotent confirm", () => {
  const chain = getSharedMockChain();

  it("a tx that lands while we read 'expired' is still verified and recorded", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const racy = { ...chain, waitForConfirmation: async () => "expired" as const };
    const d = deps({ state, chain: racy });
    const { b } = await quoteAndBuild(d, u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await confirmOrder(d, req, "copy")).toMatchObject({ status: "confirmed" });
    expect(state.copies.size).toBe(1);
  });

  it("an order marked failed by the race can be re-verified by signature, once", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    // The race: the status read missed it and the landed lookup came back empty, so it was failed.
    let hide = true;
    const racy = {
      ...chain,
      waitForConfirmation: async (sig: string, h: number | null, t: number) =>
        hide ? ("expired" as const) : chain.waitForConfirmation(sig, h, t),
      getLandedTransaction: async (sig: string) => (hide ? null : chain.getLandedTransaction(sig)),
    };
    const d = deps({ state, chain: racy });
    const { b } = await quoteAndBuild(d, u);
    const signed = sign(b.transaction, u.secretKey);
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: signed }, u), "copy"))).toBe(
      "QUOTE_EXPIRED",
    );
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
    hide = false;
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signed, "base64")).signatures[0]);
    // Re-sending signed bytes to a failed order is still refused; a signature lookup re-verifies on chain.
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: signed }, u), "copy"))).toBe(
      "TX_FAILED",
    );
    // A foreign signature can't revive it: the landed message must be the one we built.
    const foreign = chain.landForeign(
      new TransactionMessage({
        payerKey: new PublicKey(u.wallet),
        recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
        instructions: [new TransactionInstruction({ programId: new PublicKey(MOCK_PROGRAM_ID), keys: [], data: Buffer.alloc(0) })],
      }).compileToV0Message(),
    );
    expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, signature: foreign }, u), "copy"))).toBe(
      "TX_REJECTED",
    );
    expect(state.copies.size).toBe(0);
    expect(await confirmOrder(d, post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).toMatchObject({
      status: "confirmed",
    });
    expect(state.copies.size).toBe(1);
    expect(await confirmOrder(d, post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).toMatchObject({
      status: "confirmed",
    });
    expect(state.copies.size).toBe(1);
  });

  it("concurrent confirms of one order record exactly one copy", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b } = await quoteAndBuild(d, u);
    const signed = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signed, "base64")).signatures[0]);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        code(
          confirmOrder(
            d,
            post("/c", i % 2 ? { orderId: b.orderId, signature: sig } : { orderId: b.orderId, signedTransaction: signed }, u),
            "copy",
          ),
        ),
      ),
    );
    expect(results.filter((r) => r === "OK").length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect(["OK", "ORDER_NOT_PENDING", "SIGNATURE_USED", "QUOTE_EXPIRED"]).toContain(r);
    expect(state.copies.size).toBe(1);
    expect([...state.copies.values()][0].signature).toBe(sig);
  });

  it("the store refuses a second record for one order even if called directly", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b } = await quoteAndBuild(d, u);
    const [x, y] = await Promise.all([
      d.copy.completeOrder(b.orderId, u.userId, "sigX"),
      d.copy.completeOrder(b.orderId, u.userId, "sigY"),
    ]);
    expect([x, y].sort()).toEqual(["not_pending", "ok"]);
    expect(await d.copy.completeOrder(b.orderId, u.userId, "sigZ", { allowFailed: true })).toBe("not_pending");
    expect(state.copies.size).toBe(1);
  });
});

describe("B3-07: Panta reports are retried, bounded, and reported honestly", () => {
  const failing = (codeFn: () => string | null, calls: string[]) => ({
    ...deps().panta,
    reportTrade: async (req: Parameters<FlowDeps["panta"]["reportTrade"]>[0]) => {
      calls.push(req.signature);
      const c = codeFn();
      if (c) throw new PantaError(c === "RATE_LIMITED" ? 429 : 400, c, "nope");
      return panta.reportTrade(req);
    },
  });
  const t0 = Date.now();
  const at = (sec: number) => setMemoryCopyClock(() => t0 + sec * 1000);
  afterEach(() => setMemoryCopyClock(null));

  async function confirmedCopy(d: FlowDeps, u: User) {
    const { b } = await quoteAndBuild(d, u);
    const r = await confirmOrder(
      d,
      post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u),
      "copy",
    );
    return { b, r };
  }

  it("a failed report says reported:false (also on re-confirm) and the cron retries it with backoff", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const calls: string[] = [];
    let fail: string | null = "RATE_LIMITED";
    const d = deps({ state, panta: failing(() => fail, calls) });
    at(0);
    const { b, r } = await confirmedCopy(d, u);
    expect(r).toMatchObject({ status: "confirmed", reported: false });
    expect(state.copies.size).toBe(1); // recorded regardless of Panta
    // Re-confirm reports the real status (it used to say true unconditionally).
    expect(await confirmOrder(d, post("/c", { orderId: b.orderId, signature: r.signature }, u), "copy")).toMatchObject({
      reported: false,
    });
    const rd = { copy: d.copy, panta: d.panta };
    expect((await runReportRetries(rd)).claimed).toBe(0); // backoff: not due yet
    at(REPORT_RETRY.baseGapSec);
    expect(await runReportRetries(rd)).toMatchObject({ claimed: 1, retry: 1 }); // attempt 2 fails
    at(REPORT_RETRY.baseGapSec + REPORT_RETRY.baseGapSec); // 2nd gap is doubled: not yet
    expect((await runReportRetries(rd)).claimed).toBe(0);
    at(REPORT_RETRY.baseGapSec * 3);
    fail = null;
    expect(await runReportRetries(rd)).toMatchObject({ claimed: 1, reported: 1 });
    expect([...state.copies.values()][0].status).toBe("reported");
    expect(await confirmOrder(d, post("/c", { orderId: b.orderId, signature: r.signature }, u), "copy")).toMatchObject({
      reported: true,
    });
    at(REPORT_RETRY.baseGapSec * 100);
    expect((await runReportRetries(rd)).claimed).toBe(0); // reported rows are never retried
    expect(calls).toHaveLength(3); // confirm, retry 1 (failed), retry 2 (reported)
  });

  it("stops after maxAttempts and after maxAgeSec", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const calls: string[] = [];
    const d = deps({ state, panta: failing(() => "INTERNAL_ERROR", calls) });
    at(0);
    await confirmedCopy(d, u);
    const rd = { copy: d.copy, panta: d.panta };
    for (let i = 1; i <= 20; i++) {
      at(REPORT_RETRY.baseGapSec * 2 ** i);
      await runReportRetries(rd);
    }
    expect(calls).toHaveLength(REPORT_RETRY.maxAttempts);
    expect([...state.copies.values()][0]).toMatchObject({ reportAttempts: REPORT_RETRY.maxAttempts, reportError: "INTERNAL_ERROR" });

    // A fresh failure older than maxAgeSec is not retried either.
    const u2 = await signedInUser();
    const s2 = createCopyMemoryState();
    const calls2: string[] = [];
    const d2 = deps({ state: s2, panta: failing(() => "TX_NOT_FOUND", calls2) });
    at(0);
    await confirmedCopy(d2, u2);
    at(REPORT_RETRY.maxAgeSec + 1);
    expect((await runReportRetries({ copy: d2.copy, panta: d2.panta })).claimed).toBe(0);
    expect(calls2).toHaveLength(1);
  });

  it("TX_FEE_MISMATCH raises an alert and is never retried", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const calls: string[] = [];
    const alerts: string[] = [];
    const d = deps({ state, panta: failing(() => "TX_FEE_MISMATCH", calls), alert: (m: string) => alerts.push(m) });
    at(0);
    const { r } = await confirmedCopy(d, u);
    expect(r).toMatchObject({ reported: false });
    expect(alerts.join("\n")).toMatch(/TX_FEE_MISMATCH/);
    expect(alerts.join("\n")).not.toContain(r.signature); // shortened, not the full signature
    at(REPORT_RETRY.baseGapSec * 1000);
    expect((await runReportRetries({ copy: d.copy, panta: d.panta })).claimed).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("claims are retried too", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const calls: string[] = [];
    let fail: string | null = "RATE_LIMITED";
    const d = deps({ state, panta: failing(() => fail, calls) });
    at(0);
    const win = (await myPositions(d, get("/p", u))).positions.find((p) => p.status === "claimable")!;
    const b = await buildClaimTx(d, post("/cb", { marketId: win.marketId }, u));
    const r = await confirmOrder(d, post("/cc", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u), "claim");
    expect(r).toMatchObject({ status: "confirmed", reported: false });
    fail = null;
    at(REPORT_RETRY.baseGapSec);
    expect(await runReportRetries({ copy: d.copy, panta: d.panta })).toMatchObject({ claimed: 1, reported: 1 });
    expect(await d.copy.isReported(b.orderId)).toBe(true);
  });
});

describe("D-04: copies record the simulated debit exactly", () => {
  it("records and shows 4.995 when the simulation debits 4.995 (never rounded to 4.99 or the stake)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const chain = getSharedMockChain();
    const ata = associatedTokenAddress(u.wallet, USDC_MINT);
    // A simulation that debits 0.005 less than the stake (e.g. the program refunds dust).
    const odd = {
      ...chain,
      simulate: async (t: VersionedTransaction, addrs: string[]) => {
        const r = await chain.simulate(t, addrs);
        const i = addrs.indexOf(ata);
        if (i >= 0 && r.accounts[i]) {
          const data = Buffer.from(r.accounts[i]!.data);
          data.writeBigUInt64LE(data.readBigUInt64LE(64) + 5_000n, 64);
          r.accounts[i] = { ...r.accounts[i]!, data };
        }
        return r;
      },
    };
    const d = deps({ state, chain: odd });
    const { q, b } = await quoteAndBuild(d, u);
    expect(b.checks.usdcOut).toBe("4.995");
    expect(state.orders.get(b.orderId)).toMatchObject({ amountUsdc: "4.995", feeUsdc: q.feeUsdc });
    await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u), "copy");
    expect((await d.copy.listCopies(u.userId, 5))[0]).toMatchObject({ amountUsdc: "4.995" });
  });
});

describe("D-05: a fee-on-top shape against the pin alerts; old cached views are not served", () => {
  it("alerts once per process on a quote that contradicts the pinned model", async () => {
    resetFeeModelAlerts();
    const alerts: string[] = [];
    const d = deps({ feeModel: "on_top", alert: (m: string) => alerts.push(m) }); // the mock quotes inclusive
    const u = await signedInUser();
    expect(await code(quoteCopy(d, get("/q", u), trade.id))).toBe("FEE_MODEL_MISMATCH");
    const u2 = await signedInUser();
    expect(await code(quoteCopy(d, get("/q", u2), trade.id))).toBe("FEE_MODEL_MISMATCH");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/PANTA_FEE_MODEL=on_top/);
    expect(alerts[0]).toMatch(/panta-fee-model\.mjs/);
  });

  it("ignores a quote view cached in the previous deploy's shape", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const s = await getDataStore().getSettings(u.userId);
    const old = { view: { quoteToken: "old", amountUsdc: s!.maxStakeUsdc }, stake: s!.maxStakeUsdc, slippageBps: s!.slippageBps };
    await d.copy.cachePut(`quote:${u.userId}:${trade.id}`, old, Math.floor(Date.now() / 1000) + 10);
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(q.quoteToken).not.toBe("old");
    expect(q).toHaveProperty("feeModel");
  });
});

describe("E-02: a landed copy is never left unrecorded after VERIFY_UNAVAILABLE", () => {
  const chain = getSharedMockChain();
  /** Landed lookups hide the token balances while `blind` is true (RPC meta lag). */
  const lagging = (state: { blind: boolean }) => ({
    ...chain,
    getLandedTransaction: async (sig: string) => {
      const t = await chain.getLandedTransaction(sig);
      return t && (state.blind ? { ...t, payerUsdcOutBase: null } : t);
    },
  });

  it("the 502 body carries orderId and signature; retries by signature or signed bytes work after expiry", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const lag = { blind: true };
    const d = deps({ state, chain: lagging(lag) });
    const { b } = await quoteAndBuild(d, u);
    const signed = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signed, "base64")).signatures[0]);
    let err: unknown;
    try {
      await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: signed }, u), "copy");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthError);
    const res = authErrorResponse(err);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "VERIFY_UNAVAILABLE", orderId: b.orderId, signature: sig, retryable: true });
    expect(state.orders.get(b.orderId)).toMatchObject({ status: "pending", broadcastSignature: sig });

    // Past the 90 s build window: re-sending the same signed bytes is a lookup, not "Nothing was sent".
    const late = deps({ state, chain: lagging(lag), nowMs: () => Date.now() + 120_000 });
    expect(await code(confirmOrder(late, post("/c", { orderId: b.orderId, signedTransaction: signed }, u), "copy"))).toBe(
      "VERIFY_UNAVAILABLE",
    );
    // Past the 15 min lookup window: our own broadcast signature is still accepted.
    lag.blind = false;
    const later = deps({ state, chain: lagging(lag), nowMs: () => Date.now() + 20 * 60_000 });
    expect(await confirmOrder(later, post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).toMatchObject({
      status: "confirmed",
    });
    expect(state.copies.size).toBe(1);
    // ... but a signature we never broadcast still gets the normal 15 min window.
    const { b: b2 } = await quoteAndBuild(deps({ state }), u);
    expect(
      await code(confirmOrder(later, post("/c", { orderId: b2.orderId, signature: bs58.encode(Buffer.alloc(64, 9)) }, u), "copy")),
    ).toBe("ORDER_EXPIRED");
  });

  it("the cron sweep records a broadcast copy the browser gave up on, exactly once", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const lag = { blind: true };
    const d = deps({ state, chain: lagging(lag) });
    const { b } = await quoteAndBuild(d, u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(d, req, "copy"))).toBe("VERIFY_UNAVAILABLE");
    // Too fresh for the sweep (the browser is still polling).
    expect((await sweepBroadcastOrders(d)).checked).toBe(0);
    const later = deps({ state, chain: lagging(lag), nowMs: () => Date.now() + 5 * 60_000 });
    expect(await sweepBroadcastOrders(later)).toMatchObject({ checked: 1, unavailable: 1 });
    lag.blind = false;
    expect(await sweepBroadcastOrders(later)).toMatchObject({ checked: 1, confirmed: 1 });
    expect(state.copies.size).toBe(1);
    expect(await sweepBroadcastOrders(later)).toMatchObject({ checked: 0 });
    expect(state.copies.size).toBe(1);
  });

  it("the sweep applies every on-chain check (a tampered landed tx is not recorded)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const lag = { blind: true };
    const d = deps({ state, chain: lagging(lag) });
    const { b } = await quoteAndBuild(d, u);
    await code(confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u), "copy"));
    const over = {
      ...chain,
      getLandedTransaction: async (sig: string) => {
        const t = await chain.getLandedTransaction(sig);
        return t && { ...t, payerUsdcOutBase: (t.payerUsdcOutBase ?? 0n) + 1n };
      },
    };
    const later = deps({ state, chain: over, nowMs: () => Date.now() + 5 * 60_000 });
    expect(await sweepBroadcastOrders(later)).toMatchObject({ checked: 1, failed: 1 });
    expect(state.copies.size).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
  });

  it("the client keeps polling through VERIFY_UNAVAILABLE, bounded", async () => {
    const sig = bs58.encode(Buffer.alloc(64, 3));
    const unavailable = () => new FlowError("VERIFY_UNAVAILABLE", "later", sig);
    let n = 0;
    const done = await pollConfirm(
      async () => {
        if (++n < 4) throw unavailable();
        return { status: "confirmed", signature: sig, reported: true, simulated: false };
      },
      "o1",
      { orderId: "o1" },
      async () => {},
    );
    expect(done.status).toBe("confirmed");
    expect(n).toBe(4);
    n = 0;
    await expect(
      pollConfirm(
        async () => {
          n++;
          throw unavailable();
        },
        "o1",
        {},
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "PENDING" });
    expect(n).toBe(CONFIRM_POLLS + 1);
    // Other errors stop at once; a 502 without a signature isn't retried blindly.
    await expect(pollConfirm(async () => Promise.reject(new FlowError("TX_FAILED", "x")), "o1", {}, async () => {})).rejects
      .toMatchObject({ code: "TX_FAILED" });
    await expect(
      pollConfirm(async () => Promise.reject(new FlowError("VERIFY_UNAVAILABLE", "x")), "o1", {}, async () => {}),
    ).rejects.toMatchObject({ code: "VERIFY_UNAVAILABLE" });
  });
});
