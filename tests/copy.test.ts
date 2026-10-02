/**
 * Copy + claim flows (steps 9-10, hard requirements 2-4, addendum A/C/H).
 * Real signing with test keypairs against the mock chain, plus mock mode's
 * simulated signing.
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  LVBH_BOUND_MARGIN,
  MAX_SENDS,
  SWEEP,
  provablyDead,
  sweepBroadcastOrders,
  type FlowDeps,
} from "@/lib/copy-core";
import { authErrorResponse } from "@/lib/auth";
import { CONFIRM_POLLS, FlowError, REVIVE_TRIES, api, pollConfirm, type ConfirmStep } from "@/components/tx-client";
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
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT, associatedTokenAddress, baseToUsdc, usdcToBase } from "@/lib/solana-constants";
import type { StoredTrade } from "@/lib/data-store";
import { SendError, type LandedTx } from "@/lib/chain";
import {
  checkInnerSystemOps,
  checkTokenAuthorityOps,
  checkWalletAccount,
  innerSystemOps,
  tokenAccountDrift,
  tokenAuthorityOps,
  type SimulationResult,
} from "@/lib/tx-guard";
import { ED25519_L } from "@/lib/ed25519";
import type { PendingOrder } from "@/lib/copy-store";
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
    maxStakeCapBase: 1_000_000_000n, // 1000 USDC here; launch-cap tests set their own
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
    process.env.MAX_STAKE_USDC = "20"; // above the saved 7.00 (mock default cap is 5)
    const res = await quoteRoute(get(url, u), { params: Promise.resolve({ tradeId: trade.id }) }).finally(
      () => delete process.env.MAX_STAKE_USDC,
    );
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

  it("refuses a claim that lists the user's ATA but pays someone else (static role check, E-06)", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const logs: string[] = [];
    expect(await code(buildClaimTx(rerouted(true, logs), post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    expect(logs.join("\n")).toContain("PAYOUT_ACCOUNT");
  });

  it("refuses a claim whose simulated payout into the user's ATA is short (simulation)", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const logs: string[] = [];
    const chain = getSharedMockChain();
    const userAta = associatedTokenAddress(u.wallet, USDC_MINT);
    const d = deps({
      log: (m: string) => logs.push(m),
      chain: {
        ...chain,
        simulate: async (tx, addresses) => {
          const r = await chain.simulate(tx, addresses);
          return {
            ...r,
            accounts: r.accounts.map((a, i) => {
              if (!a || addresses[i] !== userAta) return a;
              const data = Buffer.from(a.data);
              data.writeBigUInt64LE(data.readBigUInt64LE(64) - 1n, 64); // the payout went 1 base unit elsewhere
              return { ...a, data };
            }),
          };
        },
      },
    });
    expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
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
      // I-01: failing needs isBlockhashValid === false and no trace at all.
      signatureSeen: async (sig: string) => (hide ? false : chain.signatureSeen(sig)),
      isBlockhashValid: async () => !hide,
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
    for (const r of results) expect(["OK", "ORDER_NOT_PENDING", "SIGNATURE_USED", "QUOTE_EXPIRED", "NOT_BROADCAST"]).toContain(r);
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

describe("E-06: the Panta instruction's account roles are checked (assumed order, fail closed)", () => {
  type Ix = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
  const mutatedCopy = (mutate: (main: Ix, wallet: string) => void, logs: string[], state = createCopyMemoryState()) =>
    deps({
      state,
      log: (m: string) => logs.push(m),
      panta: {
        ...deps().panta,
        buildPrimaryOrder: async (req) => {
          const b = await panta.buildPrimaryOrder(req);
          const ixs = structuredClone(b.instructions) as Ix[];
          mutate(ixs.find((i) => i.programId === MOCK_PROGRAM_ID)!, req.wallet);
          return { ...b, instructions: ixs };
        },
      },
    });

  const attempt = async (mutate: (main: Ix, wallet: string) => void) => {
    const u = await signedInUser();
    const logs: string[] = [];
    const state = createCopyMemoryState();
    const d = mutatedCopy(mutate, logs, state);
    const q = await quoteCopy(d, get("/q", u), trade.id);
    const res = await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id));
    expect(state.orders.size).toBe(res === "OK" ? 1 : 0);
    return { res, log: logs.join("\n") };
  };

  it("the unmodified mock build passes", async () => {
    expect((await attempt(() => {})).res).toBe("OK");
  });

  it("refuses an order for another market in the market slot", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const r = await attempt((m) => (m.accounts[1] = { ...m.accounts[1], pubkey: other }));
    expect(r).toMatchObject({ res: "TX_REJECTED" });
    expect(r.log).toContain("MARKET_MISMATCH");
  });

  it("refuses an order whose user slot isn't the signing wallet", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const r1 = await attempt((m) => (m.accounts[0] = { ...m.accounts[0], pubkey: other, isSigner: false }));
    expect(r1.res).toBe("TX_REJECTED");
    const r2 = await attempt((m) => (m.accounts[0] = { ...m.accounts[0], isSigner: false }));
    expect(r2.res).toBe("TX_REJECTED");
    expect(r2.log).toContain("ACCOUNT_ROLES");
  });

  it("refuses an order whose USDC source isn't the user's own ATA", async () => {
    const thief = Keypair.generate().publicKey.toBase58();
    getSharedMockChain().seedWallet(thief);
    const r = await attempt(
      (m) => (m.accounts[2] = { ...m.accounts[2], pubkey: associatedTokenAddress(thief, USDC_MINT) }),
    );
    expect(r.res).toBe("TX_REJECTED");
    expect(r.log).toContain("USDC_SOURCE");
  });

  it("refuses swapped roles, a wrong mint/token program and a truncated account list", async () => {
    const swap = await attempt((m) => ([m.accounts[1], m.accounts[2]] = [m.accounts[2], m.accounts[1]]));
    expect(swap.res).toBe("TX_REJECTED");
    const mint = await attempt((m) => (m.accounts[4] = { ...m.accounts[4], pubkey: Keypair.generate().publicKey.toBase58() }));
    expect(mint.res).toBe("TX_REJECTED");
    expect(mint.log).toContain("ACCOUNT_ROLES");
    const short = await attempt((m) => (m.accounts = m.accounts.slice(0, 3)));
    expect(short.res).toBe("TX_REJECTED");
  });

  it("G-06: the market can't repeat in another slot; the mint and Token program can't be writable", async () => {
    const dup = await attempt((m) => (m.accounts[3] = { ...m.accounts[1] }));
    expect(dup.res).toBe("TX_REJECTED");
    expect(dup.log).toContain("ACCOUNT_ROLES");
    const appended = await attempt((m) => m.accounts.push({ ...m.accounts[1], isWritable: false }));
    expect(appended.res).toBe("TX_REJECTED");
    for (const slot of [4, 5]) {
      const w = await attempt((m) => (m.accounts[slot] = { ...m.accounts[slot], isWritable: true }));
      expect(w.res).toBe("TX_REJECTED");
      expect(w.log).toContain("ACCOUNT_ROLES");
    }
    expect((await attempt(() => {})).res).toBe("OK");
  });

  it("claims: the user slot and market slot are enforced too", async () => {
    const u = await signedInUser();
    const win = (await myPositions(deps(), get("/p", u))).positions.find((p) => p.status === "claimable")!;
    for (const [slot, field] of [[0, "pubkey"], [1, "pubkey"], [0, "isSigner"]] as const) {
      const logs: string[] = [];
      const d = deps({
        log: (m: string) => logs.push(m),
        panta: {
          ...deps().panta,
          buildClaim: async (req) => {
            const c = await panta.buildClaim(req);
            const ixs = structuredClone(c.instructions) as Ix[];
            const main = ixs.find((i) => i.programId === MOCK_PROGRAM_ID)!;
            main.accounts[slot] =
              field === "pubkey"
                ? { ...main.accounts[slot], pubkey: Keypair.generate().publicKey.toBase58() }
                : { ...main.accounts[slot], isSigner: false };
            return { ...c, instructions: ixs };
          },
        },
      });
      expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    }
  });
});

describe("E-04: the claim minimum doesn't trust Panta's winningShares", () => {
  const winFor = async (u: User) =>
    (await myPositions(deps(), get("/p", u))).positions.find((p) => p.status === "claimable")!;

  it("refuses a build that understates winningShares (0.01 vs the real position)", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    expect(usdcToBase(win.shares)).toBeGreaterThan(10_000n);
    const logs: string[] = [];
    const state = createCopyMemoryState();
    const d = deps({
      state,
      log: (m: string) => logs.push(m),
      panta: { ...deps().panta, buildClaim: async (req) => ({ ...(await panta.buildClaim(req)), winningShares: "0.01" }) },
    });
    expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    expect(logs.join("\n")).toContain("CLAIM_MISMATCH");
    expect(state.orders.size).toBe(0);
  });

  it("refuses when Panta's positions agree with the build but the on-chain position doesn't", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const lie = (r: Awaited<ReturnType<typeof panta.getPositions>>) => ({
      ...r,
      positions: r.positions.map((p) => (p.marketId === win.marketId ? { ...p, shares: "0.01" } : p)),
    });
    const logs: string[] = [];
    const d = deps({
      log: (m: string) => logs.push(m),
      panta: {
        ...deps().panta,
        buildClaim: async (req) => ({ ...(await panta.buildClaim(req)), winningShares: "0.01" }),
        getPositions: async (w) => lie(await panta.getPositions(w)),
      },
    });
    expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    expect(logs.join("\n")).toContain("on-chain position");
  });

  it("without an on-chain reader, recorded copies still set a floor", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const state = createCopyMemoryState();
    const chain = getSharedMockChain();
    const { getPositionSharesBase: _drop, ...noPositionReader } = chain;
    void _drop;
    const store = createMemoryCopyStore(state);
    // We recorded a copy of 20 shares on the winning side; Panta (consistently) claims 1 share.
    const recorded = {
      id: randomUUID(),
      leaderTradeId: randomUUID(),
      marketId: win.marketId,
      side: win.side,
      amountUsdc: "10.000000",
      feeUsdc: "0.000000",
      shares: "20.000000",
      signature: bs58.encode(Buffer.alloc(64, 7)),
      status: "confirmed" as const,
      createdAt: Date.now(),
    };
    const lie = (r: Awaited<ReturnType<typeof panta.getPositions>>) => ({
      ...r,
      positions: r.positions.map((p) => (p.marketId === win.marketId ? { ...p, shares: "1" } : p)),
    });
    const logs: string[] = [];
    const d = deps({
      copy: { ...store, listCopies: async () => [recorded] },
      log: (m: string) => logs.push(m),
      chain: noPositionReader,
      panta: {
        ...deps().panta,
        buildClaim: async (req) => ({ ...(await panta.buildClaim(req)), winningShares: "1" }),
        getPositions: async (w) => lie(await panta.getPositions(w)),
      },
    });
    expect(await code(buildClaimTx(d, post("/cb", { marketId: win.marketId }, u)))).toBe("TX_REJECTED");
    expect(logs.join("\n")).toContain("recorded copies");
  });

  it("an honest claim stores the independently checked minimum", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    const state = createCopyMemoryState();
    const d = deps({ state });
    const b = await buildClaimTx(d, post("/cb", { marketId: win.marketId }, u));
    expect(state.orders.get(b.orderId)?.shares).toBe(baseToUsdc(usdcToBase(win.shares)));
  });
});

describe("E-09: a missing fee config only blocks quote and build", () => {
  it("quote and build answer 503; positions, claim build and claim confirm still work", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const ok = deps({ state });
    const q = await quoteCopy(ok, get("/q", u), trade.id);
    const off = deps({ state, feeModel: null, feeCapBps: null });
    expect(await code(quoteCopy(off, get("/q", u), trade.id))).toBe("NOT_CONFIGURED");
    expect(await code(buildCopy(off, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("NOT_CONFIGURED");
    const pos = await myPositions(off, get("/p", u));
    const win = pos.positions.find((p) => p.status === "claimable")!;
    const b = await buildClaimTx(off, post("/cb", { marketId: win.marketId }, u));
    const req = post("/cc", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await confirmOrder(off, req, "claim")).toMatchObject({ status: "confirmed" });
  });
});

describe("F-01: the wallet stays a plain System account (no Assign/Allocate, even via CPI)", () => {
  const SYSTEM = "11111111111111111111111111111111";
  const attacker = () => Keypair.generate().publicKey.toBase58();
  const u32 = (n: number, extra = 0) => {
    const b = Buffer.alloc(4 + extra);
    b.writeUInt32LE(n, 0);
    return bs58.encode(b);
  };

  it("parses inner System instructions in the jsonParsed, partially decoded and compiled shapes", () => {
    const w = attacker();
    const keys = [w, SYSTEM, attacker()];
    const parsed = [{ index: 0, instructions: [{ program: "system", programId: SYSTEM, parsed: { type: "assign", info: { account: w, owner: keys[2] } } }] }];
    expect(innerSystemOps(parsed, keys)).toEqual([{ type: "assign", target: w }]);
    const partial = [{ index: 0, instructions: [{ programId: SYSTEM, accounts: [w], data: u32(8, 8) }] }];
    expect(innerSystemOps(partial, keys)).toEqual([{ type: "allocate", target: w }]);
    const compiled = [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: u32(10, 40) }] }];
    expect(innerSystemOps(compiled, keys)).toEqual([{ type: "assignWithSeed", target: w }]);
    const create = [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2, 0], data: u32(0, 48) }] }];
    expect(innerSystemOps(create, keys)).toEqual([{ type: "createAccount", target: w }]);
    const nonce = [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0], data: u32(6) }] }];
    expect(innerSystemOps(nonce, keys)).toEqual([{ type: "unknown", target: null }]);
    const transfer = [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [0, 2], data: u32(2, 8) }] }];
    expect(innerSystemOps(transfer, keys)).toEqual([{ type: "transfer", target: null }]);
    expect(() => innerSystemOps(null, keys)).toThrow();
    expect(() => innerSystemOps([{ instructions: [null] }], keys)).toThrow();
  });

  it("checkInnerSystemOps refuses ops on the wallet and unknown System ops; other accounts are fine", () => {
    const w = attacker();
    for (const type of ["assign", "allocate", "assignWithSeed", "allocateWithSeed", "createAccount", "createAccountWithSeed"])
      expect(() => checkInnerSystemOps([{ type, target: w }], w)).toThrow(/wallet/);
    expect(() => checkInnerSystemOps([{ type: "unknown", target: null }], w)).toThrow();
    expect(() => checkInnerSystemOps(null, w)).toThrow();
    expect(() => checkInnerSystemOps([{ type: "createAccount", target: attacker() }, { type: "transfer", target: null }], w)).not.toThrow();
  });

  /** Build a copy against a simulation whose results are rewritten. */
  const simWith = (rewrite: (r: SimulationResult, addresses: string[]) => SimulationResult) => {
    const chain = getSharedMockChain();
    return { ...chain, simulate: async (tx: VersionedTransaction, a: string[]) => rewrite(await chain.simulate(tx, a), a) };
  };
  const buildWith = async (chain: FlowDeps["chain"]) => {
    const u = await signedInUser();
    const logs: string[] = [];
    const state = createCopyMemoryState();
    const d = deps({ state, chain, log: (m: string) => logs.push(m) });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    const res = await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id));
    return { res, log: logs.join("\n"), orders: state.orders.size };
  };

  it("simulation: a wallet re-owned by another program is refused", async () => {
    const r = await buildWith(simWith((s) => ({ ...s, accounts: s.accounts.map((a, i) => (i === 0 && a ? { ...a, owner: attacker() } : a)) })));
    expect(r).toMatchObject({ res: "TX_REJECTED", orders: 0 });
    expect(r.log).toContain("WALLET_OWNER");
  });

  it("simulation: an allocated (data) or executable wallet is refused", async () => {
    const data = await buildWith(simWith((s) => ({ ...s, accounts: s.accounts.map((a, i) => (i === 0 && a ? { ...a, data: Buffer.alloc(32) } : a)) })));
    expect(data.log).toContain("WALLET_OWNER");
    const exec = await buildWith(simWith((s) => ({ ...s, accounts: s.accounts.map((a, i) => (i === 0 && a ? { ...a, executable: true } : a)) })));
    expect(exec.log).toContain("WALLET_OWNER");
  });

  it("simulation: an Assign CPI of the wallet is refused even if it's assigned back", async () => {
    const r = await buildWith(
      simWith((s, a) => ({ ...s, innerSystemOps: [...(s.innerSystemOps ?? []), { type: "assign", target: a[0] }] })),
    );
    expect(r).toMatchObject({ res: "TX_REJECTED", orders: 0 });
    expect(r.log).toContain("WALLET_OWNER");
  });

  it("simulation: unknown System ops, a missing System op list or a missing owner fail closed", async () => {
    const nonce = await buildWith(simWith((s) => ({ ...s, innerSystemOps: [{ type: "unknown", target: null }] })));
    expect(nonce.log).toContain("SYSTEM_CPI");
    const none = await buildWith(simWith((s) => ({ ...s, innerSystemOps: null })));
    expect(none.log).toContain("INNER_UNAVAILABLE");
    const noOwner = await buildWith(
      simWith((s) => ({ ...s, accounts: s.accounts.map((a, i) => (i === 0 && a ? ({ data: a.data, lamports: a.lamports } as never) : a)) })),
    );
    expect(noOwner.log).toContain("SIMULATION_ACCOUNTS");
  });

  it("the real RPC adapter maps owner/executable and the jsonParsed inner System instructions", async () => {
    process.env.SOLANA_RPC_URL ??= "https://rpc.example/";
    const { Connection } = await import("@solana/web3.js");
    const { rpcChain } = await import("@/lib/solana");
    const w = Keypair.generate();
    const evil = attacker();
    const tx = new VersionedTransaction(
      new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: bs58.encode(Buffer.alloc(32, 1)), instructions: [] }).compileToV0Message(),
    );
    const spy = vi.spyOn(Connection.prototype, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: {
        err: null,
        logs: [],
        accounts: [{ data: ["", "base64"], lamports: 1, owner: evil, executable: false, rentEpoch: 0 }],
        innerInstructions: [{ index: 0, instructions: [{ program: "system", programId: SYSTEM, parsed: { type: "assign", info: { account: w.publicKey.toBase58(), owner: evil } } }] }],
      },
    } as never);
    try {
      const r = await rpcChain.simulate(tx, [w.publicKey.toBase58()]);
      expect(spy.mock.calls[0][1]).toMatchObject({ sigVerify: false, innerInstructions: true, accounts: { encoding: "base64" } });
      expect(r.accounts[0]).toMatchObject({ owner: evil, executable: false });
      expect(r.innerSystemOps).toEqual([{ type: "assign", target: w.publicKey.toBase58() }]);
      expect(() => checkInnerSystemOps(r.innerSystemOps, w.publicKey.toBase58())).toThrow(/wallet/);
    } finally {
      spy.mockRestore();
    }
  });

  const landedWith = (over: (t: LandedTx, wallet: string) => Partial<LandedTx>, walletAccount?: () => Promise<unknown>) => {
    const chain = getSharedMockChain();
    return {
      ...chain,
      getLandedTransaction: async (sig: string) => {
        const t = await chain.getLandedTransaction(sig);
        return t && { ...t, ...over(t, t.message.staticAccountKeys[0].toBase58()) };
      },
      ...(walletAccount ? { getWalletAccount: walletAccount as FlowDeps["chain"]["getWalletAccount"] } : {}),
    };
  };
  const confirmWith = async (chain: FlowDeps["chain"]) => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const alerts: string[] = [];
    const d = deps({ state, chain, alert: (m: string) => alerts.push(m) });
    const { b } = await quoteAndBuild(d, u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    return { res: await code(confirmOrder(d, req, "copy")), state, b, alerts };
  };

  it("H-01 simulation: a null wallet entry is refused, even when the wallet holds <= 0.02 SOL", async () => {
    const poor = {
      ...simWith((s) => ({ ...s, accounts: s.accounts.map((a, i) => (i === 0 ? null : a)) })),
      getLamports: async () => 10_000_000, // 0.01 SOL: the SOL-spend limit alone would let it through
    };
    const r = await buildWith(poor);
    expect(r).toMatchObject({ res: "TX_REJECTED", orders: 0 });
    expect(r.log).toContain("SIMULATION_ACCOUNTS");
    expect(() => checkWalletAccount(null)).toThrow(/wallet/);
  });

  it("J-09 simulation: a wallet entry without lamports is a clean 422 refusal (not a TypeError/500)", async () => {
    const r = await buildWith(
      simWith((s) => ({
        ...s,
        accounts: s.accounts.map((a, i) => (i === 0 && a ? ({ ...a, lamports: undefined } as unknown as typeof a) : a)),
      })),
    );
    expect(r).toMatchObject({ res: "TX_REJECTED", orders: 0 });
    expect(r.log).toContain("SIMULATION_ACCOUNTS");
  });

  it("J-07: the auditor's PoF: the wallet emptied (gone) AFTER the copy landed -> recorded; the landed post-state decides", async () => {
    let reads = 0;
    const r = await confirmWith(landedWith(() => ({}), async () => (reads++, null)));
    expect(r.res).toBe("OK");
    expect(r.state.copies.size).toBe(1);
    expect(reads).toBe(0); // the current state is never consulted
    expect(r.alerts.join("\n")).not.toContain("WALLET_MISSING");
  });

  it("J-07: the landed tx itself left the wallet at 0 lamports, or post balances are missing -> retryable, never recorded or failed; alerted once", async () => {
    const closed = landedWith(() => ({ payerPostLamports: 0 }));
    const r = await confirmWith(closed);
    expect(r.res).toBe("VERIFY_UNAVAILABLE");
    expect(r.state.copies.size).toBe(0);
    expect(r.state.orders.get(r.b.orderId)?.status).toBe("pending");
    expect(r.alerts.filter((m) => m.includes("WALLET_MISSING")).length).toBe(1);
    // The sweep re-checks it: no second alert for the same order, and never failed (it landed).
    const alerts: string[] = [];
    const later = deps({ state: r.state, chain: closed, alert: (m) => alerts.push(m), nowMs: () => Date.now() + 2 * 60_000 });
    for (let i = 0; i < 3; i++) await sweepBroadcastOrders(later);
    expect(alerts.filter((m) => m.includes("WALLET_MISSING"))).toEqual([]);
    expect(r.state.orders.get(r.b.orderId)?.status).toBe("pending");
    const unknown = await confirmWith(landedWith(() => ({ payerPostLamports: null })));
    expect(unknown.res).toBe("VERIFY_UNAVAILABLE");
    expect(unknown.state.orders.get(unknown.b.orderId)?.status).toBe("pending");
  });

  it("confirm: a landed Assign of the wallet fails the order, records nothing and alerts", async () => {
    const r = await confirmWith(landedWith((t, w) => ({ innerSystemOps: [...(t.innerSystemOps ?? []), { type: "assign", target: w }] })));
    expect(r.res).toBe("TX_REJECTED");
    expect(r.state.copies.size).toBe(0);
    expect(r.state.orders.get(r.b.orderId)?.status).toBe("failed");
    expect(r.alerts.join("\n")).toContain("WALLET_OWNER");
  });

  it("J-07: a wallet re-owned LATER (not by this tx) doesn't un-record the copy; unknown System ops stay retryable", async () => {
    // This tx has no Assign/Allocate/Create of the wallet (inner or top level), so the owner at the
    // landed slot is what the runtime required of the fee payer: System. Later changes are not this tx.
    const owned = await confirmWith(landedWith(() => ({}), async () => ({ owner: attacker(), executable: false, dataLength: 0 })));
    expect(owned.res).toBe("OK");
    const unknown = await confirmWith(landedWith(() => ({ innerSystemOps: null })));
    expect(unknown.res).toBe("VERIFY_UNAVAILABLE");
    expect(unknown.state.orders.get(unknown.b.orderId)?.status).toBe("pending");
    const rpcDown = await confirmWith(landedWith(() => ({}), async () => Promise.reject(new Error("rpc down"))));
    expect(rpcDown.res).toBe("OK"); // no current-state read any more
  });
});

