/**
 * Copy flow (step 9) and claim flow (step 10), server side.
 *
 * Hard rules (hard requirements 2-4, SECURITY ADDENDUM A, C, H):
 *  - The copy link carries only our internal trade id. Market and side come
 *    from the stored leader trade; the amount and slippage come from the
 *    follower's saved settings. Nothing in the URL, query or body can change them.
 *  - Slippage is capped at 500 bps here even though Panta allows 5000.
 *  - The max stake is the hard total, fee included: the guard's USDC limit is
 *    the max stake itself (no fee or slippage headroom on top). See lib/copy-math.ts.
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
import { VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { AuthError, assertSameOrigin, readJsonBody } from "./auth-core";
import type { Chain } from "./chain";
import { isCanonicalSignature, isCanonicalSignatureB58 } from "./ed25519";
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
  usdcToBase,
} from "./solana-constants";
import {
  copyAmounts,
  toMicro,
  copyUsdcLimitBase,
  feeCapBase,
  fromMicro,
  outflowBase,
  usdcExact,
  type FeeModel,
} from "./copy-math";
import { FeeModelError, quoteWithinStake, type PinnedFeeModel, type WithinStake } from "./fee-quote";
import { reportOnce } from "./report-retry";
import { safeTitle } from "./text";
import type { TradeSide } from "./trades";
import {
  TxRejected,
  assembleTransaction,
  checkInnerPrograms,
  checkInnerSystemOps,
  checkInstructions,
  checkWalletAccount,
  checkLandedPrograms,
  checkMessageShape,
  invokedPrograms,
  sha256Hex,
  simulateAndCheck,
  type GuardContext,
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
/** E-02: a signature we broadcast ourselves stays checkable this long (the RPC keeps tx history). */
export const BROADCAST_LOOKUP_SEC = 24 * 60 * 60;

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
  /**
   * Pinned per deployment (PANTA_FEE_MODEL, lib/fee-config.ts). A quote that contradicts it is refused.
   * null = not configured or invalid: only quote and build refuse (503); claims, confirms and
   * positions don't depend on it (E-09).
   */
  feeModel: PinnedFeeModel | null;
  /** Fee sanity cap as bps of the stake (PANTA_FEE_CAP_BPS, default 500). Quotes and builds above it are refused. */
  feeCapBps: number | null;
  /**
   * Launch cap: MAX_STAKE_USDC in base units (lib/stake-cap.ts). No copy may move more,
   * whatever the saved max stake. null = missing/invalid in real mode: copies fail closed
   * (quote/build 503; a copy confirm stays retryable).
   */
  maxStakeCapBase: bigint | null;
  mock: boolean;
  nowMs?: () => number;
  confirmTimeoutMs?: number;
  /** G-03: pause between re-sends of a refused broadcast (tests use 0). */
  resendDelayMs?: number;
  log?: (m: string) => void;
  /** Operator alert (TX_FEE_MISMATCH and friends). Default: console.error "[ALERT] …". */
  alert?: (m: string) => void;
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
  amountUsdc: string; // the deposit sent to Panta (stake, or stake - fee when the fee is on top)
  shares: string;
  avgPrice: string;
  feeUsdc: string;
  /** Detected from Panta's own quote numbers (lib/copy-math.ts classifyFeeModel). */
  feeModel: FeeModel;
  /** What leaves the wallet, fee included. Never above the max stake. */
  totalUsdc: string;
  /** The guard's cap for this order: the max stake, fee included, in every model. */
  maxUsdcOut: string;
  slippageBps: number;
  validUntil: number; // unix sec: build must happen before this
};

/** The quote record (api_cache, single use). Build trusts only this, never the client. */
type QuoteToken = {
  uid: string;
  tradeId: string;
  stake: string;
  slippageBps: number;
  quote: QuoteResponse; // the quote to build from (the re-quote when the fee is on top)
  feeModel: FeeModel;
  firstModel: string; // what the stake-sized quote classified as (audit trail)
  depositUsdc: string; // exact, 6 dp
  feeUsdc: string; // exact, 6 dp
  maxUsdcOut: string; // exact, 6 dp
  validUntil: number;
};

/**
 * D-05: bump when QuoteView's shape changes, so a view cached by the previous
 * deploy (≤ QUOTE_CACHE_SEC old) is never served in the old shape.
 */
export const QUOTE_VIEW_VERSION = 2;
type CachedQuote = { v: number; view: QuoteView; stake: string; slippageBps: number };

/** E-09: the fee config, required only where a fee is quoted or built. */
function feePin(d: FlowDeps): { model: PinnedFeeModel; capBps: number } {
  if (d.feeModel === null || d.feeCapBps === null)
    throw new AuthError(503, "NOT_CONFIGURED", "Copying isn't configured on this server yet");
  return { model: d.feeModel, capBps: d.feeCapBps };
}

