/**
 * Copy flow (step 9) and claim flow (step 10), server side.
 *
 * Hard rules (hard requirements 2-4, SECURITY ADDENDUM A, C, H):
 *  - The copy link carries only our internal trade id. Market and side come
 *    from the stored leader trade; the amount and slippage come from the
 *    follower's saved settings. Nothing in the URL, query or body can change them.
 *  - Slippage is capped at 500 bps here even though Panta allows 5000.
 *  - We assemble the transaction ourselves (fee payer = session wallet), check
 *    it against the allowlist, simulate it, store the hash of the exact message
 *    and hand the wallet those exact bytes.
 *  - Confirm fetches the transaction from chain and requires: success, signer ==
 *    session wallet, message == the one we built for this user, allowlisted
 *    programs, and a signature never recorded before. Only then do we report
 *    to Panta (POST /trades/) and record the copy / claim.
 * Dependencies are injected so every rule is unit-tested (tests/copy.test.ts).
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { AuthError, assertSameOrigin, readJsonBody } from "./auth-core";
import type { Chain } from "./chain";
import type { CopyStore, PendingOrder } from "./copy-store";
import type { StoredMarket, StoredTrade } from "./data-store";
import { PantaError } from "./panta-error";
import {
  ClaimBuildBodySchema,
  ConfirmRequestSchema,
  CopyBuildRequestSchema,
  MAX_SLIPPAGE_BPS,
  type BuildRequest,
  type BuildResponse,
  type ClaimBuildRequest,
  type ClaimBuildResponse,
  type PositionsResponse,
  type QuoteRequest,
  type QuoteResponse,
  type ReportTradeRequest,
  type ReportTradeResponse,
} from "./schemas";
import {
  ATA_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  baseToUsdc,
  usdcToBase,
} from "./solana-constants";
import { safeTitle } from "./text";
import type { TradeSide } from "./trades";
import {
  TxRejected,
  assembleTransaction,
  checkInstructions,
  checkLandedPrograms,
  checkMessageShape,
  invokedPrograms,
  sha256Hex,
  simulateAndCheck,
  type TxKind,
} from "./tx-guard";
import { requireSession, type UserDeps } from "./user-core";

export const QUOTE_RATE_LIMIT = 10; // per user per minute (addendum H)
export const BUILD_RATE_LIMIT = 10;
export const CONFIRM_RATE_LIMIT = 30;
export const POSITIONS_RATE_LIMIT = 30;
export const QUOTE_CACHE_SEC = 10; // addendum H
export const POSITIONS_CACHE_SEC = 30;
/** How long the review screen's quote stays signable (Panta quotes last ~90s). */
export const QUOTE_TOKEN_MAX_SEC = 75;
const QUOTE_EXPIRY_MARGIN_SEC = 10;
/** Signed bytes older than this aren't broadcast (blockhash lasts ~60-90s). */
export const ORDER_TTL_SEC = 90;
/** A signature-only retry is accepted this long after the build. */
export const ORDER_LOOKUP_SEC = 15 * 60;

export type FlowPanta = {
  quotePrimaryOrder(req: QuoteRequest): Promise<QuoteResponse>;
  buildPrimaryOrder(req: BuildRequest): Promise<BuildResponse>;
  buildClaim(req: ClaimBuildRequest): Promise<ClaimBuildResponse>;
  reportTrade(req: ReportTradeRequest): Promise<ReportTradeResponse>;
  getPositions(wallet: string): Promise<PositionsResponse>;
};

export type FlowDeps = UserDeps & {
  copy: CopyStore;
  panta: FlowPanta;
  chain: Chain;
  pantaProgramIds: ReadonlySet<string>;
  mock: boolean;
  nowMs?: () => number;
  confirmTimeoutMs?: number;
  log?: (m: string) => void;
};