describe("F-04: the shipped client re-checks by signature after a lost response, expiry or a 409", () => {
  /** Route the real client `api()` through confirmOrder with these deps, like the browser would. */
  const wire = (d: FlowDeps, u: User, opts: { dropFirstResponse?: boolean } = {}) => {
    const bodies: Record<string, unknown>[] = [];
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      let res: Response;
      try {
        res = Response.json(await confirmOrder(d, post("/api/copy/confirm", body, u), "copy"));
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        res = authErrorResponse(e);
      }
      if (calls++ === 0 && opts.dropFirstResponse) throw new TypeError("network down"); // server ran, response lost
      return res;
    }) as typeof fetch;
    const postFn = (body: unknown) => api<ConfirmStep>("POST", "/api/copy/confirm", body).then((x) => x.data);
    return { postFn, bodies, restore: () => (globalThis.fetch = realFetch) };
  };
  const signedFirst = async (d: FlowDeps, u: User) => {
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64")).signatures[0]);
    return { b, sig, first: { orderId: b.orderId, signedTransaction } };
  };

  it("a lost response after broadcast: the client re-posts the same signed bytes once (a lookup), and it's recorded", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const chain = getSharedMockChain();
    const sends: Uint8Array[] = [];
    const d = deps({ state, chain: { ...chain, send: async (r: Uint8Array) => (sends.push(r), chain.send(r)) } });
    const { b, sig, first } = await signedFirst(d, u);
    const w = wire(d, u, { dropFirstResponse: true });
    try {
      const r = await pollConfirm(w.postFn, b.orderId, first, async () => {}, sig);
      expect(r).toMatchObject({ status: "confirmed", signature: sig });
      expect(w.bodies[1]).toEqual(first); // H-03: the server dedupes; it was already broadcast
      expect(sends.length).toBe(1);
      expect(state.copies.size).toBe(1);
    } finally {
      w.restore();
    }
  });

  it("expired-then-landed: QUOTE_EXPIRED carries the signature and the client revives it", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const chain = getSharedMockChain();
    let hidden = true;
    const d = deps({
      state,
      chain: {
        ...chain,
        waitForConfirmation: async (...a: Parameters<typeof chain.waitForConfirmation>) => (hidden ? "expired" : chain.waitForConfirmation(...a)),
        getLandedTransaction: async (sig: string) => {
          if (hidden) {
            hidden = false; // the RPC catches up on the next look
            return null;
          }
          return chain.getLandedTransaction(sig);
        },
      },
    });
    const { b, sig, first } = await signedFirst(d, u);
    const w = wire(d, u);
    try {
      const r = await pollConfirm(w.postFn, b.orderId, first, async () => {}, sig);
      expect(r.status).toBe("confirmed");
      expect(w.bodies.map((x) => Object.keys(x).sort().join(","))).toEqual(["orderId,signedTransaction", "orderId,signature"]);
      expect(state.copies.size).toBe(1);
      expect(state.orders.get(b.orderId)?.status).toBe("confirmed");
    } finally {
      w.restore();
    }
  });

  it("a truly expired transaction: the client re-checks at most REVIVE_TRIES times, then stops", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const chain = getSharedMockChain();
    const d = deps({
      state,
      chain: {
        ...chain,
        send: async () => "x",
        waitForConfirmation: async () => "expired",
        getLandedTransaction: async () => null,
        signatureSeen: async () => false,
        isBlockhashValid: async () => false, // I-01: proven expired, not just past a height
      },
    });
    const { b, sig, first } = await signedFirst(d, u);
    const w = wire(d, u);
    try {
      await expect(pollConfirm(w.postFn, b.orderId, first, async () => {}, sig)).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
      expect(w.bodies.length).toBe(1 + REVIVE_TRIES);
      expect(state.copies.size).toBe(0);
    } finally {
      w.restore();
    }
  });

  it("an order failed concurrently after verification is still recorded (server), and 409s carry the signature", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const store = createMemoryCopyStore(state);
    let raced = false;
    const d = deps({
      state,
      copy: {
        ...store,
        completeOrder: async (...a: Parameters<typeof store.completeOrder>) => {
          if (!raced) {
            raced = true;
            await store.failOrder(a[0]); // a parallel expiry check wins the race
          }
          return store.completeOrder(...a);
        },
      },
    });
    const { b, sig, first } = await signedFirst(d, u);
    const alerts: string[] = [];
    const r = await confirmOrder({ ...d, alert: (m) => alerts.push(m) }, post("/c", first, u), "copy");
    expect(r).toMatchObject({ status: "confirmed", signature: sig });
    expect(state.copies.size).toBe(1);
    // H-02: the revive of a concurrently failed order is alerted (the fail reason isn't stored).
    expect(alerts.join("\n")).toMatch(/revived concurrently failed order .* cap 1000/);
    // The revivable codes carry the signature in the JSON body.
    const body = await authErrorResponse(
      new AuthError(409, "ORDER_NOT_PENDING", "x", { orderId: b.orderId, signature: sig, revivable: true }),
    ).json();
    expect(body).toMatchObject({ code: "ORDER_NOT_PENDING", signature: sig });
  });

  it("errors without a signature, TX_FAILED and pre-broadcast expiry are not retried", async () => {
    let n = 0;
    const fail = (e: FlowError) => async () => {
      n++;
      throw e;
    };
    await expect(pollConfirm(fail(new FlowError("QUOTE_EXPIRED", "Nothing was sent")), "o", {}, async () => {})).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(n).toBe(1);
    n = 0;
    const sig = bs58.encode(Buffer.alloc(64, 4));
    await expect(pollConfirm(fail(new FlowError("TX_FAILED", "x", sig)), "o", {}, async () => {}, sig)).rejects.toMatchObject({ code: "TX_FAILED" });
    expect(n).toBe(1);
    n = 0;
    // A 5xx with no known signature isn't retried blindly; with one it's bounded by CONFIRM_POLLS.
    await expect(pollConfirm(fail(new FlowError("ERROR", "x", undefined, 500)), "o", {}, async () => {})).rejects.toMatchObject({ code: "ERROR" });
    expect(n).toBe(1);
    n = 0;
    await expect(pollConfirm(fail(new FlowError("ERROR", "x", undefined, 500)), "o", {}, async () => {}, sig)).rejects.toMatchObject({ code: "PENDING" });
    expect(n).toBe(CONFIRM_POLLS + 1);
  });
});

