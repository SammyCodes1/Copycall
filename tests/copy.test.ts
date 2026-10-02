/**
 * Copy + claim flows (steps 9-10, hard requirements 2-4, addendum A/C/H).
 * Real signing with test keypairs against the mock chain, plus mock mode's
 * simulated signing.
 */
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, TransactionInstruction, TransactionMessage, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { GET as quoteRoute } from "@/app/api/copy/[tradeId]/quote/route";
import { POST as buildRoute } from "@/app/api/copy/[tradeId]/build/route";
import { POST as confirmRoute } from "@/app/api/copy/confirm/route";
import { GET as positionsRoute } from "@/app/api/positions/route";
import { AuthError } from "@/lib/auth-core";
import { buildClaimTx, buildCopy, confirmOrder, myPositions, quoteCopy, type FlowDeps } from "@/lib/copy-core";
import { ensureMockData, getDataStore, getUserDeps } from "@/lib/data";
import { MOCK_PROGRAM_ID, getSharedMockChain } from "@/lib/mock/chain-mock";
import { createCopyMemoryState, createMemoryCopyStore, type CopyMemoryState } from "@/lib/mock/copy-store-memory";
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