const nowSec = (d: FlowDeps) => Math.floor((d.nowMs?.() ?? Date.now()) / 1000);
const toApiSide = (s: TradeSide) => (s === "YES" ? "yes" : "no");
const fromApiSide = (s: string): TradeSide => (s.toLowerCase() === "yes" ? "YES" : "NO");

async function rateLimit(d: FlowDeps, bucket: string, uid: string, limit: number) {
  const ok = await d.auth.store.hitRateLimit(`${bucket}:user:${uid}`, limit, 60);
  if (!ok) throw new AuthError(429, "RATE_LIMITED", "Too many requests. Try again in a minute.");
}

const quoteExpired = (msg = "Quote expired, refresh") => new AuthError(409, "QUOTE_EXPIRED", msg);
const rejected = (why: string) => new AuthError(422, "TX_REJECTED", `Transaction rejected: ${why}`);

/** Panta error codes -> honest user-facing states. */
function fromPanta(err: unknown): never {
  if (err instanceof PantaError) {
    switch (err.code) {
      case "QUOTE_EXPIRED":
      case "QUOTE_STALE":
        throw quoteExpired("Quote expired, refresh. The price moved or the quote timed out.");
      case "MARKET_NOT_IN_PRIMARY":
        throw new AuthError(409, "MARKET_CLOSED", "This market isn't taking new buys any more");
      case "AMOUNT_TOO_SMALL":
        throw new AuthError(
          400,
          "AMOUNT_TOO_SMALL",
          "Your max stake is below this market's minimum. Raise it in Settings.",
        );
      case "NOT_CLAIMABLE":
        throw new AuthError(409, "NOT_CLAIMABLE", "Nothing to claim for this market");
      case "MARKET_NOT_FOUND":
        throw new AuthError(404, "MARKET_NOT_FOUND", "Market not found");
      case "RATE_LIMITED":
        throw new AuthError(503, "PANTA_BUSY", "Panta is busy. Try again in a minute.");
    }
    throw new AuthError(502, "PANTA_ERROR", "Panta couldn't do this right now. Try again.");
  }
  throw err;
}

function asRejection(err: unknown): never {
  if (err instanceof TxRejected) throw rejected(err.message);
  throw err;
}

// ---------------------------------------------------------------- copy context

export type CopyContext = { trade: StoredTrade; market: StoredMarket | null };

/** Stored leader trade + market for a copy link. Only primary buys with a clear side can be copied. */
export async function loadCopyContext(d: UserDeps, tradeId: string): Promise<CopyContext | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tradeId)) return null;
  const trade = await d.data.getTradeById(tradeId.toLowerCase());
  if (!trade || !trade.isPrimary) return null;
  const [market] = await d.data.getMarkets([trade.marketId]);
  return { trade, market: market ?? null };
}

export type QuoteView = {
  quoteToken: string;
  tradeId: string;
  marketId: string;
  title: string;
  side: TradeSide;
  amountUsdc: string;
  shares: string;
  avgPrice: string;
  feeUsdc: string;
  slippageBps: number;
  validUntil: number; // unix sec: build must happen before this
};

type QuoteToken = {
  uid: string;
  tradeId: string;
  stake: string;
  slippageBps: number;
  quote: QuoteResponse;
  validUntil: number;
};

type CachedQuote = { view: QuoteView; stake: string; slippageBps: number };

async function settingsFor(d: FlowDeps, uid: string) {
  const s = await d.data.getSettings(uid);
  if (!s) throw new AuthError(401, "UNAUTHENTICATED", "Sign in with your wallet first");
  // Server-side cap (hard requirement 4), even if the stored value were somehow higher.
  if (!Number.isInteger(s.slippageBps) || s.slippageBps < 0 || s.slippageBps > MAX_SLIPPAGE_BPS) {
    throw new AuthError(400, "SLIPPAGE_TOO_HIGH", "Slippage can't exceed 5%. Lower it in Settings.");
  }
  usdcToBase(s.maxStakeUsdc); // throws on anything malformed
  return s;
}