describe("Launch cap (MAX_STAKE_USDC) is enforced at quote, build, simulation and confirm", () => {
  const CAP5 = 5_000_000n;
  /** Drop the cached quote so each case gets a fresh single-use quote token. */
  const d0Cache = async (state: CopyMemoryState, u: User) => createMemoryCopyStore(state).cacheDelete(`quote:${u.userId}:${trade.id}`);
  const stakeOf = async (u: User, maxStakeUsdc: string) =>
    getDataStore().updateSettings(u.userId, { maxStakeUsdc, slippageBps: 200, alertsEnabled: true });

  it("quote: a saved stake above the cap is refused; a missing cap is 503 (never no-limit)", async () => {
    const u = await signedInUser();
    await stakeOf(u, "7.00");
    expect(await code(quoteCopy(deps({ maxStakeCapBase: CAP5 }), get("/q", u), trade.id))).toBe("STAKE_ABOVE_CAP");
    expect(await code(quoteCopy(deps({ maxStakeCapBase: null }), get("/q", u), trade.id))).toBe("NOT_CONFIGURED");
    expect(await code(quoteCopy(deps({ maxStakeCapBase: 0n }), get("/q", u), trade.id))).toBe("NOT_CONFIGURED");
    await stakeOf(u, "5.00");
    expect(await code(quoteCopy(deps({ maxStakeCapBase: CAP5 }), get("/q", u), trade.id))).toBe("OK");
  });

  it("build: a cap lowered (or removed) after the quote refuses the build before Panta is asked", async () => {
    const u = await signedInUser();
    await stakeOf(u, "7.00");
    const state = createCopyMemoryState();
    let builds = 0;
    const counting = { ...deps().panta, buildPrimaryOrder: async (r: Parameters<typeof panta.buildPrimaryOrder>[0]) => (builds++, panta.buildPrimaryOrder(r)) };
    for (const cap of [CAP5, null]) {
      await d0Cache(state, u);
      const q = await quoteCopy(deps({ state }), get("/q", u), trade.id);
      const d = deps({ state, maxStakeCapBase: cap, panta: counting });
      expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe(cap ? "STAKE_ABOVE_CAP" : "NOT_CONFIGURED");
    }
    expect(builds).toBe(0);
    expect(state.orders.size).toBe(0);
  });

  it("simulation: at the cap, a simulated debit 1 base unit over is refused", async () => {
    const u = await signedInUser();
    await stakeOf(u, "5.00");
    const chain = getSharedMockChain();
    const ata = associatedTokenAddress(u.wallet, USDC_MINT);
    const logs: string[] = [];
    const d = deps({
      maxStakeCapBase: CAP5,
      log: (m: string) => logs.push(m),
      chain: {
        ...chain,
        simulate: async (tx, a) => {
          const r = await chain.simulate(tx, a);
          return {
            ...r,
            accounts: r.accounts.map((x, i) => {
              if (!x || a[i] !== ata) return x;
              const data = Buffer.from(x.data);
              data.writeBigUInt64LE(data.readBigUInt64LE(64) - 1n, 64);
              return { ...x, data };
            }),
          };
        },
      },
    });
    const q = await quoteCopy(d, get("/q", u), trade.id);
    expect(await code(buildCopy(d, post("/b", { quoteToken: q.quoteToken }, u), trade.id))).toBe("TX_REJECTED");
    expect(logs.join("\n")).toContain("OVER_STAKE");
  });

  it("confirm: an order built under a higher cap is refused if it moved more than the current cap", async () => {
    const u = await signedInUser();
    await stakeOf(u, "7.00");
    const state = createCopyMemoryState();
    const { b } = await quoteAndBuild(deps({ state }), u); // cap 1000 at build
    const d = deps({ state, maxStakeCapBase: CAP5 });
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(d, req, "copy"))).toBe("OVER_LIMIT");
    expect(state.copies.size).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
  });

  it("confirm: a missing cap keeps the copy pending and retryable, never unlimited", async () => {
    const u = await signedInUser();
    await stakeOf(u, "5.00");
    const state = createCopyMemoryState();
    const { b } = await quoteAndBuild(deps({ state }), u);
    const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await code(confirmOrder(deps({ state, maxStakeCapBase: null }), req, "copy"))).toBe("VERIFY_UNAVAILABLE");
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    expect(state.copies.size).toBe(0);
    // Once configured, the same signature records it.
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(sign(b.transaction, u.secretKey), "base64")).signatures[0]);
    expect(await confirmOrder(deps({ state, maxStakeCapBase: CAP5 }), post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).toMatchObject({ status: "confirmed" });
  });

  it("claims don't depend on the launch cap", async () => {
    const u = await signedInUser();
    const win = (await myPositions(deps(), get("/p", u))).positions.find((p) => p.status === "claimable")!;
    const d = deps({ maxStakeCapBase: null });
    const b = await buildClaimTx(d, post("/cb", { marketId: win.marketId }, u));
    const req = post("/cc", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    expect(await confirmOrder(d, req, "claim")).toMatchObject({ status: "confirmed" });
  });
});

