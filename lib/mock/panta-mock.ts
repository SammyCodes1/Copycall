import "server-only";
/**
 * MOCK_PANTA=true implementation of every lib/panta.ts function.
 * Reads the generated fixtures in /fixtures (see scripts/gen-fixtures.mjs) and
 * mimics documented Panta behaviour (page sizes, 200-row caps, error codes).
 * Outputs are re-validated by the same zod schemas in lib/panta.ts.
 *
 * Only reachable through lib/panta.ts after isMockMode(), which refuses to run
 * on a Vercel production deployment.
 */
import bs58 from "bs58";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import marketsJson from "@/fixtures/markets.json";
import positionsJson from "@/fixtures/positions.json";
import tradesJson from "@/fixtures/trades.json";
import { PantaError } from "../panta-error";
import {
  ATA_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  associatedTokenAddress,
  usdcToBase,
} from "../solana-constants";
import { anchorDiscriminator } from "../tx-guard";
import { MOCK_PROGRAM_ID, getSharedMockChain, mockPositionPda, mockVault } from "./chain-mock";
import type { PantaMarket, PantaPosition, PantaTradeRow, Phase, Side } from "../schemas";

const markets = marketsJson as unknown as PantaMarket[];
const trades = tradesJson as unknown as PantaTradeRow[];
const positions = positionsJson as unknown as Record<string, PantaPosition[]>;

export { MOCK_PROGRAM_ID };

function findMarket(marketId: string): PantaMarket {
  const m = markets.find((x) => x.marketId === marketId);
  if (!m) throw new PantaError(404, "MARKET_NOT_FOUND", "Market not found (mock)");
  return m;
}

/** List rows have null prices per docs; detail fills them. */
function toListRow(m: PantaMarket): PantaMarket {
  return {
    ...m,
    yesPrice: null,
    noPrice: null,
    primaryYesPrice: null,
    primaryNoPrice: null,
    secondaryYesPrice: null,
    secondaryNoPrice: null,
  };
}

export function listMarkets(p: { status?: Phase; cursor?: string; limit: number }) {
  const filtered = p.status ? markets.filter((m) => m.phase === p.status) : markets;
  const start = p.cursor
    ? Math.max(
        0,
        filtered.findIndex((m) => m.marketId === p.cursor),
      )
    : 0;
  const page = filtered.slice(start, start + p.limit);
  const next = filtered[start + p.limit];
  return { items: page.map(toListRow), nextCursor: next ? next.marketId : null };
}

export function getMarket(marketId: string) {
  return findMarket(marketId);
}

export function getMarketTrades(marketId: string, limit: number) {
  findMarket(marketId);
  return { marketId, items: trades.filter((t) => t.marketId === marketId).slice(0, limit) };
}

/**
 * Mock "live" activity so alerts can be demoed: every fixture wallet makes one
 * simulated primary buy per minute on a primary-phase fixture market. Rows are
 * deterministic per (wallet, minute), so repeated polls return the same
 * signature and dedupe works exactly like the real tape. Mock mode only, and
 * the whole app shows the MOCK banner.
 */
export const MOCK_LIVE_TRADE_EVERY_SEC = 60;

export function mockLiveTrade(wallet: string, nowMs = Date.now()): PantaTradeRow | null {
  if (!trades.some((t) => t.wallet === wallet)) return null;
  const open = markets.filter((m) => m.phase === "primary");
  if (open.length === 0) return null;
  const bucket = Math.floor(nowMs / 1000 / MOCK_LIVE_TRADE_EVERY_SEC);
  const h = createHash("sha512").update(`copycall-mock-live:${wallet}:${bucket}`).digest();
  const market = open[h[0] % open.length];
  const shares = (5 + (h.readUInt16BE(1) % 9500) / 100).toFixed(2);
  const yes = h[3] % 2 === 0;
  return {
    id: `live-${bucket}-${h.readUInt32BE(4)}`,
    marketId: market.marketId,
    wallet,
    isPrimary: true,
    yesAmount: yes ? shares : "0",
    noAmount: yes ? "0" : shares,
    feePaid: (Number(shares) * 0.01).toFixed(2),
    blockTime: bucket * MOCK_LIVE_TRADE_EVERY_SEC,
    signature: bs58.encode(h.subarray(0, 64)),
    quoteAsset: "USDC",
  };
}

export function getWalletTrades(wallet: string, limit: number) {
  const live = mockLiveTrade(wallet);
  const rows = trades.filter((t) => t.wallet === wallet);
  return { wallet, items: (live ? [live, ...rows] : rows).slice(0, limit) };
}