async function requireCopyable(d: FlowDeps, tradeId: string): Promise<CopyContext> {
  const ctx = await loadCopyContext(d, tradeId);
  if (!ctx) throw new AuthError(404, "TRADE_NOT_FOUND", "No trade to copy here");
  if (ctx.market && ctx.market.status !== "primary") {
    throw new AuthError(409, "MARKET_CLOSED", "This market isn't taking new buys any more");
  }
  return ctx;
}

/**
 * GET /api/copy/[tradeId]/quote. The request is only used for the session:
 * query parameters are never read.
 */
export async function quoteCopy(d: FlowDeps, request: Request, tradeId: string): Promise<QuoteView> {
  const session = await requireSession(d, request);
  await rateLimit(d, "copyquote", session.uid, QUOTE_RATE_LIMIT);
  const { trade, market } = await requireCopyable(d, tradeId);
  const settings = await settingsFor(d, session.uid);
  const now = nowSec(d);

  const cacheKey = `quote:${session.uid}:${trade.id}`;
  const cached = await d.copy.cacheGet<CachedQuote>(cacheKey, now);
  if (cached && cached.stake === settings.maxStakeUsdc && cached.slippageBps === settings.slippageBps)
    return cached.view;

  let q: QuoteResponse;
  try {
    q = await d.panta.quotePrimaryOrder({
      wallet: session.w,
      marketId: trade.marketId, // from the stored trade
      side: toApiSide(trade.side), // from the stored trade
      amountUsdc: settings.maxStakeUsdc, // from the follower's saved settings
    });
  } catch (err) {
    fromPanta(err);
  }
  if (
    q.marketId !== trade.marketId ||
    fromApiSide(q.side) !== trade.side ||
    usdcToBase(q.amountUsdc) !== usdcToBase(settings.maxStakeUsdc)
  ) {
    throw new AuthError(502, "PANTA_ERROR", "Panta returned a quote for a different order");
  }

  const pantaExpiry = Math.floor(Date.parse(q.expiresAt) / 1000);
  const validUntil = Math.min(
    now + QUOTE_TOKEN_MAX_SEC,
    (Number.isFinite(pantaExpiry) ? pantaExpiry : now) - QUOTE_EXPIRY_MARGIN_SEC,
  );
  if (validUntil <= now) throw quoteExpired();
  const token = randomUUID();
  const view: QuoteView = {
    quoteToken: token,
    tradeId: trade.id,
    marketId: trade.marketId,
    title: safeTitle(market?.title ?? "Untitled market"),
    side: trade.side,
    amountUsdc: baseToUsdc(usdcToBase(q.amountUsdc)),
    shares: q.shares,
    avgPrice: q.avgPrice,
    feeUsdc: q.feeUsdc,
    slippageBps: settings.slippageBps,
    validUntil,
  };
  const tok: QuoteToken = {
    uid: session.uid,
    tradeId: trade.id,
    stake: settings.maxStakeUsdc,
    slippageBps: settings.slippageBps,
    quote: q,
    validUntil,
  };
  await d.copy.cachePut(`qtok:${token}`, tok, validUntil);
  await d.copy.cachePut(
    cacheKey,
    { view, stake: settings.maxStakeUsdc, slippageBps: settings.slippageBps } satisfies CachedQuote,
    now + QUOTE_CACHE_SEC,
  );
  return view;
}

export type BuiltTx = {
  orderId: string;
  transaction: string; // base64 of the exact unsigned transaction to sign
  expiresAt: number;
  simulated: boolean; // mock mode: signing will be simulated
  checks: {
    feePayer: string;
    programs: string[];
    usdcOut: string; // simulated USDC leaving the wallet (negative = received)
    maxUsdcOut: string;
    otherAccountsChecked: number;
  };
};