describe("Addendum G: broadcast liveness, definite rejections, bounded re-sends, canonical signatures", () => {
  const chain = getSharedMockChain();
  const later = (state: CopyMemoryState, over: Partial<FlowDeps> = {}) =>
    deps({ state, nowMs: () => Date.now() + 5 * 60_000, resendDelayMs: 0, ...over });
  const signedOf = async (d: FlowDeps, u: User) => {
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const raw = Buffer.from(signedTransaction, "base64");
    const sig = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
    return { b, sig, raw, first: { orderId: b.orderId, signedTransaction } };
  };
  /** A chain whose sends are recorded and (unless `land`) dropped on the floor. */
  const dropping = (o: {
    land: boolean;
    valid?: boolean;
    /** past lastValidBlockHeight with no status (the height hint) */
    expire?: boolean;
    sends: Uint8Array[];
    refuse?: (n: number) => string | null;
  }) => ({
    ...chain,
    send: async (raw: Uint8Array) => {
      o.sends.push(raw);
      const why = o.refuse?.(o.sends.length);
      // I-01: a structured preflight refusal (-32002 with a TransactionError).
      if (why) throw new SendError("refused", -32002, why);
      return o.land ? chain.send(raw) : bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]);
    },
    isBlockhashValid: async () => o.valid ?? true,
    waitForConfirmation: async (s: string, h: number | null, t: number) => {
      const r = await chain.waitForConfirmation(s, h, t);
      return r === "pending" && o.expire ? ("expired" as const) : r;
    },
  });

  describe("G-01: the real-chain adapter always reads the status, even with a zero timeout", () => {
    const setup = async () => {
      process.env.SOLANA_RPC_URL ??= "https://rpc.example/";
      const { Connection } = await import("@solana/web3.js");
      const { rpcChain, getConnection } = await import("@/lib/solana");
      // getBlockHeight is an instance arrow property in web3.js, so it's stubbed on the shared connection.
      const height = (h: number) => vi.spyOn(getConnection(), "getBlockHeight").mockResolvedValue(h);
      return { Connection, rpcChain, height };
    };
    const sig = bs58.encode(Buffer.alloc(64, 2));

    it("timeout 0: one getSignatureStatuses read, and a confirmed status is returned (it used to be 'pending' unread)", async () => {
      const { Connection, rpcChain } = await setup();
      const st = vi
        .spyOn(Connection.prototype, "getSignatureStatuses")
        .mockResolvedValue({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] } as never);
      try {
        expect(await rpcChain.waitForConfirmation(sig, 100, 0)).toBe("confirmed");
        expect(st).toHaveBeenCalledTimes(1);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("timeout 0 and past the expiry: expired only after a second status read", async () => {
      const { Connection, rpcChain, height } = await setup();
      const st = vi
        .spyOn(Connection.prototype, "getSignatureStatuses")
        .mockResolvedValue({ context: { slot: 1 }, value: [null] } as never);
      height(500);
      try {
        expect(await rpcChain.waitForConfirmation(sig, 100, 0)).toBe("expired");
        expect(st).toHaveBeenCalledTimes(2);
        expect(await rpcChain.waitForConfirmation(sig, 900, 0)).toBe("pending");
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("G-02: no lastValidBlockHeight: expiry comes from the blockhash's validity", async () => {
      const { Connection, rpcChain } = await setup();
      vi.spyOn(Connection.prototype, "getSignatureStatuses").mockResolvedValue({ context: { slot: 1 }, value: [null] } as never);
      const valid = vi.spyOn(Connection.prototype, "isBlockhashValid").mockResolvedValue({ context: { slot: 1 }, value: false });
      try {
        const bh = bs58.encode(Buffer.alloc(32, 7));
        expect(await rpcChain.waitForConfirmation(sig, null, 0, bh)).toBe("expired");
        expect(valid.mock.calls[0][0]).toBe(bh);
        valid.mockResolvedValue({ context: { slot: 1 }, value: true });
        expect(await rpcChain.waitForConfirmation(sig, null, 0, bh)).toBe("pending");
        expect(await rpcChain.waitForConfirmation(sig, null, 0)).toBe("pending"); // nothing to decide from: never "expired"
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("the cron sweep on the real adapter reads the broadcast signature's status", async () => {
      const { Connection, rpcChain, height } = await setup();
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const d = deps({ state });
      const { first, sig: broadcast } = await signedOf(d, u);
      const st = vi
        .spyOn(Connection.prototype, "getSignatureStatuses")
        .mockResolvedValue({ context: { slot: 1 }, value: [null] } as never);
      height(0);
      vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue(null);
      vi.spyOn(Connection.prototype, "isBlockhashValid").mockResolvedValue({ context: { slot: 1 }, value: false });
      state.orders.get(first.orderId)!.broadcastSignature = broadcast; // broadcast, never confirmed by the browser
      try {
        const r = await sweepBroadcastOrders(later(state, { chain: rpcChain }));
        expect(r).toMatchObject({ checked: 1, pending: 1 });
        expect(st).toHaveBeenCalled();
        expect(st.mock.calls[0][0]).toEqual([broadcast]);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("G-02: definite rejections fail the order; the sweep can't be starved and gives up", () => {
    it("a landed tx that doesn't match the order, for OUR broadcast signature, fails the order", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const o = { land: false, sends: [] as Uint8Array[] };
      const d = deps({ state, chain: dropping(o) });
      const { b, sig } = await signedOf(d, u);
      expect((await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u), "copy")).status).toBe(
        "pending",
      );
      // It "lands" with a different message under our signature (a lying RPC, or a hash mismatch).
      const other = new TransactionMessage({
        payerKey: new PublicKey(u.wallet),
        recentBlockhash: bs58.encode(Buffer.alloc(32, 5)),
        instructions: [],
      }).compileToV0Message();
      const tampered = {
        ...dropping(o),
        getLandedTransaction: async () => ({ ...(await chain.getLandedTransaction(chain.landForeign(other)))!, signatures: [sig] }),
        waitForConfirmation: async () => "confirmed" as const,
      };
      expect(await sweepBroadcastOrders(later(state, { chain: tampered }))).toMatchObject({ checked: 1, failed: 1 });
      expect(state.orders.get(b.orderId)?.status).toBe("failed");
      expect(await sweepBroadcastOrders(later(state, { chain: tampered }))).toMatchObject({ checked: 0 });
    });

    it("a user pasting some other landed signature can't kill their own pending order", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const d = deps({ state });
      const { b } = await quoteAndBuild(d, u);
      const other = new TransactionMessage({
        payerKey: new PublicKey(u.wallet),
        recentBlockhash: bs58.encode(Buffer.alloc(32, 6)),
        instructions: [],
      }).compileToV0Message();
      const foreign = chain.landForeign(other);
      expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, signature: foreign }, u), "copy"))).toBe("TX_REJECTED");
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
    });

    it("an order that never lands is failed after SWEEP.maxAttempts, with an alert (and re-sent at most MAX_SENDS times)", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const o = { land: false, sends: [] as Uint8Array[] };
      const d = deps({ state, chain: dropping(o) });
      const { b, raw } = await signedOf(d, u);
      await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: raw.toString("base64") }, u), "copy");
      const alerts: string[] = [];
      const ld = later(state, { chain: dropping(o), alert: (m) => alerts.push(m) });
      for (let i = 1; i < SWEEP.maxAttempts; i++) expect(await sweepBroadcastOrders(ld)).toMatchObject({ checked: 1, pending: 1 });
      // I-03: failed at the cap only because it is provably dead (blockhash positively invalid, no trace).
      (o as { valid?: boolean }).valid = false;
      expect(await sweepBroadcastOrders(ld)).toMatchObject({ checked: 1, gaveUp: 1 });
      expect(state.orders.get(b.orderId)?.status).toBe("failed");
      expect(alerts.join("\n")).toMatch(/sweep gave up/);
      expect(await sweepBroadcastOrders(ld)).toMatchObject({ checked: 0 });
      // G-03 bound: the same signed bytes, never more than MAX_SENDS broadcasts in total.
      expect(o.sends.length).toBe(MAX_SENDS);
      for (const x of o.sends) expect(Buffer.from(x).equals(raw)).toBe(true);
    });

    it("20+ stuck older orders don't starve a newer one that landed", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const d = deps({ state });
      const { b, sig } = await signedOf(d, u);
      // Broadcast and landed, but the browser never confirmed it.
      await chain.send(Buffer.from(sign(b.transaction, u.secretKey), "base64"));
      const real = state.orders.get(b.orderId)!;
      real.broadcastSignature = sig;
      for (let i = 0; i < SWEEP.limit + 5; i++) {
        const id = randomUUID();
        const fake = Buffer.alloc(64, i + 1);
        fake[63] = 0;
        state.orders.set(id, { ...real, id, createdAt: real.createdAt - 100 - i, broadcastSignature: bs58.encode(fake) } as PendingOrder);
      }
      const ld = later(state, { chain: { ...chain, isBlockhashValid: async () => false } });
      const runs: number[] = [];
      for (let i = 0; i < 3 && state.copies.size === 0; i++) runs.push((await sweepBroadcastOrders(ld)).confirmed);
      expect(state.copies.size).toBe(1);
      expect(runs.length).toBeLessThanOrEqual(2); // the oldest-first scan would never reach it
      expect(state.orders.get(b.orderId)?.status).toBe("confirmed");
    });
  });

  describe("G-03: refused or lost broadcasts are re-sent (same bytes, bounded) or reported honestly", () => {
    it("refused then accepted: the same bytes are re-sent and the copy is recorded", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const o = { land: true, sends: [] as Uint8Array[], refuse: (n: number) => (n === 1 ? "failed to send transaction: Blockhash not found" : null) };
      const d = deps({ state, chain: dropping(o), resendDelayMs: 0 });
      const { first, raw } = await signedOf(d, u);
      expect((await confirmOrder(d, post("/c", first, u), "copy")).status).toBe("confirmed");
      expect(o.sends.length).toBe(2);
      expect(o.sends.every((x) => Buffer.from(x).equals(raw))).toBe(true);
    });

    it("refused every time while the blockhash is valid: bounded, stays pending (SEND_UNCONFIRMED, never 'Nothing was spent'), failed only once provably dead", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const o = {
        land: true,
        valid: true,
        expire: false,
        sends: [] as Uint8Array[],
        refuse: () => "Transaction simulation failed: Error processing Instruction 2",
      };
      const d = deps({ state, chain: dropping(o), resendDelayMs: 0 });
      const { b, sig, first } = await signedOf(d, u);
      const e = await confirmOrder(d, post("/c", first, u), "copy").catch((x) => x);
      expect(e).toMatchObject({ code: "SEND_UNCONFIRMED", status: 502 });
      expect(e.message).not.toMatch(/nothing was (spent|sent)/i);
      expect(e.details).toMatchObject({ signature: sig, retryable: true });
      expect(o.sends.length).toBe(MAX_SENDS);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
      // Sweep while still valid: no more sends (bounded), still pending.
      expect(await sweepBroadcastOrders(later(state, { chain: dropping(o) }))).toMatchObject({ checked: 1, failed: 0 });
      expect(o.sends.length).toBe(MAX_SENDS);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
      // isBlockhashValid positively false + no trace: now it is failed, and only now "nothing was spent".
      o.valid = false;
      o.expire = true;
      const r = await code(confirmOrder(d, post("/c", { orderId: b.orderId, signature: sig }, u), "copy"));
      expect(r).toBe("QUOTE_EXPIRED");
      expect(state.orders.get(b.orderId)?.status).toBe("failed");
      expect(o.sends.length).toBe(MAX_SENDS);
    });

    it("refused with an expired blockhash: no blind retries", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const o = { land: true, valid: false, sends: [] as Uint8Array[], refuse: () => "failed to send transaction: Blockhash not found" };
      const d = deps({ state, chain: dropping(o), resendDelayMs: 0 });
      const { first } = await signedOf(d, u);
      expect(await code(confirmOrder(d, post("/c", first, u), "copy"))).toBe("TX_REJECTED");
      expect(o.sends.length).toBe(1);
    });

    it("an ambiguous send error (response lost) doesn't fail the order: it is verified and recorded", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const d = deps({
        state,
        chain: {
          ...chain,
          send: async (raw: Uint8Array) => {
            await chain.send(raw);
            throw new TypeError("fetch failed");
          },
        },
      });
      const { first } = await signedOf(d, u);
      expect((await confirmOrder(d, post("/c", first, u), "copy")).status).toBe("confirmed");
      expect(state.copies.size).toBe(1);
    });

    it("a lost broadcast is re-sent on the next lookup while the blockhash is valid, and then lands", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const o = { land: false, valid: true, sends: [] as Uint8Array[] };
      const d = deps({ state, chain: dropping(o) });
      const { b, sig, first, raw } = await signedOf(d, u);
      expect((await confirmOrder(d, post("/c", first, u), "copy")).status).toBe("pending");
      // Expired blockhash: a lookup never re-sends.
      o.valid = false;
      expect((await confirmOrder(d, post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).status).toBe("pending");
      expect(o.sends.length).toBe(1);
      o.valid = true;
      o.land = true;
      expect((await confirmOrder(d, post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).status).toBe("confirmed");
      expect(o.sends.length).toBe(2);
      expect(Buffer.from(o.sends[1]).equals(raw)).toBe(true);
      expect(state.copies.size).toBe(1);
    });
  });

  describe("G-07: non-canonical signatures (S >= L) are refused before verifying or storing", () => {
    const malleate = (sig: Uint8Array): Uint8Array => {
      let s = 0n;
      for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]);
      s += ED25519_L;
      const out = Uint8Array.from(sig);
      for (let i = 32; i < 64; i++) {
        out[i] = Number(s & 255n);
        s >>= 8n;
      }
      return out;
    };

    it("S + L passes tweetnacl (the attack), but confirm refuses it and notes nothing", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const sends: Uint8Array[] = [];
      const d = deps({ state, chain: { ...chain, send: async (r: Uint8Array) => (sends.push(r), chain.send(r)) } });
      const { b } = await quoteAndBuild(d, u);
      const tx = VersionedTransaction.deserialize(Buffer.from(sign(b.transaction, u.secretKey), "base64"));
      const bad = malleate(tx.signatures[0]);
      expect(nacl.sign.detached.verify(tx.message.serialize(), bad, bs58.decode(u.wallet))).toBe(true);
      tx.signatures[0] = bad;
      const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
      expect(await code(confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction }, u), "copy"))).toBe("TX_REJECTED");
      expect(state.orders.get(b.orderId)?.broadcastSignature).toBeNull();
      expect(sends.length).toBe(0);
      expect(
        await code(confirmOrder(d, post("/c", { orderId: b.orderId, signature: bs58.encode(bad) }, u), "copy")),
      ).toBe("TX_REJECTED");
    });
  });
});

describe("G-05: in real mode a claim build fails closed without an on-chain position reader", () => {
  const winFor = async (u: User) =>
    (await myPositions(deps(), get("/p", u))).positions.find((p) => p.status === "claimable")!;
  const chain = getSharedMockChain();
  const { getPositionSharesBase: _drop, ...noReader } = chain;
  void _drop;

  for (const [name, c] of [
    ["no reader at all (the real adapter today)", noReader],
    ["a reader that can't answer (null)", { ...chain, getPositionSharesBase: async () => null }],
    ["a reader that errors", { ...chain, getPositionSharesBase: async () => Promise.reject(new Error("rpc")) }],
  ] as const) {
    it(`${name}: 503 CLAIM_UNVERIFIED, nothing stored, even when Panta's numbers agree`, async () => {
      const u = await signedInUser();
      const win = await winFor(u);
      const state = createCopyMemoryState();
      const logs: string[] = [];
      const d = deps({ state, chain: c, mock: false, log: (m: string) => logs.push(m) });
      let err: unknown;
      try {
        await buildClaimTx(d, post("/cb", { marketId: win.marketId }, u));
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: "CLAIM_UNVERIFIED", status: 503 });
      expect((err as Error).message).toMatch(/claim directly on Panta/);
      expect(state.orders.size).toBe(0);
      expect(logs.join("\n")).toContain("CLAIM_UNVERIFIED");
    });
  }

  it("mock mode keeps working with the mock reader, and the real-mode reader path still checks the amount", async () => {
    const u = await signedInUser();
    const win = await winFor(u);
    expect((await buildClaimTx(deps(), post("/cb", { marketId: win.marketId }, u))).orderId).toBeTruthy();
    const lying = { ...chain, getPositionSharesBase: async () => 1n };
    expect(await code(buildClaimTx(deps({ chain: lying, mock: false }), post("/cb", { marketId: win.marketId }, u)))).toBe(
      "TX_REJECTED",
    );
  });
});