/** Launch cap, required wherever a copy is quoted, built or confirmed. */
function stakeCap(d: FlowDeps): bigint {
  if (d.maxStakeCapBase === null || d.maxStakeCapBase <= 0n)
    throw new AuthError(503, "NOT_CONFIGURED", "Copying isn't configured on this server yet");
  return d.maxStakeCapBase;
}
function stakeAboveCap(cap: bigint): AuthError {
  return new AuthError(
    422,
    "STAKE_ABOVE_CAP",
    `Your max stake is above this server's limit of ${usdcExact(cap)} USDC per copy. Lower it in Settings. Nothing was sent.`,
  );
}

/** D-05: alert once per process and (pin, reading) when Panta's quotes don't match the pinned fee model. */
const feeModelAlerted = new Set<string>();
function alertFeeModel(d: FlowDeps, code: string, detected: string | undefined) {
  const key = `${d.feeModel}:${code}:${detected ?? "?"}`;
  if (feeModelAlerted.has(key)) return;
  feeModelAlerted.add(key);
  const alert = d.alert ?? ((m: string) => console.error(`[ALERT] ${m}`));
  alert(
    `Panta quote reads fee model ${detected ?? "?"} (${code}) but PANTA_FEE_MODEL=${d.feeModel}. ` +
      "Every copy is refused until this is checked: run scripts/panta-fee-model.mjs.",
  );
}
/** Tests only. */
export function resetFeeModelAlerts() {
  feeModelAlerted.clear();
}

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
  const pin = feePin(d);
  const session = await requireSession(d, request);
  await rateLimit(d, "copyquote", session.uid, QUOTE_RATE_LIMIT);
  const cap = stakeCap(d);
  const { trade, market } = await requireCopyable(d, tradeId);
  const settings = await settingsFor(d, session.uid);
  if (usdcToBase(settings.maxStakeUsdc) > cap) throw stakeAboveCap(cap);
  const now = nowSec(d);

  const cacheKey = `quote:${session.uid}:${trade.id}`;
  const cached = await d.copy.cacheGet<CachedQuote>(cacheKey, now);
  if (
    cached &&
    cached.v === QUOTE_VIEW_VERSION &&
    cached.stake === settings.maxStakeUsdc &&
    cached.slippageBps === settings.slippageBps
  )
    return cached.view;

  // Quote with the stake, detect the fee model, and re-quote smaller if the fee is on top
  // (lib/fee-quote.ts). Market and side from the stored trade, stake from saved settings.
  const stakeBase = usdcToBase(settings.maxStakeUsdc);
  let w: WithinStake<QuoteResponse>;
  try {
    w = await quoteWithinStake(async (amountUsdc) => {
      let r: QuoteResponse;
      try {
        r = await d.panta.quotePrimaryOrder({
          wallet: session.w,
          marketId: trade.marketId,
          side: toApiSide(trade.side),
          amountUsdc,
        });
      } catch (err) {
        fromPanta(err);
      }
      if (r.marketId !== trade.marketId || fromApiSide(r.side) !== trade.side)
        throw new FeeModelError("QUOTE_MISMATCH", "Panta returned a quote for a different order");
      return r;
    }, stakeBase, { pinned: pin.model, feeCapBps: pin.capBps });
  } catch (err) {
    if (!(err instanceof FeeModelError)) throw err;
    d.log?.(`copy quote refused: ${err.code}${err.detected ? ` (${err.detected})` : ""}`);
    if (err.code === "FEE_MODEL_MISMATCH" || err.code === "FEE_MODEL_UNKNOWN") alertFeeModel(d, err.code, err.detected ?? undefined);
    if (err.code === "QUOTE_MISMATCH") throw new AuthError(502, "PANTA_ERROR", err.message);
    throw new AuthError(502, err.code, err.message);
  }
  const q = w.quote;
  const limitBase = copyUsdcLimitBase(stakeBase); // the cap is the stake, in every model
  if (w.outflowBase > limitBase) throw new AuthError(500, "ERROR", "Outflow above stake");
  let amounts: ReturnType<typeof copyAmounts>;
  try {
    amounts = copyAmounts({
      feeModel: w.model,
      depositUsdc: usdcExact(w.depositBase),
      feeUsdc: q.feeUsdc,
      avgPrice: q.avgPrice,
      shares: q.shares,
      slippageBps: settings.slippageBps,
    });
  } catch {
    throw new AuthError(502, "PANTA_ERROR", "Panta returned a quote we can't show honestly. Try again.");
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
    amountUsdc: usdcExact(w.depositBase),
    shares: q.shares,
    avgPrice: q.avgPrice,
    feeUsdc: q.feeUsdc,
    feeModel: w.model,
    totalUsdc: amounts.total,
    maxUsdcOut: usdcExact(limitBase),
    slippageBps: settings.slippageBps,
    validUntil,
  };
  const tok: QuoteToken = {
    uid: session.uid,
    tradeId: trade.id,
    stake: settings.maxStakeUsdc,
    slippageBps: settings.slippageBps,
    quote: q,
    feeModel: w.model,
    firstModel: w.firstModel,
    depositUsdc: fromMicro(w.depositBase, 6),
    feeUsdc: fromMicro(w.feeBase, 6),
    maxUsdcOut: fromMicro(limitBase, 6),
    validUntil,
  };
  await d.copy.cachePut(`qtok:${token}`, tok, validUntil);
  await d.copy.cachePut(
    cacheKey,
    { v: QUOTE_VIEW_VERSION, view, stake: settings.maxStakeUsdc, slippageBps: settings.slippageBps } satisfies CachedQuote,
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
    copyOutflow?: GuardContext["copyOutflow"];
    copyTerms?: GuardContext["copyTerms"];
    claimMinUsdcInBase?: bigint;
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
      | "broadcastSignature"
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
      copyOutflow: a.copyOutflow,
      copyTerms: a.copyTerms,
      claimMinUsdcInBase: a.claimMinUsdcInBase,
    });
    tx = assembleTransaction(a.instructions, a.recentBlockhash, a.wallet);
    sim = await simulateAndCheck(
      d.chain,
      tx,
      a.wallet,
      a.maxUsdcOutBase,
      a.claimMinUsdcInBase ?? 0n,
      d.pantaProgramIds,
    );
  } catch (err) {
    if (err instanceof TxRejected) d.log?.(`${a.kind} build rejected: ${err.code}`);
    asRejection(err);
  }
  if (a.kind === "copy") {
    // Launch cap at the simulation: the limit we simulated against and the measured debit.
    const cap = stakeCap(d);
    if (a.maxUsdcOutBase > cap || sim.usdcDecrease > cap) {
      d.log?.(`copy build rejected: OVER_CAP`);
      throw rejected("the simulation is above the launch cap");
    }
  }
  const messageBytes = tx.message.serialize();
  const now = nowSec(d);
  const order = await d.copy.createPendingOrder({
    ...a.order,
    // D-04: a copy records what the simulation actually debited (exact, 6 dp), not the stake.
    ...(a.kind === "copy" ? { amountUsdc: usdcExact(sim.usdcDecrease) } : {}),
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
      usdcOut: usdcExact(sim.usdcDecrease), // exact (B3-09): never rounded down
      maxUsdcOut: usdcExact(a.maxUsdcOutBase),
      otherAccountsChecked: Math.max(0, sim.accountsChecked - 1),
    },
  };
}