function programLabel(d: FlowDeps, id: string): string {
  if (d.pantaProgramIds.has(id)) return "Panta";
  return (
    {
      [SYSTEM_PROGRAM_ID]: "System",
      [TOKEN_PROGRAM_ID]: "Token",
      [TOKEN_2022_PROGRAM_ID]: "Token-2022",
      [ATA_PROGRAM_ID]: "Associated Token",
      [COMPUTE_BUDGET_PROGRAM_ID]: "Compute Budget",
    }[id] ?? id
  );
}

async function assembleAndStore(
  d: FlowDeps,
  a: {
    kind: TxKind;
    uid: string;
    wallet: string;
    marketId: string;
    instructions: BuildResponse["instructions"];
    recentBlockhash: string;
    lastValidBlockHeight: number | null;
    maxUsdcOutBase: bigint;
    order: Omit<
      PendingOrder,
      | "id"
      | "status"
      | "signature"
      | "userId"
      | "wallet"
      | "kind"
      | "marketId"
      | "messageHash"
      | "messageBase64"
      | "lastValidBlockHeight"
      | "createdAt"
      | "expiresAt"
    >;
  },
): Promise<BuiltTx> {
  let tx: VersionedTransaction;
  let sim: Awaited<ReturnType<typeof simulateAndCheck>>;
  try {
    checkInstructions(a.instructions, {
      kind: a.kind,
      feePayer: a.wallet,
      marketId: a.marketId,
      pantaProgramIds: d.pantaProgramIds,
      maxUsdcOutBase: a.maxUsdcOutBase,
    });
    tx = assembleTransaction(a.instructions, a.recentBlockhash, a.wallet);
    sim = await simulateAndCheck(d.chain, tx, a.wallet, a.maxUsdcOutBase);
  } catch (err) {
    if (err instanceof TxRejected) d.log?.(`${a.kind} build rejected: ${err.code}`);
    asRejection(err);
  }
  const messageBytes = tx.message.serialize();
  const now = nowSec(d);
  const order = await d.copy.createPendingOrder({
    ...a.order,
    userId: a.uid,
    wallet: a.wallet,
    kind: a.kind,
    marketId: a.marketId,
    messageHash: sha256Hex(messageBytes),
    messageBase64: Buffer.from(messageBytes).toString("base64"),
    lastValidBlockHeight: a.lastValidBlockHeight,
    createdAt: now,
    expiresAt: now + ORDER_TTL_SEC,
  });
  return {
    orderId: order.id,
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    expiresAt: order.expiresAt,
    simulated: d.mock,
    checks: {
      feePayer: a.wallet,
      programs: [...new Set(invokedPrograms(tx.message).map((p) => programLabel(d, p)))],
      usdcOut: baseToUsdc(sim.usdcDecrease),
      maxUsdcOut: baseToUsdc(a.maxUsdcOutBase),
      otherAccountsChecked: Math.max(0, sim.accountsChecked - 1),
    },
  };
}

