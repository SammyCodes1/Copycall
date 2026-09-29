/**
 * Copy + claim flows (steps 9-10, hard requirements 2-4, addendum A/C/H).
 * Real signing with test keypairs against the mock chain, plus mock mode's
 * simulated signing.
 */
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
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
import * as panta from "@/lib/panta";
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