export function getPositions(wallet: string) {
  // Fixture traders keep their fixture positions. Any other wallet (a demo
  // user) gets positions from the mock chain: its simulated copies plus one
  // resolved win and one loss so the claim flow is demoable.
  const fixture = positions[wallet];
  return { wallet, positions: fixture ?? getSharedMockChain().positionsOf(wallet) };
}

// ---- simulated primary buy sessions ----

type MockQuote = {
  quoteId: string;
  wallet: string;
  marketId: string;
  side: Side;
  amountUsdc: string;
  shares: string;
  avgPrice: string;
  feeUsdc: string;
  feeModel: MockFeeModel;
  expiresAtMs: number;
};

/**
 * Which Panta fee model the mock plays (MOCK_PANTA_FEE_MODEL, read per quote):
 *  - "inclusive" (default): the fee comes out of amountUsdc; the wallet pays amountUsdc.
 *  - "on_top": shares are priced on the full amountUsdc; the wallet pays amountUsdc + fee.
 * Real Panta's model isn't documented; Copycall detects it from each quote.
 */
export type MockFeeModel = "inclusive" | "on_top";
export function mockFeeModel(): MockFeeModel {
  const v = (process.env.MOCK_PANTA_FEE_MODEL ?? "").trim().toLowerCase();
  return v === "on_top" ? "on_top" : "inclusive";
}

const g = globalThis as unknown as { __copycallMockQuotes?: Map<string, MockQuote> };
const quotes = (g.__copycallMockQuotes ??= new Map());

export function quotePrimaryOrder(req: { wallet: string; marketId: string; side: Side; amountUsdc: string }) {
  const m = findMarket(req.marketId);
  if (m.phase !== "primary") throw new PantaError(400, "MARKET_NOT_IN_PRIMARY", "Market is not in primary (mock)");
  const amount = Number(req.amountUsdc);
  if (amount < 1) throw new PantaError(400, "AMOUNT_TOO_SMALL", "Amount below minimum fill (mock)");
  const spot = Number((req.side === "yes" ? m.primaryYesPrice : m.primaryNoPrice) ?? "0.5");
  const feeModel = mockFeeModel();
  const fee = Number((amount * 0.02).toFixed(2)); // 2%, in cents
  // Bonding curve: average fill is a little worse than spot, more so for bigger buys.
  const avg = Math.min(0.99, spot * (1 + Math.min(0.08, amount / 2000)));
  const shares = (feeModel === "on_top" ? amount : amount - fee) / avg;
  const q: MockQuote = {
    quoteId: `qt_mock_${randomUUID()}`,
    wallet: req.wallet,
    marketId: req.marketId,
    side: req.side,
    amountUsdc: amount.toFixed(2),
    shares: shares.toFixed(2),
    avgPrice: avg.toFixed(6),
    feeUsdc: fee.toFixed(2),
    feeModel,
    expiresAtMs: Date.now() + 90_000,
  };
  quotes.set(q.quoteId, q);
  return {
    quoteId: q.quoteId,
    marketId: q.marketId,
    side: q.side,
    amountUsdc: q.amountUsdc,
    shares: q.shares,
    avgPrice: q.avgPrice,
    feeUsdc: q.feeUsdc,
    expiresAt: new Date(q.expiresAtMs).toISOString(),
    blockhashExpiryHintSec: 60,
  };
}

// ---- simulated instructions (same shape as real Panta builds) ----

const ix = (programId: string, data: Buffer, accounts: [string, boolean, boolean][]) => ({
  programId,
  data: data.toString("base64"),
  accounts: accounts.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
});
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const computeBudget = () => [
  ix(COMPUTE_BUDGET_PROGRAM_ID, Buffer.concat([Buffer.from([2]), u32(200_000)]), []),
  ix(COMPUTE_BUDGET_PROGRAM_ID, Buffer.concat([Buffer.from([3]), u64(5_000n)]), []),
];
const createUsdcAta = (wallet: string, ata: string) =>
  ix(ATA_PROGRAM_ID, Buffer.from([1]), [
    [wallet, true, true],
    [ata, false, true],
    [wallet, false, false],
    [USDC_MINT, false, false],
    [SYSTEM_PROGRAM_ID, false, false],
    [TOKEN_PROGRAM_ID, false, false],
  ]);
/** A fake but plausible blockhash (base58 of 32 bytes). */
const mockBlockhash = () => bs58.encode(randomBytes(32));