/** POST /api/copy/[tradeId]/build { quoteToken } */
export async function buildCopy(d: FlowDeps, request: Request, tradeId: string): Promise<BuiltTx> {
  assertSameOrigin(request, d.auth.appOrigin);
  const session = await requireSession(d, request);
  await rateLimit(d, "copybuild", session.uid, BUILD_RATE_LIMIT);
  const parsed = CopyBuildRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_REQUEST", "Invalid request");

  const now = nowSec(d);
  const tokKey = `qtok:${parsed.data.quoteToken}`;
  const tok = await d.copy.cacheGet<QuoteToken>(tokKey, now);
  if (!tok || tok.uid !== session.uid || tok.tradeId !== tradeId.toLowerCase() || tok.validUntil <= now)
    throw quoteExpired();
  await d.copy.cacheDelete(tokKey); // single use

  const { trade } = await requireCopyable(d, tradeId);
  const settings = await settingsFor(d, session.uid);
  if (settings.maxStakeUsdc !== tok.stake || settings.slippageBps !== tok.slippageBps) {
    throw quoteExpired("Your settings changed. Refresh the quote.");
  }

  let b: BuildResponse;
  try {
    b = await d.panta.buildPrimaryOrder({
      quoteId: tok.quote.quoteId,
      wallet: session.w,
      maxSlippageBps: settings.slippageBps,
    });
  } catch (err) {
    fromPanta(err);
  }
  const stake = usdcToBase(settings.maxStakeUsdc);
  if (
    b.wallet !== session.w ||
    b.marketId !== trade.marketId ||
    fromApiSide(b.side) !== trade.side ||
    usdcToBase(b.amountUsdc) !== stake ||
    b.quoteId !== tok.quote.quoteId
  ) {
    throw rejected("Panta built a different order than the one quoted");
  }
  const maxOut = stake + usdcToBase(tok.quote.feeUsdc); // addendum A: max stake + quoted fee
  const built = await assembleAndStore(d, {
    kind: "copy",
    uid: session.uid,
    wallet: session.w,
    marketId: trade.marketId,
    instructions: b.instructions,
    recentBlockhash: b.recentBlockhash,
    lastValidBlockHeight: b.lastValidBlockHeight ?? null,
    maxUsdcOutBase: maxOut,
    order: {
      leaderTradeId: trade.id,
      side: trade.side,
      amountUsdc: baseToUsdc(stake),
      feeUsdc: tok.quote.feeUsdc,
      shares: b.expectedShares,
      quoteId: tok.quote.quoteId,
      pantaOrderId: b.orderId,
    },
  });
  await d.copy.cacheDelete(`quote:${session.uid}:${trade.id}`);
  return built;
}

// ---------------------------------------------------------------- claim build

/** POST /api/claim/build { marketId } */
export async function buildClaimTx(d: FlowDeps, request: Request): Promise<BuiltTx & { winningShares: string }> {
  assertSameOrigin(request, d.auth.appOrigin);
  const session = await requireSession(d, request);
  await rateLimit(d, "claimbuild", session.uid, BUILD_RATE_LIMIT);
  const parsed = ClaimBuildBodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_REQUEST", "Invalid market");
  const marketId = parsed.data.marketId;

  let c: ClaimBuildResponse;
  try {
    c = await d.panta.buildClaim({ wallet: session.w, marketId });
  } catch (err) {
    fromPanta(err);
  }
  if (c.wallet !== session.w || c.marketId !== marketId)
    throw rejected("Panta built a claim for a different wallet or market");
  if (usdcToBase(c.winningShares) <= 0n) throw new AuthError(409, "NOT_CLAIMABLE", "Nothing to claim for this market");

  const built = await assembleAndStore(d, {
    kind: "claim",
    uid: session.uid,
    wallet: session.w,
    marketId,
    instructions: c.instructions,
    recentBlockhash: c.recentBlockhash,
    lastValidBlockHeight: c.lastValidBlockHeight ?? null,
    maxUsdcOutBase: 0n, // a claim may never move USDC out of the wallet
    order: {
      leaderTradeId: null,
      side: fromApiSide(c.outcome),
      amountUsdc: c.winningShares,
      feeUsdc: "0",
      shares: c.winningShares,
      quoteId: null,
      pantaOrderId: null,
    },
  });
  return { ...built, winningShares: c.winningShares };
}

// ---------------------------------------------------------------- confirm (addendum C)

export type ConfirmResult =
  | { status: "pending"; signature: string }
  | { status: "confirmed"; signature: string; reported: boolean; simulated: boolean; kind: TxKind };