describe("H-03: a 5xx before broadcast is resolved, never left polling a transaction nobody sent", () => {
  const chain = getSharedMockChain();
  const wire = (d: FlowDeps, u: User) => {
    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      try {
        return Response.json(await confirmOrder(d, post("/api/copy/confirm", body, u), "copy"));
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        return authErrorResponse(e);
      }
    }) as typeof fetch;
    const postFn = (body: unknown) => api<ConfirmStep>("POST", "/api/copy/confirm", body).then((x) => x.data);
    return { postFn, bodies, restore: () => (globalThis.fetch = realFetch) };
  };
  /** A store whose noteBroadcast answers 503 the first `n` times (the server fails before sending). */
  const flaky = (state: CopyMemoryState, n: number) => {
    const store = createMemoryCopyStore(state);
    let left = n;
    return {
      ...store,
      noteBroadcast: async (...a: Parameters<typeof store.noteBroadcast>) => {
        if (left-- > 0) throw new AuthError(503, "DB_UNAVAILABLE", "db down");
        return store.noteBroadcast(...a);
      },
    };
  };
  const signed = async (d: FlowDeps, u: User) => {
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64")).signatures[0]);
    return { b, sig, first: { orderId: b.orderId, signedTransaction } };
  };

  it("the auditor's PoF: one 5xx before broadcast -> the client re-posts the signed bytes, it's sent once and recorded", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const sends: Uint8Array[] = [];
    const d = deps({ state, copy: flaky(state, 1), chain: { ...chain, send: async (r: Uint8Array) => (sends.push(r), chain.send(r)) } });
    const { b, sig, first } = await signed(d, u);
    const w = wire(d, u);
    try {
      const r = await pollConfirm(w.postFn, b.orderId, first, async () => {}, sig);
      expect(r).toMatchObject({ status: "confirmed", signature: sig });
      expect(w.bodies).toEqual([first, first]);
      expect(sends.length).toBe(1);
      expect(state.copies.size).toBe(1);
    } finally {
      w.restore();
    }
  });

  it("5xx twice: one re-post, then NOT_BROADCAST ends it at once (no 31 polls, no rate limit); not failed, so never 'Nothing was spent' (J-02)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state, copy: flaky(state, 2) });
    const { b, sig, first } = await signed(d, u);
    const w = wire(d, u);
    try {
      await expect(pollConfirm(w.postFn, b.orderId, first, async () => {}, sig)).rejects.toMatchObject({
        code: "NOT_BROADCAST",
        message: expect.stringMatching(/couldn't confirm your transaction was sent\. Check your wallet/),
      });
      expect(w.bodies.length).toBe(3);
      expect(w.bodies[2]).toEqual({ orderId: b.orderId, signature: sig });
      // Its blockhash may still be valid, so the order isn't failed on a guess.
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
    } finally {
      w.restore();
    }
  });

  it("server: a never-broadcast order is failed only once its tx can no longer land", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b, sig } = await signed(d, u);
    const bySig = (dd: FlowDeps) => confirmOrder(dd, post("/c", { orderId: b.orderId, signature: sig }, u), "copy");
    // Still valid: NOT_BROADCAST with resend while the quote is open, without resend after it.
    let err: unknown;
    try {
      await bySig(d);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "NOT_BROADCAST", details: { resend: true } });
    const late = deps({ state, nowMs: () => Date.now() + 5 * 60_000 });
    try {
      await bySig(late);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "NOT_BROADCAST", details: { resend: false } });
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    // An RPC error is never taken as "expired".
    const broken = deps({ state, chain: { ...chain, waitForConfirmation: async () => Promise.reject(new Error("rpc")) } });
    expect(await code(bySig(broken))).toBe("NOT_BROADCAST");
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    // I-01: past the height but isBlockhashValid still true (or erroring) is not proof: pending.
    const hint = deps({ state, chain: { ...chain, waitForConfirmation: async () => "expired" as const } });
    expect(await code(bySig(hint))).toBe("NOT_BROADCAST");
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    const bhErr = deps({ state, chain: { ...chain, isBlockhashValid: async () => Promise.reject(new Error("429")) } });
    expect(await code(bySig(bhErr))).toBe("NOT_BROADCAST");
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    // isBlockhashValid positively false and no trace on chain: failed, "nothing was spent".
    const expired = deps({ state, chain: { ...chain, isBlockhashValid: async () => false } });
    expect(await code(bySig(expired))).toBe("NOT_BROADCAST");
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
    expect(state.copies.size).toBe(0);
  });

  it("server: signed bytes re-posted after the quote: not sent; failed once expired; recorded if it landed elsewhere", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const sends: Uint8Array[] = [];
    const d = deps({ state, chain: { ...chain, send: async (r: Uint8Array) => (sends.push(r), chain.send(r)) } });
    const { b, first } = await signed(d, u);
    const late = (c: FlowDeps["chain"]) => deps({ state, chain: c, nowMs: () => Date.now() + 5 * 60_000 });
    expect(await code(confirmOrder(late(d.chain), post("/c", first, u), "copy"))).toBe("QUOTE_EXPIRED");
    expect(sends.length).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    // The same bytes broadcast some other way and landed: verified and recorded, not failed.
    await chain.send(Buffer.from(first.signedTransaction, "base64"));
    expect((await confirmOrder(late(d.chain), post("/c", first, u), "copy")).status).toBe("confirmed");
    expect(state.copies.size).toBe(1);

    const { b: b2, first: first2 } = await signed(deps({ state }), u);
    const exp = late({ ...chain, isBlockhashValid: async () => false });
    expect(await code(confirmOrder(exp, post("/c", first2, u), "copy"))).toBe("QUOTE_EXPIRED");
    expect(state.orders.get(b2.orderId)?.status).toBe("failed");
  });

  it("the sweep fails never-broadcast orders only after every confirm window is over", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b } = await quoteAndBuild(d, u);
    const dead = { ...chain, isBlockhashValid: async () => false };
    const at = (min: number, c: FlowDeps["chain"] = dead) => deps({ state, chain: c, nowMs: () => Date.now() + min * 60_000 });
    expect((await sweepBroadcastOrders(at(15))).abandoned).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    // The one rule: past the window but isBlockhashValid not positively false (true, or an error): kept.
    expect((await sweepBroadcastOrders(at(17, chain))).abandoned).toBe(0);
    expect((await sweepBroadcastOrders(at(17, { ...chain, isBlockhashValid: () => Promise.reject(new Error("rpc")) }))).abandoned).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    expect((await sweepBroadcastOrders(at(17))).abandoned).toBe(1);
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
    // A broadcast order is left to the normal sweep.
    const { b: b2 } = await quoteAndBuild(d, u);
    state.orders.get(b2.orderId)!.broadcastSignature = bs58.encode(Buffer.alloc(64, 1));
    await sweepBroadcastOrders(at(17));
    expect(state.orders.get(b2.orderId)?.status).toBe("pending");
  });
});