export function buildPrimaryOrder(req: { quoteId: string; wallet: string; maxSlippageBps: number }) {
  const q = quotes.get(req.quoteId);
  if (!q || q.expiresAtMs < Date.now()) throw new PantaError(400, "QUOTE_EXPIRED", "Quote expired (mock)");
  if (q.wallet !== req.wallet) throw new PantaError(401, "UNAUTHORIZED", "Wallet does not match quote (mock)");
  const ata = associatedTokenAddress(q.wallet, USDC_MINT);
  const data = Buffer.concat([
    anchorDiscriminator("primary_order_usdc"),
    u64(usdcToBase(q.amountUsdc)),
    Buffer.from([q.side === "yes" ? 1 : 0]),
    u64(usdcToBase(q.shares)),
    Buffer.from([req.maxSlippageBps & 0xff, req.maxSlippageBps >> 8]),
  ]);
  // MOCK_PANTA_FEE_MODEL=on_top: the fee is a separate SPL transfer on top of the deposit.
  const onTopFee =
    q.feeModel === "on_top"
      ? [
          ix(TOKEN_PROGRAM_ID, Buffer.concat([Buffer.from([3]), u64(usdcToBase(q.feeUsdc))]), [
            [ata, false, true],
            [mockVault(q.marketId), false, true],
            [q.wallet, true, false],
          ]),
        ]
      : [];
  return {
    orderId: `ord_mock_${randomUUID()}`,
    quoteId: q.quoteId,
    wallet: q.wallet,
    marketId: q.marketId,
    side: q.side,
    amountUsdc: q.amountUsdc,
    expectedShares: q.shares,
    feeUsdc: q.feeUsdc,
    status: "built",
    instructions: [
      ...computeBudget(),
      createUsdcAta(q.wallet, ata),
      ix(MOCK_PROGRAM_ID, data, [
        [q.wallet, true, true],
        [q.marketId, false, true],
        [ata, false, true],
        [mockVault(q.marketId), false, true],
        [USDC_MINT, false, false],
        [TOKEN_PROGRAM_ID, false, false],
        [SYSTEM_PROGRAM_ID, false, false],
        [mockPositionPda(q.marketId, q.wallet, q.side), false, true],
      ]),
      ...onTopFee,
    ],
    derived: { event: q.marketId, vaultAuthority: mockVault(q.marketId) },
    recentBlockhash: mockBlockhash(),
    lastValidBlockHeight: 1_000_000,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    blockhashExpiryHintSec: 60,
  };
}

export function buildClaim(req: { wallet: string; marketId: string }) {
  findMarket(req.marketId);
  const pos = getPositions(req.wallet).positions.find((p) => p.marketId === req.marketId && p.claimable);
  if (!pos || !pos.outcome) throw new PantaError(400, "NOT_CLAIMABLE", "Nothing to claim (mock)");
  const ata = associatedTokenAddress(req.wallet, USDC_MINT);
  const data = Buffer.concat([anchorDiscriminator("claim_win_usdc"), u64(usdcToBase(pos.shares))]);
  return {
    wallet: req.wallet,
    marketId: req.marketId,
    outcome: pos.outcome.toUpperCase(),
    winningShares: pos.shares,
    instructions: [
      computeBudget()[0],
      createUsdcAta(req.wallet, ata),
      ix(MOCK_PROGRAM_ID, data, [
        [req.wallet, true, true],
        [req.marketId, false, false],
        [ata, false, true],
        [mockVault(req.marketId), false, true],
        [USDC_MINT, false, false],
        [TOKEN_PROGRAM_ID, false, false],
        [mockPositionPda(req.marketId, req.wallet, pos.side), false, true],
      ]),
    ],
    derived: {
      positionPda: mockPositionPda(req.marketId, req.wallet, pos.side),
      vaultAuthority: mockVault(req.marketId),
    },
    recentBlockhash: mockBlockhash(),
    lastValidBlockHeight: 1_000_000,
  };
}

/** Like Panta: verify the signature on (mock) chain, fail closed, idempotent per signature. */
export function reportTrade(req: { signature: string; wallet: string; marketId: string }) {
  findMarket(req.marketId);
  const chain = getSharedMockChain();
  const landed = chain.state.landed.get(req.signature);
  if (!landed) throw new PantaError(404, "TX_NOT_FOUND", "Signature not found (mock)");
  if (landed.err) throw new PantaError(400, "TX_FAILED", "Transaction failed (mock)");
  const k = chain.landedKind(req.signature);
  if (!k || k.wallet !== req.wallet || k.marketId !== req.marketId)
    throw new PantaError(400, "TX_MISMATCH", "Wrong wallet or market (mock)");
  return {
    signature: req.signature,
    status: "processed",
    marketId: req.marketId,
    wallet: req.wallet,
    side: k.side,
    kind: k.kind,
  };
}