/** POST /api/copy/confirm and /api/claim/confirm. */
export async function confirmOrder(d: FlowDeps, request: Request, kind: TxKind): Promise<ConfirmResult> {
  assertSameOrigin(request, d.auth.appOrigin);
  const session = await requireSession(d, request);
  await rateLimit(d, "confirm", session.uid, CONFIRM_RATE_LIMIT);
  const parsed = ConfirmRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new AuthError(400, "INVALID_REQUEST", "Invalid request");
  const body = parsed.data;

  const order = await d.copy.getPendingOrder(body.orderId);
  if (!order || order.userId !== session.uid || order.kind !== kind || order.wallet !== session.w) {
    throw new AuthError(404, "ORDER_NOT_FOUND", "We couldn't find this order. Start again.");
  }
  if (order.status === "confirmed") {
    return { status: "confirmed", signature: order.signature!, reported: true, simulated: d.mock, kind };
  }
  if (order.status === "failed")
    throw new AuthError(409, "TX_FAILED", "This transaction failed. Nothing was recorded. Start again.");

  const now = nowSec(d);
  let signature: string;
  let simulated = false;

  if ("signedTransaction" in body) {
    if (now > order.expiresAt) throw quoteExpired("Quote expired, refresh. Nothing was sent.");
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    } catch {
      throw rejected("unreadable transaction");
    }
    const msg = tx.message.serialize();
    // The wallet must sign OUR bytes. A wallet that edits the transaction is refused.
    if (sha256Hex(msg) !== order.messageHash) throw rejected("it doesn't match the one we checked. Nothing was sent.");
    if (tx.signatures.length !== 1 || !nacl.sign.detached.verify(msg, tx.signatures[0], bs58.decode(session.w))) {
      throw rejected("it isn't signed by your wallet. Nothing was sent.");
    }
    signature = bs58.encode(tx.signatures[0]);
    if (await d.copy.signatureUsed(signature))
      throw new AuthError(409, "SIGNATURE_USED", "This transaction was already recorded");
    try {
      await d.chain.send(tx.serialize());
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      if (!/already (been )?processed/i.test(m)) {
        d.log?.(`${kind} broadcast failed: ${m.slice(0, 200)}`);
        throw rejected("the network refused it. Nothing was spent.");
      }
    }
  } else if ("signature" in body) {
    if (now > order.createdAt + ORDER_LOOKUP_SEC)
      throw new AuthError(409, "ORDER_EXPIRED", "This order is too old to confirm. Start again.");
    signature = body.signature;
    if (await d.copy.signatureUsed(signature))
      throw new AuthError(409, "SIGNATURE_USED", "This transaction was already recorded");
  } else {
    // Mock mode only: land the exact stored message on the mock chain.
    if (!d.mock || !d.chain.simulateSignAndSend) {
      throw new AuthError(400, "SIMULATION_UNAVAILABLE", "Simulated signing is only available in mock mode");
    }
    if (now > order.expiresAt) throw quoteExpired("Quote expired, refresh. Nothing was sent.");
    signature = await d.chain.simulateSignAndSend(Buffer.from(order.messageBase64, "base64"));
    simulated = true;
  }

  const state = await d.chain.waitForConfirmation(signature, order.lastValidBlockHeight, d.confirmTimeoutMs ?? 20_000);
  if (state === "expired") {
    await d.copy.failOrder(order.id);
    throw quoteExpired("The transaction expired before it landed. Nothing was spent. Refresh and try again.");
  }
  if (state === "pending") return { status: "pending", signature };

  // ---- verify ON CHAIN; never trust what the client sent ----
  const landed = await d.chain.getLandedTransaction(signature);
  if (!landed) return { status: "pending", signature };
  try {
    checkMessageShape(landed.message, session.w); // signer / fee payer == session wallet
  } catch {
    throw rejected("it wasn't signed by your wallet");
  }
  if (landed.signatures[0] !== signature) throw rejected("signature mismatch");
  if (sha256Hex(landed.message.serialize()) !== order.messageHash)
    throw rejected("it isn't the transaction we built for you");
  try {
    checkLandedPrograms(landed.message, d.pantaProgramIds);
  } catch (err) {
    asRejection(err);
  }
  if (landed.err !== null) {
    await d.copy.failOrder(order.id);
    throw new AuthError(422, "TX_FAILED", "Transaction failed on-chain. Nothing was copied.");
  }

  const result = await d.copy.completeOrder(order.id, session.uid, signature);
  if (result === "signature_used") throw new AuthError(409, "SIGNATURE_USED", "This transaction was already recorded");
  if (result === "not_pending") throw new AuthError(409, "ORDER_NOT_PENDING", "This order was already handled");

  // Recorded. Now attribute it with Panta (idempotent per signature).
  let reported = false;
  try {
    await d.panta.reportTrade({
      signature,
      wallet: session.w,
      marketId: order.marketId,
      ...(order.quoteId ? { quoteId: order.quoteId } : {}),
    });
    await d.copy.markReported(order.id);
    reported = true;
  } catch (err) {
    d.log?.(`${kind} report failed for ${signature.slice(0, 8)}…: ${err instanceof PantaError ? err.code : "error"}`);
  }
  await d.copy.cacheDelete(`positions:${session.w}`);
  return { status: "confirmed", signature, reported, simulated, kind };
}