/** POST /api/copy/[tradeId]/build { quoteToken } */
export async function buildCopy(d: FlowDeps, request: Request, tradeId: string): Promise<BuiltTx> {
  assertSameOrigin(request, d.auth.appOrigin);
  const pin = feePin(d);
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

  const cap = stakeCap(d);
  if (usdcToBase(settings.maxStakeUsdc) > cap) throw stakeAboveCap(cap);
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
  // The fee model, deposit and limit come from the quote record, detected at quote time.
  const model = tok.feeModel;
  if (model !== "no_fee" && model !== pin.model) throw quoteExpired(); // the pin changed since the quote
  const deposit = usdcToBase(tok.depositUsdc);
  const fee = usdcToBase(tok.feeUsdc);
  const maxOut = copyUsdcLimitBase(stake);
  const outflow = outflowBase(model, deposit, fee);
  if (maxOut !== usdcToBase(tok.maxUsdcOut) || outflow > maxOut) {
    throw rejected("the quote doesn't fit your max stake");
  }
  if (maxOut > cap || outflow > cap) throw rejected("the order is above the launch cap");
  if (fee > feeCapBase(stake, pin.capBps)) throw rejected("the fee is above the cap");
  if (
    b.wallet !== session.w ||
    b.marketId !== trade.marketId ||
    fromApiSide(b.side) !== trade.side ||
    usdcToBase(b.amountUsdc) !== deposit ||
    usdcToBase(b.feeUsdc) !== usdcToBase(tok.quote.feeUsdc) ||
    b.quoteId !== tok.quote.quoteId
  ) {
    throw rejected("Panta built a different order than the one quoted");
  }
  // D-02: the on-chain minimum must be at least the "Min. shares" the review showed.
  let minSharesBase: bigint;
  try {
    minSharesBase = toMicro(
      copyAmounts({
        feeModel: model,
        depositUsdc: usdcExact(deposit),
        feeUsdc: tok.quote.feeUsdc,
        avgPrice: tok.quote.avgPrice,
        shares: tok.quote.shares,
        slippageBps: tok.slippageBps,
      }).minShares,
    );
  } catch {
    throw rejected("the quote can't be checked");
  }
  let expectedBase: bigint;
  try {
    expectedBase = toMicro(b.expectedShares);
  } catch {
    throw rejected("Panta built an order with unreadable shares");
  }
  if (expectedBase <= 0n || expectedBase < minSharesBase)
    throw rejected("Panta built an order for fewer shares than the review shows");
  // Hard total: fee and slippage stay inside the stake; the guard checks the actual outflow.
  const built = await assembleAndStore(d, {
    kind: "copy",
    uid: session.uid,
    wallet: session.w,
    marketId: trade.marketId,
    instructions: b.instructions,
    recentBlockhash: b.recentBlockhash,
    lastValidBlockHeight: b.lastValidBlockHeight ?? null,
    maxUsdcOutBase: maxOut,
    copyOutflow: { model, depositBase: deposit, feeBase: fee },
    copyTerms: { side: toApiSide(trade.side), maxSlippageBps: settings.slippageBps, minSharesBase },
    order: {
      leaderTradeId: trade.id,
      side: trade.side,
      amountUsdc: usdcExact(outflow), // replaced by the simulated debit in assembleAndStore (D-04)
      feeUsdc: usdcExact(fee), // exact, 6 dp (D-04)
      feeModel: model,
      maxUsdcOut: usdcExact(maxOut),
      shares: b.expectedShares,
      quoteId: tok.quote.quoteId,
      pantaOrderId: b.orderId,
    },
  });
  await d.copy.cacheDelete(`quote:${session.uid}:${trade.id}`);
  return built;
}