describe("Addendum I/J: an order is failed only when provably dead (no trace AND isBlockhashValid === false)", () => {
  const chain = getSharedMockChain();
  const wire = (d: FlowDeps, u: User) => {
    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      try {
        return Response.json(await confirmOrder(d, post("/api/copy/confirm", body, u), "copy"));
      } catch (e) {
        if (!(e instanceof AuthError)) throw e;
        return authErrorResponse(e);
      }
    }) as typeof fetch;
    const postFn = (body: unknown) => api<ConfirmStep>("POST", "/api/copy/confirm", body).then((x) => x.data);
    return { postFn, bodies, restore: () => (globalThis.fetch = realFetch) };
  };
  const signed = async (d: FlowDeps, u: User) => {
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64")).signatures[0]);
    return { b, sig, first: { orderId: b.orderId, signedTransaction } };
  };

  /** I-04 / J-01: a second VALID signature over the same message (random nonce, canonical S). */
  const secondSignature = (msg: Uint8Array, secretKey: Uint8Array): Uint8Array => {
    const e = ed25519.utils.getExtendedPublicKey(secretKey.slice(0, 32));
    const L = ed25519.Point.Fn.ORDER;
    const le = (b: Uint8Array) => b.reduceRight((x, v) => (x << 8n) | BigInt(v), 0n);
    const r = le(randomBytes(64)) % L;
    const R = ed25519.Point.BASE.multiply(r).toBytes();
    const k = le(createHash("sha512").update(Buffer.concat([R, e.pointBytes, msg])).digest()) % L;
    let S = (r + k * e.scalar) % L;
    const out = new Uint8Array(64);
    out.set(R);
    for (let i = 32; i < 64; i++) {
      out[i] = Number(S & 255n);
      S >>= 8n;
    }
    return out;
  };
  const withSig = (signedTransaction: string, sig: Uint8Array) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64"));
    tx.signatures[0] = sig;
    return Buffer.from(tx.serialize()).toString("base64");
  };
  /** A send that is accepted but doesn't land (yet). */
  const quiet = (sends: Uint8Array[]) => ({
    ...chain,
    send: async (raw: Uint8Array) => (sends.push(raw), bs58.encode(VersionedTransaction.deserialize(raw).signatures[0])),
  });

  describe("I-04 / J-01: a signature that isn't the broadcast one never fails the order or gets broadcast", () => {
    it("the auditor's PoF: sig1 broadcast and landed, a 2nd valid signature after expiry -> the stored one is looked up and recorded", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const sends: Uint8Array[] = [];
      const d = deps({ state, chain: quiet(sends) });
      const { b, sig, first } = await signed(d, u);
      expect((await confirmOrder(d, post("/c", first, u), "copy")).status).toBe("pending");
      await chain.send(sends[0]); // sig1 lands (relayed)
      const msg = VersionedTransaction.deserialize(Buffer.from(first.signedTransaction, "base64")).message.serialize();
      const sig2 = secondSignature(msg, u.secretKey);
      expect(nacl.sign.detached.verify(msg, sig2, bs58.decode(u.wallet))).toBe(true);
      expect(bs58.encode(sig2)).not.toBe(sig);
      const late = deps({ state, chain: { ...quiet(sends), isBlockhashValid: async () => false }, nowMs: () => Date.now() + 5 * 60_000 });
      const r = await confirmOrder(late, post("/c", { orderId: b.orderId, signedTransaction: withSig(first.signedTransaction, sig2) }, u), "copy");
      expect(r).toMatchObject({ status: "confirmed", signature: sig });
      expect(sends.length).toBe(1);
    });

    it("before expiry, a 2nd valid signature's bytes are never broadcast (no different bytes), the order stays pending", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const sends: Uint8Array[] = [];
      const d = deps({ state, chain: quiet(sends) });
      const { b, sig, first } = await signed(d, u);
      await confirmOrder(d, post("/c", first, u), "copy");
      const msg = VersionedTransaction.deserialize(Buffer.from(first.signedTransaction, "base64")).message.serialize();
      const other = withSig(first.signedTransaction, secondSignature(msg, u.secretKey));
      const r = await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction: other }, u), "copy");
      expect(r).toMatchObject({ status: "pending", signature: sig });
      // Every send is the original signed bytes (the lookup may re-send THOSE, bounded).
      expect(sends.every((x) => Buffer.from(x).equals(Buffer.from(first.signedTransaction, "base64")))).toBe(true);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
    });

    it("a random signature on a never-broadcast order can't fail it, even with the blockhash provably expired", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const { b } = await signed(deps({ state }), u);
      const dead = deps({ state, chain: { ...chain, isBlockhashValid: async () => false } });
      const junk = bs58.encode(Buffer.alloc(64, 3));
      expect(await code(confirmOrder(dead, post("/c", { orderId: b.orderId, signature: junk }, u), "copy"))).toBe("TX_REJECTED");
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
    });
  });

  describe("J-02: 'Nothing was spent' only once the order is failed (fenced), and noteBroadcast gates the send", () => {
    /** Request A stalls in signatureUsed (after reading the order, before noteBroadcast). */
    const stalling = (state: CopyMemoryState) => {
      const store = createMemoryCopyStore(state);
      let release!: () => void;
      let enter!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const entered = new Promise<void>((r) => (enter = r));
      let first = true;
      return {
        release: () => release(),
        entered,
        copy: {
          ...store,
          signatureUsed: async (sig: string) => {
            if (first) {
              first = false;
              enter();
              await gate;
            }
            return store.signatureUsed(sig);
          },
        },
      };
    };

    it("the auditor's PoF: while A is stalled, a poll gets NOT_BROADCAST without 'nothing was spent'; A then sends once and records", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const st = stalling(state);
      const sends: Uint8Array[] = [];
      const d = deps({ state, copy: st.copy, chain: { ...chain, send: async (r: Uint8Array) => (sends.push(r), chain.send(r)) } });
      const { b, sig, first } = await signed(d, u);
      const a = confirmOrder(d, post("/c", first, u), "copy");
      const late = deps({ state, nowMs: () => Date.now() + 5 * 60_000 });
      const e = await confirmOrder(late, post("/c", { orderId: b.orderId, signature: sig }, u), "copy").catch((x) => x);
      expect(e).toMatchObject({ code: "NOT_BROADCAST" });
      expect(e.message).not.toMatch(/nothing was (spent|sent)/i);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
      st.release();
      expect((await a).status).toBe("confirmed");
      expect(sends.length).toBe(1);
      expect(state.copies.size).toBe(1);
    });

    it("once provably dead the order is failed BEFORE 'nothing was spent', and the stalled request is fenced: 0 sends", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const st = stalling(state);
      const sends: Uint8Array[] = [];
      const d = deps({ state, copy: st.copy, chain: { ...chain, send: async (r: Uint8Array) => (sends.push(r), chain.send(r)) } });
      const { b, sig, first } = await signed(d, u);
      const a = confirmOrder(d, post("/c", first, u), "copy");
      const dead = deps({ state, chain: { ...chain, isBlockhashValid: async () => false } });
      const e = await confirmOrder(dead, post("/c", { orderId: b.orderId, signature: sig }, u), "copy").catch((x) => x);
      expect(e).toMatchObject({ code: "NOT_BROADCAST", message: expect.stringMatching(/nothing was spent/) });
      expect(state.orders.get(b.orderId)?.status).toBe("failed");
      st.release();
      expect(await code(a)).toBe("ORDER_NOT_PENDING");
      expect(sends.length).toBe(0);
      expect(state.orders.get(b.orderId)?.broadcastSignature).toBeNull();
    });

    it("a stalled request that resumes after the quote expired never starts a send", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const st = stalling(state);
      const sends: Uint8Array[] = [];
      let skew = 0;
      const d = deps({
        state,
        copy: st.copy,
        nowMs: () => Date.now() + skew,
        chain: { ...chain, send: async (r: Uint8Array) => (sends.push(r), chain.send(r)) },
      });
      const { first } = await signed(d, u);
      const a = confirmOrder(d, post("/c", first, u), "copy");
      await st.entered; // A passed the first expiry check and is stalled before noteBroadcast
      skew = 5 * 60_000;
      st.release();
      const e = await a.catch((x) => x);
      expect(e).toMatchObject({ code: "QUOTE_EXPIRED" });
      expect(e.message).not.toMatch(/nothing was (spent|sent)/i);
      expect(sends.length).toBe(0);
    });

    it("noteBroadcast reports whether this signature is the stored one on a pending order", async () => {
      const state = createCopyMemoryState();
      const store = createMemoryCopyStore(state);
      const u = await signedInUser();
      const { b } = await signed(deps({ state }), u);
      expect(await store.noteBroadcast(b.orderId, "S1")).toBe(true);
      expect(await store.noteBroadcast(b.orderId, "S1")).toBe(true);
      expect(await store.noteBroadcast(b.orderId, "S2")).toBe(false);
      await store.failOrder(b.orderId);
      expect(await store.noteBroadcast(b.orderId, "S1")).toBe(false);
      expect(await store.noteBroadcast("nope", "S1")).toBe(false);
    });
  });

  describe("I-01: send errors are classified by the JSON-RPC code, never by web3.js's 'Simulation failed'", () => {
    const classify = async (error: unknown) => {
      const { classifySendRpcError } = await import("@/lib/solana");
      try {
        classifySendRpcError(error);
      } catch (e) {
        return e as SendError;
      }
      throw new Error("did not throw");
    };

    it("only -32002 with a TransactionError and -32003 are refusals; everything else is unclear", async () => {
      expect((await classify({ code: -32002, message: "Transaction simulation failed: Blockhash not found", data: { err: "BlockhashNotFound" } })).kind).toBe("refused");
      expect((await classify({ code: -32002, message: "x", data: { err: { InstructionError: [2, { Custom: 6001 }] } } })).kind).toBe("refused");
      expect((await classify({ code: -32003, message: "Transaction signature verification failure" })).kind).toBe("refused");
      for (const e of [
        { code: -32005, message: "Node is behind by 42 slots" },
        { code: -32603, message: "Internal error: upstream request timed out" },
        { code: -32429, message: "rate limit exceeded" },
        { code: -32002, message: "Transaction simulation failed", data: {} }, // no TransactionError
        { code: -32002, message: "already processed", data: { err: "AlreadyProcessed" } },
        { code: -32099, message: "unknown" },
        { message: "no code" },
        null,
      ]) {
        const r = await classify(e);
        expect(r).toBeInstanceOf(SendError);
        expect(r.kind).toBe("unclear");
      }
    });

    it("the real send (plain JSON-RPC over fetch): HTTP 429, a network error and -32005 are unclear; the RPC URL never appears", async () => {
      const prev = process.env.SOLANA_RPC_URL;
      const url = "https://rpc.example/?api-key=" + "k".repeat(24);
      process.env.SOLANA_RPC_URL = url;
      const { sendRawClassified } = await import("@/lib/solana");
      const realFetch = globalThis.fetch;
      const seen: unknown[] = [];
      try {
        for (const [respond, kind] of [
          [() => new Response("slow down", { status: 429 }), "unclear"],
          [() => Promise.reject(new TypeError("fetch failed")), "unclear"],
          [() => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Node is behind" } }), "unclear"],
          [() => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "sim", data: { err: "BlockhashNotFound" } } }), "refused"],
        ] as const) {
          globalThis.fetch = (async (_u: string, init: RequestInit) => {
            seen.push(JSON.parse(String(init.body)));
            return respond();
          }) as typeof fetch;
          const e = (await sendRawClassified(new Uint8Array([1, 2, 3])).catch((x) => x)) as SendError;
          expect(e).toBeInstanceOf(SendError);
          expect(e.kind).toBe(kind);
          expect(e.message).not.toContain("rpc.example");
          expect(e.message).not.toContain("k".repeat(24));
        }
        globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: 1, result: "SIG" })) as typeof fetch;
        expect(await sendRawClassified(new Uint8Array([1]))).toBe("SIG");
        // Same send params as before: preflight on at `confirmed`, maxRetries 3.
        expect(seen[0]).toMatchObject({ method: "sendTransaction", params: [expect.any(String), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }] });
      } finally {
        globalThis.fetch = realFetch;
        if (prev === undefined) delete process.env.SOLANA_RPC_URL;
        else process.env.SOLANA_RPC_URL = prev;
      }
    });

    it("the auditor's PoF: a relayed send answered with an RPC error, plus an isBlockhashValid error -> not failed, recorded when it lands", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      let bhCalls = 0;
      const d = deps({
        state,
        resendDelayMs: 0,
        chain: {
          ...chain,
          // Even if a proxy's answer were (wrongly) a refusal after relaying it:
          send: async (raw: Uint8Array) => {
            await chain.send(raw).catch(() => undefined);
            throw new SendError("refused", -32002, "preflight: BlockhashNotFound");
          },
          waitForConfirmation: async () => "pending" as const,
          isBlockhashValid: async () => (bhCalls++, Promise.reject(new Error("fetch failed"))),
        },
      });
      const { b, sig, first } = await signed(d, u);
      const e = await confirmOrder(d, post("/c", first, u), "copy").catch((x) => x);
      expect(e).toMatchObject({ code: "SEND_UNCONFIRMED", details: { signature: sig, retryable: true } });
      expect(e.message).not.toMatch(/nothing was (spent|sent)/i);
      expect(bhCalls).toBeGreaterThan(0);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
      // The tx is on chain: the next lookup (client poll or sweep) records it.
      const r = await confirmOrder(deps({ state }), post("/c", { orderId: b.orderId, signature: sig }, u), "copy");
      expect(r.status).toBe("confirmed");
      expect(state.copies.size).toBe(1);
    });

    it("an unclear send error (-32005 node behind) is never retried blind or failed: it goes to verification", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const sends: Uint8Array[] = [];
      const d = deps({
        state,
        chain: {
          ...chain,
          send: async (raw: Uint8Array) => {
            sends.push(raw);
            throw new SendError("unclear", -32005, "rpc -32005: Node is behind");
          },
          isBlockhashValid: async () => false,
        },
      });
      const { b, first } = await signed(d, u);
      expect((await confirmOrder(d, post("/c", first, u), "copy")).status).toBe("pending");
      expect(sends.length).toBe(1);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
    });

    it("the shipped client keeps checking by signature after SEND_UNCONFIRMED, and records it when it lands", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      let refusals = 0;
      const d = deps({
        state,
        resendDelayMs: 0,
        chain: {
          ...chain,
          send: async (raw: Uint8Array) => {
            if (refusals++ < MAX_SENDS) throw new SendError("refused", -32002, "preflight: BlockhashNotFound");
            return chain.send(raw);
          },
        },
      });
      const { b, sig, first } = await signed(d, u);
      const w = wire(d, u);
      try {
        // The first post is refused MAX_SENDS times; the order stays pending, the client polls by
        // signature. Land it out of band (as a relay would), and the poll records it.
        let polls = 0;
        const r = await pollConfirm(
          w.postFn,
          b.orderId,
          first,
          async () => {
            if (++polls === 2) await chain.send(Buffer.from(first.signedTransaction, "base64"));
          },
          sig,
        );
        expect(r).toMatchObject({ status: "confirmed", signature: sig });
        expect(w.bodies[1]).toEqual({ orderId: b.orderId, signature: sig });
        expect(state.copies.size).toBe(1);
      } finally {
        w.restore();
      }
    });
  });

  describe("I-02 / I-03 / I-05 / J-06: the sweep never strands, never fails a landed copy on a guess, and isolates the abandon step", () => {
    const at = (state: CopyMemoryState, over: Partial<FlowDeps> = {}) =>
      deps({ state, nowMs: () => Date.now() + 2 * 60_000, ...over });
    /** A broadcast, unrecorded order (sent quietly: not on the mock chain unless `land`). */
    const broadcastOrder = async (state: CopyMemoryState, u: User, land = false) => {
      const sends: Uint8Array[] = [];
      const { b, sig, first } = await signed(deps({ state, chain: quiet(sends) }), u);
      await confirmOrder(deps({ state, chain: quiet(sends) }), post("/c", first, u), "copy");
      if (land) await chain.send(sends[0]);
      return { b, sig };
    };
    const withBudget = async <T,>(ms: number, f: () => Promise<T>) => {
      const prev = SWEEP.budgetMs;
      SWEEP.budgetMs = ms;
      try {
        return await f();
      } finally {
        SWEEP.budgetMs = prev;
      }
    };

    it("I-02: an order the run can't reach (budget) isn't claimed: no lost attempt, and it goes first next run", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const one = await broadcastOrder(state, u);
      const two = await broadcastOrder(state, u);
      const slow = { ...chain, waitForConfirmation: async () => (await new Promise((r) => setTimeout(r, 80)), "pending" as const) };
      const r = await withBudget(50, () => sweepBroadcastOrders(at(state, { chain: slow })));
      expect(r).toMatchObject({ checked: 1, skipped: 1 });
      expect(state.sweep.get(one.b.orderId)?.attempts).toBe(1);
      expect(state.sweep.get(two.b.orderId)).toBeUndefined(); // never claimed, so no attempt burned
      const seen: string[] = [];
      const store = createMemoryCopyStore(state);
      await sweepBroadcastOrders(
        at(state, {
          copy: {
            ...store,
            claimNextBroadcastSweep: async (p: Parameters<typeof store.claimNextBroadcastSweep>[0]) => {
              const x = await store.claimNextBroadcastSweep(p);
              if (x) seen.push(x.order.id);
              return x;
            },
          },
        }),
      );
      expect(seen).toEqual([two.b.orderId, one.b.orderId]);
    });

    it("I-05: a hung RPC read can't hold the run past its budget", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      await broadcastOrder(state, u);
      const hung = { ...chain, getLandedTransaction: () => new Promise<null>(() => {}) };
      const t0 = Date.now();
      const r = await withBudget(60, () => sweepBroadcastOrders(at(state, { chain: hung })));
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(r).toMatchObject({ checked: 1, skipped: 1, errors: 1 });
    });

    it("I-02: the 30th attempt throwing an unexpected error doesn't strand the order silently (alert; failed only if provably dead)", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const { b } = await broadcastOrder(state, u);
      const alerts: string[] = [];
      const ok = at(state, { chain: quiet([]) }); // never lands
      for (let i = 1; i < SWEEP.maxAttempts; i++) expect(await sweepBroadcastOrders(ok)).toMatchObject({ pending: 1 });
      const boom = at(state, {
        alert: (m) => alerts.push(m),
        chain: { ...chain, waitForConfirmation: () => Promise.reject(new Error("socket hang up")) },
      });
      expect(await sweepBroadcastOrders(boom)).toMatchObject({ checked: 1, errors: 1, exhausted: 1, failed: 0 });
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
      expect(alerts.join("\n")).toMatch(/NOT failed: it may have landed/);
      expect(await sweepBroadcastOrders(ok)).toMatchObject({ checked: 0 });
    });

    it("I-02: ... and with the blockhash positively invalid and no trace, the 30th erroring attempt fails it", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const { b } = await broadcastOrder(state, u);
      for (let i = 1; i < SWEEP.maxAttempts; i++) await sweepBroadcastOrders(at(state, { chain: quiet([]) }));
      const boom = at(state, {
        chain: { ...chain, isBlockhashValid: async () => false, waitForConfirmation: () => Promise.reject(new Error("x")) },
      });
      expect(await sweepBroadcastOrders(boom)).toMatchObject({ checked: 1, errors: 1, gaveUp: 1 });
      expect(state.orders.get(b.orderId)?.status).toBe("failed");
    });

    for (const [name, over] of [
      ["status confirmed but getTransaction null", { chain: { ...chain, waitForConfirmation: async () => "confirmed" as const, getLandedTransaction: async () => null } }],
      ["MAX_STAKE_USDC unset (VERIFY_UNAVAILABLE)", { maxStakeCapBase: null }],
    ] as const) {
      it(`I-03: a landed copy that is unverifiable for 30 runs (${name}) is never failed: alert, kept pending, recorded later`, async () => {
        const u = await signedInUser();
        const state = createCopyMemoryState();
        const { b, sig } = await broadcastOrder(state, u, true);
        const alerts: string[] = [];
        const d = at(state, { ...over, alert: (m) => alerts.push(m) } as Partial<FlowDeps>);
        for (let i = 1; i < SWEEP.maxAttempts; i++) await sweepBroadcastOrders(d);
        const r = await sweepBroadcastOrders(d);
        expect(r).toMatchObject({ checked: 1, gaveUp: 0, exhausted: 1 });
        expect(state.orders.get(b.orderId)?.status).toBe("pending");
        expect(alerts.join("\n")).toMatch(/NOT failed/);
        expect(alerts.join("\n")).not.toMatch(/never landed/);
        // Revivable by signature: once verifiable, confirm records it.
        expect((await confirmOrder(deps({ state }), post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).status).toBe("confirmed");
      });
    }

    it("J-06: a failing abandon step can't abort the sweep; the broadcast orders are still checked and recorded", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const { b } = await broadcastOrder(state, u, true);
      const store = createMemoryCopyStore(state);
      const alerts: string[] = [];
      const r = await sweepBroadcastOrders(
        at(state, {
          alert: (m) => alerts.push(m),
          copy: { ...store, listUnbroadcastBefore: () => Promise.reject(new AuthError(500, "DB", "violates check constraint")) },
        }),
      );
      expect(r).toMatchObject({ checked: 1, confirmed: 1, abandoned: 0 });
      expect(state.orders.get(b.orderId)?.status).toBe("confirmed");
      expect(alerts.join("\n")).toMatch(/abandon step skipped/);
    });

    it("J-06: one never-broadcast row that can't be failed (e.g. a NOT VALID ceiling row) doesn't stop the others", async () => {
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const { b: bad } = await quoteAndBuild(deps({ state }), u);
      const { b: good } = await quoteAndBuild(deps({ state }), u);
      const store = createMemoryCopyStore(state);
      const alerts: string[] = [];
      const r = await sweepBroadcastOrders(
        deps({
          state,
          nowMs: () => Date.now() + 17 * 60_000,
          alert: (m) => alerts.push(m),
          chain: { ...chain, isBlockhashValid: async () => false },
          copy: {
            ...store,
            failIfUnbroadcast: async (id: string) =>
              id === bad.orderId ? Promise.reject(new AuthError(500, "DB", "ceiling")) : store.failIfUnbroadcast(id),
          },
        }),
      );
      expect(r.abandoned).toBe(1);
      expect(state.orders.get(good.orderId)?.status).toBe("failed");
      expect(state.orders.get(bad.orderId)?.status).toBe("pending");
      expect(alerts.join("\n")).toMatch(/couldn't be failed/);
    });
  });
});

describe("J-07: the real adapter reads the payer's post-tx lamports from meta.postBalances[0]", () => {
  it("present -> the number; missing -> null (unknown, retryable)", async () => {
    process.env.SOLANA_RPC_URL ??= "https://rpc.example/";
    const { Connection } = await import("@solana/web3.js");
    const { rpcChain } = await import("@/lib/solana");
    const payer = Keypair.generate().publicKey;
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: bs58.encode(Buffer.alloc(32, 9)), instructions: [] }).compileToV0Message();
    const tx = (meta: Record<string, unknown>) => ({ transaction: { message, signatures: ["s"] }, meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [], ...meta } });
    const spy = vi.spyOn(Connection.prototype, "getTransaction");
    try {
      spy.mockResolvedValueOnce(tx({ postBalances: [123, 0] }) as never);
      expect((await rpcChain.getLandedTransaction("s"))?.payerPostLamports).toBe(123);
      spy.mockResolvedValueOnce(tx({}) as never);
      expect((await rpcChain.getLandedTransaction("s"))?.payerPostLamports).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("I-01: a revive of a failed order says 'nothing was spent' only with the same proof", () => {
  it("expired height hint but blockhash still valid -> pending, not QUOTE_EXPIRED; provably dead -> QUOTE_EXPIRED", async () => {
    const chain = getSharedMockChain();
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const quiet = { ...chain, send: async (raw: Uint8Array) => bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]) };
    const d = deps({ state, chain: quiet });
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64")).signatures[0]);
    await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction }, u), "copy");
    await createMemoryCopyStore(state).failOrder(b.orderId); // e.g. failed by an older build on a guess
    const hint = deps({ state, chain: { ...quiet, waitForConfirmation: async () => "expired" as const } });
    expect((await confirmOrder(hint, post("/c", { orderId: b.orderId, signature: sig }, u), "copy")).status).toBe("pending");
    const dead = deps({ state, chain: { ...quiet, waitForConfirmation: async () => "expired" as const, isBlockhashValid: async () => false } });
    expect(await code(confirmOrder(dead, post("/c", { orderId: b.orderId, signature: sig }, u), "copy"))).toBe("QUOTE_EXPIRED");
  });
});