// ---------------------------------------------------------------- positions

export type PositionView = {
  marketId: string;
  title: string;
  side: TradeSide;
  shares: string;
  phase: string;
  outcome: TradeSide | null;
  status: "open" | "claimable" | "won" | "claimed" | "lost" | "cancelled";
};

export type PositionsView = {
  wallet: string;
  positions: PositionView[];
  copies: {
    id: string;
    tradeId: string;
    title: string;
    side: TradeSide;
    amountUsdc: string;
    shares: string;
    signature: string;
    createdAt: number;
    reported: boolean;
  }[];
};

function positionStatus(p: PositionsResponse["positions"][number]): PositionView["status"] {
  if (p.phase === "cancelled") return "cancelled";
  if (p.claimed) return "claimed";
  if (p.claimable) return "claimable";
  if (p.phase === "resolved") return p.outcome && p.outcome === p.side ? "won" : "lost"; // won, but Panta says not claimable (yet)
  return "open";
}

/** GET /api/positions: the SESSION wallet's positions only (no wallet parameter exists). */
export async function myPositions(d: FlowDeps, request: Request): Promise<PositionsView> {
  return positionsForSession(d, await requireSession(d, request));
}

/** Same, for a server component that already resolved the session (the /positions page). */
export async function positionsForSession(d: FlowDeps, session: { uid: string; w: string }): Promise<PositionsView> {
  await rateLimit(d, "positions", session.uid, POSITIONS_RATE_LIMIT);
  const now = nowSec(d);
  const key = `positions:${session.w}`;
  let res = await d.copy.cacheGet<PositionsResponse>(key, now);
  if (!res) {
    try {
      res = await d.panta.getPositions(session.w);
    } catch (err) {
      fromPanta(err);
    }
    await d.copy.cachePut(key, res, now + POSITIONS_CACHE_SEC);
  }
  const copies = await d.copy.listCopies(session.uid, 20);
  const ids = [...new Set([...res.positions.map((p) => p.marketId), ...copies.map((c) => c.marketId)])];
  const titles = new Map((await d.data.getMarkets(ids)).map((m) => [m.id, safeTitle(m.title)]));
  const title = (id: string) => titles.get(id) ?? "Market not synced yet";
  const order: Record<PositionView["status"], number> = {
    claimable: 0,
    open: 1,
    won: 2,
    claimed: 3,
    lost: 4,
    cancelled: 5,
  };
  return {
    wallet: session.w,
    positions: res.positions
      .map((p) => ({
        marketId: p.marketId,
        title: title(p.marketId),
        side: fromApiSide(p.side),
        shares: p.shares,
        phase: p.phase,
        outcome: p.outcome ? fromApiSide(p.outcome) : null,
        status: positionStatus(p),
      }))
      .sort((a, b) => order[a.status] - order[b.status]),
    copies: copies.map((c) => ({
      id: c.id,
      tradeId: c.leaderTradeId,
      title: title(c.marketId),
      side: c.side,
      amountUsdc: c.amountUsdc,
      shares: c.shares,
      signature: c.signature,
      createdAt: c.createdAt,
      reported: c.status === "reported",
    })),
  };
}