// ---------------------------------------------------------------- claim build

/**
 * E-04: the claim minimum is not Panta's `winningShares` alone. It is the
 * largest of:
 *  - winningShares from the claim build;
 *  - the on-chain position, when the chain reader can decode it (mock chain;
 *    the real program's position layout is unverified, so real mode skips it);
 *  - a guaranteed lower bound from OUR recorded copies of this market and the
 *    winning side: each copy got at least expectedShares x (1 - max slippage).
 * And Panta must agree with itself: the positions endpoint has to list the same
 * claimable shares. A build that understates any of these is refused. 1 USDC
 * per winning share, no claim fee (Panta documents none).
 */
async function independentClaimMin(
  d: FlowDeps,
  session: { uid: string; w: string },
  marketId: string,
  side: TradeSide,
  winning: bigint,
): Promise<bigint> {
  let positions: PositionsResponse;
  try {
    positions = await d.panta.getPositions(session.w);
  } catch (err) {
    fromPanta(err);
  }
  const listed = positions.positions.filter(
    (p) => p.marketId === marketId && fromApiSide(p.side) === side && p.claimable && !p.claimed,
  );
  const listedBase = listed.reduce((n, p) => n + usdcToBase(p.shares), 0n);
  if (listed.length === 0 || listedBase !== winning) {
    d.log?.(`claim build CLAIM_MISMATCH (positions)`);
    throw rejected("Panta's claim doesn't match your position");
  }
  let min = winning;
  // G-05: in real mode the payout floor must come from an on-chain position read. Until a reader
  // for Panta's position account exists (its layout isn't documented, and we won't guess it), the
  // claim build fails closed instead of trusting Panta's winningShares alone.
  let onChain: bigint | null = null;
  if (d.chain.getPositionSharesBase) {
    try {
      onChain = await d.chain.getPositionSharesBase(marketId, session.w, toApiSide(side));
    } catch {
      onChain = null;
    }
  }
  if (onChain === null && !d.mock) {
    d.log?.(`claim build CLAIM_UNVERIFIED (no on-chain position reader)`);
    throw new AuthError(
      503,
      "CLAIM_UNVERIFIED",
      "Claiming through Copycall isn't available yet: we can't verify your winnings on-chain. You can claim directly on Panta.",
    );
  }
  if (onChain !== null) {
    if (onChain !== winning) {
      d.log?.(`claim build CLAIM_MISMATCH (on-chain position)`);
      throw rejected("Panta's claim doesn't match your on-chain position");
    }
    if (onChain > min) min = onChain;
  }
  const copies = (await d.copy.listCopies(session.uid, 500)).filter((c) => c.marketId === marketId && c.side === side);
  const recordedMin = copies.reduce(
    (n, c) => n + (usdcToBase(c.shares) * BigInt(10_000 - MAX_SLIPPAGE_BPS)) / 10_000n,
    0n,
  );
  if (recordedMin > winning) {
    d.log?.(`claim build CLAIM_MISMATCH (recorded copies)`);
    throw rejected("Panta's claim is smaller than the copies you recorded here");
  }
  return min;
}

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
  const claimMin = await independentClaimMin(d, session, marketId, fromApiSide(c.outcome), usdcToBase(c.winningShares));

  const built = await assembleAndStore(d, {
    kind: "claim",
    uid: session.uid,
    wallet: session.w,
    marketId,
    instructions: c.instructions,
    recentBlockhash: c.recentBlockhash,
    lastValidBlockHeight: c.lastValidBlockHeight ?? null,
    maxUsdcOutBase: 0n, // a claim may never move USDC out of the wallet
    claimMinUsdcInBase: claimMin, // B3-03 / E-04: must pay at least this into the user's own USDC ATA
    order: {
      leaderTradeId: null,
      side: fromApiSide(c.outcome),
      amountUsdc: usdcExact(claimMin),
      feeUsdc: "0",
      feeModel: null,
      maxUsdcOut: "0",
      shares: usdcExact(claimMin), // confirm requires a landed payout >= this
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
    // B3-07: the real report status, not an unconditional true.
    const reported = await d.copy.isReported(order.id);
    return { status: "confirmed", signature: order.signature!, reported, simulated: d.mock, kind };
  }
  // B3-06: a failed order (e.g. marked expired just as it landed) may be re-verified on chain
  // by signature. Every landed-transaction check below runs again before anything is recorded.
  const revive = order.status === "failed";
  if (revive && !("signature" in body))
    throw new AuthError(409, "TX_FAILED", "This transaction failed. Nothing was recorded. Start again.");

  const now = nowSec(d);
  let signature: string;
  let simulated = false;
  let justSent = false;

  if ("signedTransaction" in body) {
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    } catch {
      throw rejected("unreadable transaction");
    }
    const msg = tx.message.serialize();
    // The wallet must sign OUR bytes. A wallet that edits the transaction is refused.
    if (sha256Hex(msg) !== order.messageHash) throw rejected("it doesn't match the one we checked. Nothing was sent.");
    // G-07: a non-canonical S (S >= L) would pass tweetnacl and give the same tx a second signature string.
    if (tx.signatures.length !== 1 || !isCanonicalSignature(tx.signatures[0]))
      throw rejected("it isn't signed by your wallet. Nothing was sent.");
    if (!nacl.sign.detached.verify(msg, tx.signatures[0], bs58.decode(session.w))) {
      throw rejected("it isn't signed by your wallet. Nothing was sent.");
    }
    signature = bs58.encode(tx.signatures[0]);
    if (order.broadcastSignature === signature) {
      // E-02: already broadcast once; never say "Nothing was sent" now. Just look it up again.
    } else {
      if (now > order.expiresAt) throw quoteExpired("Quote expired, refresh. Nothing was sent.");
      if (await d.copy.signatureUsed(signature))
        throw new AuthError(409, "SIGNATURE_USED", "This transaction was already recorded");
      // E-02: remember the signature BEFORE broadcasting, so a lost response can still be confirmed.
      await d.copy.noteBroadcast(order.id, signature);
      await broadcastWithRetry(d, order, tx);
      justSent = true;
    }
  } else if ("signature" in body) {
    // E-02: the signature we broadcast stays checkable while the tx is retrievable.
    const window = body.signature === order.broadcastSignature ? BROADCAST_LOOKUP_SEC : ORDER_LOOKUP_SEC;
    if (now > order.createdAt + window)
      throw new AuthError(409, "ORDER_EXPIRED", "This order is too old to confirm. Start again.");
    signature = body.signature;
    if (!isCanonicalSignatureB58(signature)) throw rejected("that isn't a valid signature");
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
  if (!simulated && !justSent && order.broadcastSignature === signature && !revive) {
    // G-03: the signature we broadcast, looked up again: re-send the same bytes if it was lost.
    await maybeResend(d, order, signature);
  }
  // G-02: rejections are only "definite" (fail the order) for the signature WE broadcast. A user
  // pasting some other signature can't kill their own pending order.
  const definite = order.broadcastSignature === signature || "signedTransaction" in body;
  return verifyAndRecord(d, order, { uid: session.uid, wallet: session.w }, signature, {
    simulated,
    revive,
    definite,
  });
}

/** G-03: how many times one order's signed bytes may be broadcast in total. */
export const MAX_SENDS = 4;

/** A send error the RPC returned as a refusal (preflight), as opposed to a lost/ambiguous network error. */
function sendRefused(m: string): boolean {
  return /failed to send transaction|simulation failed|blockhash not found|signature verification|invalid transaction|transaction.*(rejected|refused)|insufficient/i.test(
    m,
  );
}

function blockhashOf(order: PendingOrder): string | null {
  try {
    return VersionedMessage.deserialize(Buffer.from(order.messageBase64, "base64")).recentBlockhash;
  } catch {
    return null;
  }
}

async function stillValid(d: FlowDeps, order: PendingOrder): Promise<boolean> {
  const bh = blockhashOf(order);
  if (!bh) return false;
  try {
    return await d.chain.isBlockhashValid(bh);
  } catch {
    return false;
  }
}

/**
 * G-03: the first broadcast. A definite refusal is retried with the SAME signed bytes (bounded,
 * only while the blockhash is valid). If it is still refused, the order is failed (so the sweep
 * can never re-send it later) and the user is told nothing was spent. An ambiguous error (lost
 * response, timeout) leaves the order pending and goes on to verification.
 */
async function broadcastWithRetry(d: FlowDeps, order: PendingOrder, tx: VersionedTransaction): Promise<void> {
  const raw = tx.serialize();
  let lastError = "";
  while (await d.copy.noteSendAttempt(order.id, MAX_SENDS)) {
    try {
      await d.chain.send(raw);
      return;
    } catch (err) {
      const m = err instanceof Error ? err.message : "";
      if (/already (been )?processed/i.test(m)) return;
      lastError = m;
      if (!sendRefused(m)) {
        d.log?.(`${order.kind} broadcast unclear (${m.slice(0, 120)}); verifying`);
        return;
      }
      d.log?.(`${order.kind} broadcast refused: ${m.slice(0, 200)}`);
      if (!(await stillValid(d, order))) break;
      await new Promise((r) => setTimeout(r, d.resendDelayMs ?? 500));
    }
  }
  // Refused every time (or the blockhash ran out): refused sends never reach a leader.
  await d.copy.failOrder(order.id);
  d.log?.(`${order.kind} broadcast gave up: ${lastError.slice(0, 120)}`);
  throw rejected("the network refused it. Nothing was spent.");
}

/**
 * G-03: a broadcast we can't find on chain is re-sent (same signed bytes, rebuilt from the stored
 * message and the signature we already verified against it), while its blockhash is valid, at most
 * MAX_SENDS times in total. Never throws: verification decides what happened.
 */
async function maybeResend(d: FlowDeps, order: PendingOrder, signature: string): Promise<boolean> {
  try {
    if (await d.chain.getLandedTransaction(signature)) return false;
    if (!(await stillValid(d, order))) return false;
    if (!(await d.copy.noteSendAttempt(order.id, MAX_SENDS))) return false;
    const message = VersionedMessage.deserialize(Buffer.from(order.messageBase64, "base64"));
    const tx = new VersionedTransaction(message, [bs58.decode(signature)]);
    await d.chain.send(tx.serialize());
    d.log?.(`${order.kind} re-sent ${signature.slice(0, 8)}…`);
    return true;
  } catch (err) {
    d.log?.(`${order.kind} re-send ${signature.slice(0, 8)}…: ${(err instanceof Error ? err.message : "").slice(0, 120)}`);
    return false;
  }
}

/** VERIFY_UNAVAILABLE carries what the client needs to keep checking (E-02). */
function verifyUnavailable(orderId: string, signature: string): AuthError {
  return new AuthError(502, "VERIFY_UNAVAILABLE", "We couldn't verify the transaction yet. We'll keep checking.", {
    orderId,
    signature,
    retryable: true,
  });
}

/**
 * Wait for the tx, verify it ON CHAIN (never trust what the client sent) and
 * record it atomically. Shared by confirm and the pending-order sweep (E-02).
 */
async function verifyAndRecord(
  d: FlowDeps,
  order: PendingOrder,
  owner: { uid: string; wallet: string },
  signature: string,
  opts: { simulated: boolean; revive: boolean; definite?: boolean },
): Promise<ConfirmResult> {
  const { kind } = order;
  const { simulated, revive } = opts;
  const state = await d.chain.waitForConfirmation(
    signature,
    order.lastValidBlockHeight,
    d.confirmTimeoutMs ?? 20_000,
    blockhashOf(order) ?? undefined,
  );
  // B3-06: "expired" is decided from a block height read after the status read; the tx may have
  // landed in between. Look it up once more before calling it expired.
  if (state === "expired" && !(await d.chain.getLandedTransaction(signature))) {
    await d.copy.failOrder(order.id);
    // F-04: carries the signature, so the client re-checks it (bounded) through the revive path in
    // case it landed after all; the cron sweep doesn't revive failed orders.
    throw new AuthError(
      409,
      "QUOTE_EXPIRED",
      "The transaction expired before it landed, so nothing should have been spent. We're double-checking.",
      { orderId: order.id, signature, revivable: true },
    );
  }
  if (state === "pending") return { status: "pending", signature };

  const landed = await d.chain.getLandedTransaction(signature);
  if (!landed) return { status: "pending", signature };
  // G-02: for the signature we broadcast, a landed tx that doesn't match the order is a definite
  // rejection: fail the order so it isn't swept forever.
  const definitely = async (e: AuthError): Promise<never> => {
    if (opts.definite) await d.copy.failOrder(order.id);
    throw e;
  };
  try {
    checkMessageShape(landed.message, owner.wallet); // signer / fee payer == the order's wallet
  } catch {
    await definitely(rejected("it wasn't signed by your wallet"));
  }
  if (landed.signatures[0] !== signature) await definitely(rejected("signature mismatch"));
  if (sha256Hex(landed.message.serialize()) !== order.messageHash)
    await definitely(rejected("it isn't the transaction we built for you"));
  try {
    checkLandedPrograms(landed.message, d.pantaProgramIds);
  } catch (err) {
    if (opts.definite) await d.copy.failOrder(order.id);
    asRejection(err);
  }
  if (landed.err !== null) {
    await d.copy.failOrder(order.id);
    throw new AuthError(422, "TX_FAILED", "Transaction failed on-chain. Nothing was copied.");
  }
  // B3-04: every program the landed transaction reached through CPI must be allowlisted.
  if (landed.innerPrograms === undefined || landed.innerPrograms === null) {
    d.log?.(`${kind} confirm: no inner instructions for ${signature.slice(0, 8)}…`);
    throw verifyUnavailable(order.id, signature);
  }
  try {
    checkInnerPrograms(landed.innerPrograms, d.pantaProgramIds);
  } catch (err) {
    d.log?.(`ALERT ${kind} confirm UNEXPECTED_CPI for ${signature.slice(0, 8)}…`);
    await d.copy.failOrder(order.id);
    asRejection(err);
  }
  // F-01: no inner System instruction assigned, allocated or created the wallet, and the
  // wallet is still a plain System account now.
  if (landed.innerSystemOps === undefined || landed.innerSystemOps === null) {
    d.log?.(`${kind} confirm: no inner System instructions for ${signature.slice(0, 8)}…`);
    throw verifyUnavailable(order.id, signature);
  }
  let walletNow: Awaited<ReturnType<Chain["getWalletAccount"]>>;
  try {
    walletNow = await d.chain.getWalletAccount(owner.wallet);
  } catch {
    throw verifyUnavailable(order.id, signature);
  }
  try {
    checkInnerSystemOps(landed.innerSystemOps, owner.wallet);
    if (walletNow === null) {
      // H-01: no wallet account now (e.g. drained to 0 after landing): we can't tell it wasn't
      // re-owned and closed, so never record it as fine. Retryable, with an alert.
      (d.alert ?? ((m: string) => console.error(`[ALERT] ${m}`)))(
        `${kind} confirm WALLET_MISSING for ${signature.slice(0, 8)}… (wallet ${owner.wallet.slice(0, 6)}…): not recorded yet`,
      );
      throw verifyUnavailable(order.id, signature);
    }
    checkWalletAccount(walletNow);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const code = err instanceof TxRejected ? err.code : "WALLET_OWNER";
    (d.alert ?? ((m: string) => console.error(`[ALERT] ${m}`)))(
      `${kind} confirm ${code} for ${signature.slice(0, 8)}… (wallet ${owner.wallet.slice(0, 6)}…): not recorded`,
    );
    await d.copy.failOrder(order.id);
    asRejection(err);
  }

  // D-03 / B3-03: what actually moved, from the landed transaction's own token balances.
  const moved = landed.payerUsdcOutBase;
  if (moved === undefined || moved === null) {
    d.log?.(`${kind} confirm: no token balances for ${signature.slice(0, 8)}…`);
    throw verifyUnavailable(order.id, signature);
  }
  // Orders built before max_usdc_out existed: a copy's amount was its full limit; claims never pay out.
  let limit =
    order.maxUsdcOut !== null ? usdcToBase(order.maxUsdcOut) : kind === "copy" ? usdcToBase(order.amountUsdc) : 0n;
  if (kind === "copy") {
    // Launch cap at confirm. Unknown cap (misconfigured) stays retryable, never "no limit".
    if (d.maxStakeCapBase === null || d.maxStakeCapBase <= 0n) {
      d.log?.(`copy confirm: MAX_STAKE_USDC not configured; ${signature.slice(0, 8)}… stays pending`);
      throw verifyUnavailable(order.id, signature);
    }
    if (d.maxStakeCapBase < limit) limit = d.maxStakeCapBase;
  }
  const tooLittle = kind === "claim" && -moved < usdcToBase(order.shares);
  if (moved > limit || tooLittle) {
    d.log?.(`${kind} confirm ${moved > limit ? "OVER_LIMIT" : "PAYOUT_TOO_LOW"} for ${signature.slice(0, 8)}…`);
    await d.copy.failOrder(order.id);
    throw moved > limit
      ? new AuthError(422, "OVER_LIMIT", "This transaction moved more USDC than you approved. It was not recorded.")
      : new AuthError(422, "PAYOUT_TOO_LOW", "This claim didn't pay your winnings to your wallet. It was not recorded.");
  }
  // Atomic in the DB (complete_order locks the row; UNIQUE order_id / signature back it up).
  let result = await d.copy.completeOrder(order.id, owner.uid, signature, { allowFailed: revive });
  if (result === "not_pending" && !revive) {
    // F-04: the order was failed concurrently (e.g. an expiry check racing this confirm) after we
    // verified the landed transaction above. Every check passed for THIS signature, which is the
    // only valid signature over the stored message, so record it through the revive path.
    const now = await d.copy.getPendingOrder(order.id);
    if (now?.status === "failed") {
      d.log?.(`${kind} confirm: order failed concurrently; reviving verified ${signature.slice(0, 8)}…`);
      result = await d.copy.completeOrder(order.id, owner.uid, signature, { allowFailed: true });
    }
  }
  if (result === "already_confirmed") {
    // A concurrent confirm of the same signature recorded it first: idempotent, no second record or report.
    return { status: "confirmed", signature, reported: await d.copy.isReported(order.id), simulated, kind };
  }
  if (result === "signature_used") throw new AuthError(409, "SIGNATURE_USED", "This transaction was already recorded");
  if (result === "not_pending")
    throw new AuthError(409, "ORDER_NOT_PENDING", "This order was already handled", { orderId: order.id, signature, revivable: true });

  // Recorded. Now attribute it with Panta (idempotent per signature). A failure is
  // retried by the alerts cron (lib/report-retry.ts, B3-07).
  const reported =
    (await reportOnce(d, {
      kind,
      orderId: order.id,
      signature,
      wallet: owner.wallet,
      marketId: order.marketId,
      quoteId: order.quoteId,
      attempts: 1,
    })) === "reported";
  await d.copy.cacheDelete(`positions:${owner.wallet}`);
  return { status: "confirmed", signature, reported, simulated, kind };
}

export const SWEEP = { limit: 20, minAgeSec: 60, maxAttempts: 30, budgetMs: 60_000 };
export type SweepSummary = {
  checked: number;
  confirmed: number;
  pending: number;
  failed: number;
  unavailable: number;
  /** G-02: orders failed because they hit SWEEP.maxAttempts without landing. */
  gaveUp: number;
  /** Orders claimed but not reached within SWEEP.budgetMs (they keep their turn order). */
  skipped: number;
};

/**
 * E-02 cron step: pending orders whose signature we broadcast but never
 * verified (lost response, VERIFY_UNAVAILABLE, closed tab) are verified and
 * recorded server-side, with exactly the checks confirm runs.
 * G-02: least recently swept first, each claim bumps an attempt counter, and an order that
 * still hasn't landed after SWEEP.maxAttempts is failed (it stays revivable by signature).
 * G-03: an order not found on chain is re-sent while its blockhash is valid (bounded).
 */
export async function sweepBroadcastOrders(d: FlowDeps): Promise<SweepSummary> {
  const now = nowSec(d);
  const started = Date.now();
  const claimed = await d.copy.claimBroadcastSweep({
    limit: SWEEP.limit,
    createdBefore: now - SWEEP.minAgeSec,
    createdAfter: now - BROADCAST_LOOKUP_SEC,
    maxAttempts: SWEEP.maxAttempts,
  });
  const out: SweepSummary = {
    checked: claimed.length,
    confirmed: 0,
    pending: 0,
    failed: 0,
    unavailable: 0,
    gaveUp: 0,
    skipped: 0,
  };
  const alert = d.alert ?? ((m: string) => console.error(`[ALERT] ${m}`));
  const giveUp = async (o: PendingOrder, why: string) => {
    await d.copy.failOrder(o.id);
    out.gaveUp++;
    alert(`sweep gave up on ${o.kind} ${o.id.slice(0, 8)} after ${SWEEP.maxAttempts} checks (${why})`);
  };
  for (const { order: o, attempts } of claimed) {
    if (!o.broadcastSignature) continue;
    if (Date.now() - started > SWEEP.budgetMs) {
      out.skipped++;
      continue;
    }
    const last = attempts >= SWEEP.maxAttempts;
    try {
      await maybeResend(d, o, o.broadcastSignature);
      // G-01: timeout 0 still means one status read (see Chain.waitForConfirmation).
      const r = await verifyAndRecord(
        { ...d, confirmTimeoutMs: 0 },
        o,
        { uid: o.userId, wallet: o.wallet },
        o.broadcastSignature,
        { simulated: false, revive: false, definite: true },
      );
      if (r.status === "confirmed") out.confirmed++;
      else if (last) await giveUp(o, "never landed");
      else out.pending++;
    } catch (err) {
      const code = err instanceof AuthError ? err.code : "error";
      if (code === "VERIFY_UNAVAILABLE") {
        if (last) await giveUp(o, "unverifiable");
        else out.unavailable++;
      } else out.failed++;
      d.log?.(`sweep ${o.kind} ${o.id.slice(0, 8)}: ${code}`);
    }
  }
  return out;
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
    amountUsdc: string; // total, fee included
    feeUsdc: string | null;
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
      feeUsdc: c.feeUsdc,
      shares: c.shares,
      signature: c.signature,
      createdAt: c.createdAt,
      reported: c.status === "reported",
    })),
  };
}