describe("H-04: F-02 is re-checked at confirm (landed token instructions; current USDC account alert-only)", () => {
  const chain = getSharedMockChain();
  const TOKEN = TOKEN_PROGRAM_ID;
  const TOKEN22 = TOKEN_2022_PROGRAM_ID;
  const withLanded = (over: (t: LandedTx, ata: string) => Partial<LandedTx>, extra: Partial<FlowDeps["chain"]> = {}) => ({
    ...chain,
    getLandedTransaction: async (sig: string) => {
      const t = await chain.getLandedTransaction(sig);
      return t && { ...t, ...over(t, associatedTokenAddress(t.message.staticAccountKeys[0].toBase58())) };
    },
    ...extra,
  });
  const confirmWith = async (c: FlowDeps["chain"], afterBuild?: () => void) => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const alerts: string[] = [];
    const d = deps({ state, chain: c, alert: (m: string) => alerts.push(m) });
    const { b } = await quoteAndBuild(d, u);
    afterBuild?.();
    const req = () => post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
    return { res: await code(confirmOrder(d, req(), "copy")), again: () => code(confirmOrder(d, req(), "copy")), state, b, alerts, u };
  };

  for (const type of ["approve", "approveChecked", "setAuthority", "closeAccount"]) {
    it(`H4-01: a landed ${type} on the user's USDC account (the slot/clock-branching attack) is RECORDED, flagged for review, alerted once, and the user is told to revoke`, async () => {
      const r = await confirmWith(withLanded((_t, ata) => ({ tokenAuthorityOps: [{ type, target: ata }] })));
      expect(r.res).toBe("OK");
      expect(r.state.copies.size).toBe(1);
      expect(r.state.orders.get(r.b.orderId)?.status).toBe("confirmed");
      expect(r.state.orders.get(r.b.orderId)?.reviewFlag).toBe("USDC_AUTHORITY");
      expect(r.alerts.filter((m) => /USDC_AUTHORITY/.test(m)).length).toBe(1);
      expect(r.alerts.join("\n")).toMatch(/recorded and flagged for review/);
      // Re-confirming is idempotent: one record, no second alert, same warning.
      expect(await r.again()).toBe("OK");
      expect(r.state.copies.size).toBe(1);
      expect(r.alerts.filter((m) => /USDC_AUTHORITY/.test(m)).length).toBe(1);
    });
  }

  it("H4-01 PoF: the auditor's two-payments case is gone: one landed copy, one record (flagged), the confirm says revoke, never 'Transaction rejected / Start again / Nothing was spent'", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const alerts: string[] = [];
    const c = withLanded((_t, ata) => ({ tokenAuthorityOps: [{ type: "approve", target: ata }] }));
    const d = deps({ state, chain: c, alert: (m: string) => alerts.push(m) });
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64")).signatures[0]);
    const r = await confirmOrder(d, post("/c", { orderId: b.orderId, signedTransaction }, u), "copy");
    expect(r).toMatchObject({ status: "confirmed", signature: sig });
    const warning = (r as { warning?: string }).warning ?? "";
    expect(warning).toMatch(/revoke any delegate/i);
    expect(warning).not.toMatch(/nothing was (spent|sent)|start again|transaction rejected/i);
    expect(state.copies.size).toBe(1);
    // The confirmed-order path (e.g. a later re-check by signature) repeats the warning.
    const again = await confirmOrder(d, post("/c", { orderId: b.orderId, signature: sig }, u), "copy");
    expect((again as { warning?: string }).warning).toBe(warning);
    // The user's natural next step used to be "Start again": a second copy now isn't needed, and
    // nothing about the first one was failed, so there is exactly one record per landed copy.
    expect([...state.orders.values()].filter((o) => o.status === "failed").length).toBe(0);
  });

  it("H4-01: a revive (order failed earlier, e.g. by an older build) of a landed USDC_AUTHORITY tx records it, flagged", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const c = withLanded((_t, ata) => ({ tokenAuthorityOps: [{ type: "setAuthority", target: ata }] }));
    const d = deps({ state, chain: c, alert: () => {} });
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64")).signatures[0]);
    await chain.send(Buffer.from(signedTransaction, "base64"));
    await createMemoryCopyStore(state).failOrder(b.orderId);
    const r = await confirmOrder(d, post("/c", { orderId: b.orderId, signature: sig }, u), "copy");
    expect(r.status).toBe("confirmed");
    expect(state.copies.size).toBe(1);
    expect(state.orders.get(b.orderId)?.reviewFlag).toBe("USDC_AUTHORITY");
  });

  it("H4-01 fallback: if the review flag can't be written, it isn't recorded unflagged: pending (VERIFY_UNAVAILABLE) + alert, never failed", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const alerts: string[] = [];
    const c = withLanded((_t, ata) => ({ tokenAuthorityOps: [{ type: "closeAccount", target: ata }] }));
    const store = createMemoryCopyStore(state);
    for (const broken of [async () => false, async () => Promise.reject(new Error("db down"))]) {
      const d = deps({ state, chain: c, alert: (m: string) => alerts.push(m), copy: { ...store, flagForReview: broken } });
      const { b } = await quoteAndBuild(d, u);
      const req = post("/c", { orderId: b.orderId, signedTransaction: sign(b.transaction, u.secretKey) }, u);
      expect(await code(confirmOrder(d, req, "copy"))).toBe("VERIFY_UNAVAILABLE");
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
      expect(state.orders.get(b.orderId)?.reviewFlag).toBeNull();
    }
    expect(state.copies.size).toBe(0);
    expect(alerts.join("\n")).toMatch(/couldn't write the review flag/);
    expect(alerts.join("\n")).toMatch(/USDC_AUTHORITY/);
  });

  it("H4-03: a non-TxRejected error from the token check is unknown (pending, alerted once), never USDC_AUTHORITY and never failed", async () => {
    // A null op makes checkTokenAuthorityOps throw a TypeError, not a TxRejected.
    const r = await confirmWith(withLanded(() => ({ tokenAuthorityOps: [null as unknown as { type: string; target: string }] })));
    expect(r.res).toBe("VERIFY_UNAVAILABLE");
    expect(await r.again()).toBe("VERIFY_UNAVAILABLE");
    expect(r.state.orders.get(r.b.orderId)?.status).toBe("pending");
    expect(r.state.orders.get(r.b.orderId)?.reviewFlag).toBeNull();
    expect(r.state.copies.size).toBe(0);
    expect(r.alerts.join("\n")).not.toMatch(/USDC_AUTHORITY/);
    expect(r.alerts.filter((m) => /token check errored/.test(m)).length).toBe(1);
  });

  it("a delegate/close on some OTHER token account (e.g. Panta's vault) is fine: recorded", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const r = await confirmWith(withLanded(() => ({ tokenAuthorityOps: [{ type: "approve", target: other }, { type: "closeAccount", target: other }] })));
    expect(r.res).toBe("OK");
    expect(r.state.copies.size).toBe(1);
  });

  it("missing or unreadable token instructions: retryable, never recorded or failed (alerted once)", async () => {
    const none = await confirmWith(withLanded(() => ({ tokenAuthorityOps: null })));
    expect(none.res).toBe("VERIFY_UNAVAILABLE");
    expect(none.state.orders.get(none.b.orderId)?.status).toBe("pending");
    const unknown = await confirmWith(withLanded(() => ({ tokenAuthorityOps: [{ type: "unknown", target: null }] })));
    expect(unknown.res).toBe("VERIFY_UNAVAILABLE");
    expect(await unknown.again()).toBe("VERIFY_UNAVAILABLE");
    expect(unknown.state.copies.size).toBe(0);
    expect(unknown.state.orders.get(unknown.b.orderId)?.status).toBe("pending");
    expect(unknown.alerts.filter((m) => m.includes("TOKEN_UNKNOWN")).length).toBe(1);
  });

  it("the auditor's suggestion: the USDC account NOW differs from the template -> recorded (may be a later user action) + one alert", async () => {
    // The user sets a delegate AFTER the build (the simulation saw a plain account).
    let later = false;
    const withDelegate = {
      getTokenAccounts: async (owner: string) =>
        (await chain.getTokenAccounts(owner)).map((a) => {
          if (!later || a.pubkey !== associatedTokenAddress(owner)) return a;
          const data = Buffer.from(a.data);
          data.writeUInt32LE(1, 72); // delegate: Some
          Keypair.generate().publicKey.toBuffer().copy(data, 76);
          return { ...a, data };
        }),
    };
    const r = await confirmWith(withLanded(() => ({}), withDelegate), () => (later = true));
    expect(r.res).toBe("OK");
    expect(r.alerts.join("\n")).toMatch(/differs from the plain template \(delegate set\)/);
    // A plain account: no alert. A read error: no alert, still recorded.
    const plain = await confirmWith(withLanded(() => ({})));
    expect(plain.res).toBe("OK");
    expect(plain.alerts.join("\n")).not.toMatch(/template/);
    let broken = false;
    const failingRead = {
      getTokenAccounts: async (owner: string) => {
        // The build's simulation reads token accounts too; only the confirm-time read fails.
        if (broken) throw new Error("rpc down");
        return chain.getTokenAccounts(owner);
      },
    };
    const down = await confirmWith(withLanded(() => ({}), failingRead), () => (broken = true));
    expect(down.res).toBe("OK");
  });

  it("tokenAuthorityOps decodes compiled, partially decoded and jsonParsed Token/Token-2022 instructions", () => {
    const ata = Keypair.generate().publicKey.toBase58();
    const keys = ["payer", TOKEN, ata, TOKEN22, "other", "11111111111111111111111111111111"];
    const ix = (pid: number, data: number[], accounts = [2]) => ({ programIdIndex: pid, accounts, data: bs58.encode(Buffer.from(data)) });
    const ops = tokenAuthorityOps(
      [
        {
          instructions: [
            ix(1, [3, 1, 0, 0, 0, 0, 0, 0, 0]), // transfer: ignored
            ix(1, [4, 1, 0, 0, 0, 0, 0, 0, 0]), // approve
            ix(3, [13, 1, 0, 0, 0, 0, 0, 0, 0, 6]), // Token-2022 approveChecked
            ix(1, [6, 0, 0], [4]), // setAuthority on another account
            ix(5, [4, 0, 0, 0]), // System, not Token
            { programId: TOKEN, accounts: [ata], data: bs58.encode(Buffer.from([9])) }, // closeAccount, partially decoded
            { programId: TOKEN, parsed: { type: "approve", info: { source: ata, delegate: "d" } } },
            { programId: TOKEN, parsed: { type: "transfer", info: { source: ata } } },
            { programIdIndex: 1, accounts: [2], data: "" }, // unreadable
          ],
        },
      ],
      keys,
    );
    expect(ops).toEqual([
      { type: "approve", target: ata },
      { type: "approveChecked", target: ata },
      { type: "setAuthority", target: "other" },
      { type: "closeAccount", target: ata },
      { type: "approve", target: ata },
      { type: "unknown", target: null },
    ]);
    expect(() => tokenAuthorityOps(null, keys)).toThrow();
    expect(() => tokenAuthorityOps([{ instructions: [{ programIdIndex: 99 }] }], keys)).toThrow();
    expect(() => checkTokenAuthorityOps([{ type: "approve", target: "other" }], ata)).not.toThrow();
    expect(() => checkTokenAuthorityOps(null, ata)).toThrow();
  });

  it("tokenAccountDrift: the plain template is null; delegate, close authority, state, native are named", () => {
    const fresh = Buffer.alloc(165);
    fresh[108] = 1;
    expect(tokenAccountDrift(fresh)).toBeNull();
    const d1 = Buffer.from(fresh);
    d1.writeUInt32LE(1, 72);
    d1.writeUInt32LE(1, 129);
    expect(tokenAccountDrift(d1)).toBe("delegate set, close authority set");
    const d2 = Buffer.from(fresh);
    d2[108] = 2;
    d2.writeUInt32LE(1, 109);
    expect(tokenAccountDrift(d2)).toBe("state 2, native");
    expect(tokenAccountDrift(Buffer.alloc(10))).toBe("short account data");
  });

  it("the real adapter decodes the landed inner Token instructions (null when they can't be read)", async () => {
    process.env.SOLANA_RPC_URL ??= "https://rpc.example/";
    const { Connection } = await import("@solana/web3.js");
    const { rpcChain } = await import("@/lib/solana");
    const payer = Keypair.generate().publicKey;
    const ata = Keypair.generate().publicKey;
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: bs58.encode(Buffer.alloc(32, 9)),
      instructions: [new TransactionInstruction({ programId: new PublicKey(TOKEN), keys: [{ pubkey: ata, isSigner: false, isWritable: true }], data: Buffer.from([3]) })],
    }).compileToV0Message();
    const keys = message.staticAccountKeys.map((k) => k.toBase58());
    const inner = [{ index: 0, instructions: [{ programIdIndex: keys.indexOf(TOKEN), accounts: [keys.indexOf(ata.toBase58())], data: bs58.encode(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0])) }] }];
    const tx = (innerInstructions: unknown) => ({ transaction: { message, signatures: ["s"] }, meta: { err: null, innerInstructions, preTokenBalances: [], postTokenBalances: [], postBalances: [1] } });
    const spy = vi.spyOn(Connection.prototype, "getTransaction");
    try {
      spy.mockResolvedValueOnce(tx(inner) as never);
      expect((await rpcChain.getLandedTransaction("s"))?.tokenAuthorityOps).toEqual([{ type: "approve", target: ata.toBase58() }]);
      spy.mockResolvedValueOnce(tx(undefined) as never);
      expect((await rpcChain.getLandedTransaction("s"))?.tokenAuthorityOps).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("L-01: 'provably past' needs isBlockhashValid=false AND a height above lastValidBlockHeight, same connection + commitment", () => {
  const chain = getSharedMockChain();
  const LVBH = 1_000_000; // panta-mock's lastValidBlockHeight
  const signed = async (d: FlowDeps, u: User) => {
    const { b } = await quoteAndBuild(d, u);
    const signedTransaction = sign(b.transaction, u.secretKey);
    const sig = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64")).signatures[0]);
    return { b, sig, first: { orderId: b.orderId, signedTransaction } };
  };
  const late = (state: CopyMemoryState, c: FlowDeps["chain"], min = 5) =>
    deps({ state, chain: c, nowMs: () => Date.now() + min * 60_000, resendDelayMs: 0 });
  /** "invalid", but the node's block height is `h`. */
  const invalidAt = (h: number | (() => Promise<number>), over: Partial<FlowDeps["chain"]> = {}): FlowDeps["chain"] => ({
    ...chain,
    isBlockhashValid: async () => false,
    currentBlockHeight: typeof h === "number" ? async () => h : h,
    ...over,
  });
  const nothingSpent = /nothing was (spent|sent)/i;

  it("PoF (lagging node): isBlockhashValid=false but height <= lastValidBlockHeight: pending, never 'Nothing was spent'; it then lands and is recorded once", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const d = deps({ state });
    const { b, sig, first } = await signed(d, u);
    for (const h of [LVBH - 50, LVBH]) {
      const lag = late(state, invalidAt(h));
      // By signature (never broadcast by us) and by signed bytes with a refusing send.
      const e = await confirmOrder(lag, post("/c", { orderId: b.orderId, signature: sig }, u), "copy").catch((x) => x);
      expect(e).toMatchObject({ code: "NOT_BROADCAST" });
      expect(String(e.message)).not.toMatch(nothingSpent);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
      expect(await provablyDead(lag, state.orders.get(b.orderId)!, sig)).toBe(false);
      expect((await sweepBroadcastOrders(late(state, invalidAt(h), 17))).abandoned).toBe(0);
      expect(state.orders.get(b.orderId)?.status).toBe("pending");
    }
    // A broadcast that the lagging node refuses: SEND_UNCONFIRMED (retryable), still pending.
    const refusing = invalidAt(LVBH - 1, {
      send: async () => Promise.reject(new SendError("refused", -32002, "failed to send transaction: Blockhash not found")),
    });
    const e = await confirmOrder(deps({ state, chain: refusing, resendDelayMs: 0 }), post("/c", first, u), "copy").catch((x) => x);
    expect(["SEND_UNCONFIRMED", "NOT_BROADCAST"]).toContain(e.code);
    expect(String(e.message)).not.toMatch(nothingSpent);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
    // The blockhash was valid all along: the copy lands and is recorded exactly once.
    await chain.send(Buffer.from(first.signedTransaction, "base64"));
    expect((await confirmOrder(late(state, chain), post("/c", first, u), "copy")).status).toBe("confirmed");
    expect((await confirmOrder(late(state, chain), post("/c", first, u), "copy")).status).toBe("confirmed");
    expect(state.copies.size).toBe(1);
  });

  it("height strictly above lastValidBlockHeight AND invalid AND no trace: failed (only then 'nothing was spent')", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const { b, sig } = await signed(deps({ state }), u);
    expect(await code(confirmOrder(late(state, invalidAt(LVBH + 1)), post("/c", { orderId: b.orderId, signature: sig }, u), "copy"))).toBe(
      "NOT_BROADCAST",
    );
    expect(state.orders.get(b.orderId)?.status).toBe("failed");
  });

  it("error case: isBlockhashValid throws: unknown, pending (confirm, provablyDead and the abandon sweep)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const { b, sig } = await signed(deps({ state }), u);
    const c = invalidAt(LVBH + 10_000, { isBlockhashValid: async () => Promise.reject(new Error("429")) });
    expect(await code(confirmOrder(late(state, c), post("/c", { orderId: b.orderId, signature: sig }, u), "copy"))).toBe("NOT_BROADCAST");
    expect(await provablyDead(late(state, c), state.orders.get(b.orderId)!, sig)).toBe(false);
    expect((await sweepBroadcastOrders(late(state, c, 17))).abandoned).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
  });

  it("error case: the block-height read throws: unknown, pending (confirm, provablyDead and the abandon sweep)", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const { b, sig } = await signed(deps({ state }), u);
    const c = invalidAt(async () => Promise.reject(new Error("Minimum context slot has not been reached")));
    expect(await code(confirmOrder(late(state, c), post("/c", { orderId: b.orderId, signature: sig }, u), "copy"))).toBe("NOT_BROADCAST");
    expect(await provablyDead(late(state, c), state.orders.get(b.orderId)!, sig)).toBe(false);
    expect((await sweepBroadcastOrders(late(state, c, 17))).abandoned).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
  });

  it("error case: the signature-status read is older than the blockhash read (or errors): unknown, pending", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const { b, sig } = await signed(deps({ state }), u);
    const seen: (number | undefined)[] = [];
    const c = invalidAt(LVBH + 1, {
      blockhashExpiry: async () => ({ valid: false, expired: true, slot: 777 }),
      signatureSeen: async (_s: string, min?: number) => {
        seen.push(min);
        throw new Error("signature status read is older than the blockhash read");
      },
    });
    expect(await provablyDead(late(state, c), state.orders.get(b.orderId)!, sig)).toBe(false);
    expect(seen).toEqual([777]); // the status read is pinned to the blockhash read's slot
    expect(await code(confirmOrder(late(state, c), post("/c", { orderId: b.orderId, signature: sig }, u), "copy"))).toBe("NOT_BROADCAST");
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
  });

  it("legacy orders with no stored lastValidBlockHeight are never failed as expired", async () => {
    const u = await signedInUser();
    const state = createCopyMemoryState();
    const { b, sig } = await signed(deps({ state }), u);
    state.orders.get(b.orderId)!.lastValidBlockHeight = null;
    const c = invalidAt(LVBH + 10_000_000);
    expect(await code(confirmOrder(late(state, c), post("/c", { orderId: b.orderId, signature: sig }, u), "copy"))).toBe("NOT_BROADCAST");
    expect((await sweepBroadcastOrders(late(state, c, 17))).abandoned).toBe(0);
    expect(state.orders.get(b.orderId)?.status).toBe("pending");
  });

  it("build: a missing lastValidBlockHeight from Panta stores a conservative upper bound (null on an RPC error)", async () => {
    const u = await signedInUser();
    const noLvbh = {
      ...deps().panta,
      buildPrimaryOrder: async (...a: Parameters<typeof panta.buildPrimaryOrder>) => ({
        ...(await panta.buildPrimaryOrder(...a)),
        lastValidBlockHeight: undefined,
      }),
    };
    const s1 = createCopyMemoryState();
    const { b } = await quoteAndBuild(deps({ state: s1, panta: noLvbh, chain: { ...chain, currentBlockHeight: async () => 5_000 } }), u);
    expect(s1.orders.get(b.orderId)?.lastValidBlockHeight).toBe(5_000 + 150 + LVBH_BOUND_MARGIN);
    const s2 = createCopyMemoryState();
    const broken = { ...chain, currentBlockHeight: async () => Promise.reject(new Error("rpc")) };
    const { b: b2 } = await quoteAndBuild(deps({ state: s2, panta: noLvbh, chain: broken }), u);
    expect(s2.orders.get(b2.orderId)?.lastValidBlockHeight).toBeNull();
    // Panta's own value is kept as is.
    const s3 = createCopyMemoryState();
    const { b: b3 } = await quoteAndBuild(deps({ state: s3 }), u);
    expect(s3.orders.get(b3.orderId)?.lastValidBlockHeight).toBe(LVBH);
  });

  describe("the real adapter: one connection, one commitment, minContextSlot", () => {
    const setup = async () => {
      process.env.SOLANA_RPC_URL ??= "https://rpc.example/";
      const { Connection } = await import("@solana/web3.js");
      const { rpcChain, getConnection } = await import("@/lib/solana");
      const { BLOCKHASH_COMMITMENT } = await import("@/lib/chain");
      return { Connection, rpcChain, conn: getConnection(), BLOCKHASH_COMMITMENT };
    };
    const bh = bs58.encode(Buffer.alloc(32, 9));
    const sig = bs58.encode(Buffer.alloc(64, 3));

    it("isBlockhashValid and getBlockHeight go to the same connection with the same commitment; height pinned to the validity answer's slot", async () => {
      const { Connection, rpcChain, conn, BLOCKHASH_COMMITMENT } = await setup();
      const thisArgs: unknown[] = [];
      const valid = vi.spyOn(Connection.prototype, "isBlockhashValid").mockImplementation(async function (this: unknown) {
        thisArgs.push(this);
        return { context: { slot: 4242 }, value: false };
      });
      const height = vi.spyOn(conn, "getBlockHeight").mockResolvedValue(LVBH + 1);
      try {
        expect(await rpcChain.blockhashExpiry(bh, LVBH)).toEqual({ valid: false, expired: true, slot: 4242 });
        expect(thisArgs[0]).toBe(conn);
        expect(valid.mock.calls[0]).toEqual([bh, { commitment: BLOCKHASH_COMMITMENT }]);
        expect(height.mock.calls[0]).toEqual([{ commitment: BLOCKHASH_COMMITMENT, minContextSlot: 4242 }]);
        // The lagging-node shape: invalid, but not past the height: not expired.
        height.mockResolvedValue(LVBH);
        expect(await rpcChain.blockhashExpiry(bh, LVBH)).toEqual({ valid: false, expired: false, slot: 4242 });
        // Valid: no height read needed.
        height.mockClear();
        valid.mockResolvedValue({ context: { slot: 1 }, value: true });
        expect(await rpcChain.blockhashExpiry(bh, LVBH)).toMatchObject({ valid: true, expired: false });
        expect(height).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("error cases: isBlockhashValid rejects, getBlockHeight rejects, or either answers garbage: the adapter throws", async () => {
      const { Connection, rpcChain, conn } = await setup();
      const valid = vi.spyOn(Connection.prototype, "isBlockhashValid").mockRejectedValue(new Error("503"));
      const height = vi.spyOn(conn, "getBlockHeight").mockResolvedValue(LVBH + 1);
      try {
        await expect(rpcChain.blockhashExpiry(bh, LVBH)).rejects.toThrow("503");
        valid.mockResolvedValue({ context: { slot: 9 }, value: null as never });
        await expect(rpcChain.blockhashExpiry(bh, LVBH)).rejects.toThrow(/unexpected/);
        valid.mockResolvedValue({ context: { slot: 9 }, value: false });
        height.mockRejectedValue(new Error("Minimum context slot has not been reached"));
        await expect(rpcChain.blockhashExpiry(bh, LVBH)).rejects.toThrow(/Minimum context slot/);
        height.mockResolvedValue(Number.NaN);
        await expect(rpcChain.blockhashExpiry(bh, LVBH)).rejects.toThrow(/unexpected/);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("signatureSeen: an answer from a node behind minContextSlot is an error, not 'no trace'", async () => {
      const { Connection, rpcChain } = await setup();
      const st = vi.spyOn(Connection.prototype, "getSignatureStatuses").mockResolvedValue({ context: { slot: 99 }, value: [null] } as never);
      try {
        await expect(rpcChain.signatureSeen(sig, 100)).rejects.toThrow(/older/);
        expect(await rpcChain.signatureSeen(sig, 99)).toBe(false);
        expect(await rpcChain.signatureSeen(sig)).toBe(false);
        st.mockResolvedValue({ context: { slot: 99 }, value: [{ confirmationStatus: "processed", err: null }] } as never);
        expect(await rpcChain.signatureSeen(sig, 50)).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("end to end on the real adapter: each RPC error keeps the order pending; only invalid + height past + no trace fails it", async () => {
      const { Connection, rpcChain, conn } = await setup();
      const u = await signedInUser();
      const state = createCopyMemoryState();
      const { b, sig: osig } = await signed(deps({ state }), u);
      const order = () => state.orders.get(b.orderId)!;
      const valid = vi.spyOn(Connection.prototype, "isBlockhashValid").mockResolvedValue({ context: { slot: 50 }, value: false });
      const height = vi.spyOn(conn, "getBlockHeight").mockResolvedValue(LVBH + 1);
      const st = vi.spyOn(Connection.prototype, "getSignatureStatuses").mockResolvedValue({ context: { slot: 50 }, value: [null] } as never);
      vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue(null);
      const d = late(state, rpcChain);
      try {
        valid.mockRejectedValueOnce(new Error("429"));
        expect(await provablyDead(d, order(), osig)).toBe(false);
        height.mockRejectedValueOnce(new Error("Minimum context slot has not been reached"));
        expect(await provablyDead(d, order(), osig)).toBe(false);
        height.mockResolvedValueOnce(LVBH); // lagging node: not past
        expect(await provablyDead(d, order(), osig)).toBe(false);
        st.mockResolvedValueOnce({ context: { slot: 49 }, value: [null] } as never); // status from an older node
        expect(await provablyDead(d, order(), osig)).toBe(false);
        expect(order().status).toBe("pending");
        expect(await provablyDead(d, order(), osig)).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
