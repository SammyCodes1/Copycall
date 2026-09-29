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
import { randomBytes, randomUUID } from "node:crypto";
import marketsJson from "@/fixtures/markets.json";
import positionsJson from "@/fixtures/positions.json";
import tradesJson from "@/fixtures/trades.json";
import { PantaError } from "../panta-error";
import type {
  PantaMarket,
  PantaPosition,
  PantaTradeRow,
  Phase,
  Side,
} from "../schemas";

const markets = marketsJson as unknown as PantaMarket[];
const trades = tradesJson as unknown as PantaTradeRow[];
const positions = positionsJson as unknown as Record<string, PantaPosition[]>;

/** Fake program id used in mock instructions (never a real program). */
export const MOCK_PROGRAM_ID = "MockPanta1111111111111111111111111111111111";

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
  const start = p.cursor ? Math.max(0, filtered.findIndex((m) => m.marketId === p.cursor)) : 0;
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

export function getWalletTrades(wallet: string, limit: number) {
  return { wallet, items: trades.filter((t) => t.wallet === wallet).slice(0, limit) };
}

export function getPositions(wallet: string) {
  return { wallet, positions: positions[wallet] ?? [] };
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
  expiresAtMs: number;
};

const g = globalThis as unknown as { __copycallMockQuotes?: Map<string, MockQuote> };
const quotes = (g.__copycallMockQuotes ??= new Map());

export function quotePrimaryOrder(req: { wallet: string; marketId: string; side: Side; amountUsdc: string }) {
  const m = findMarket(req.marketId);
  if (m.phase !== "primary") throw new PantaError(400, "MARKET_NOT_IN_PRIMARY", "Market is not in primary (mock)");
  const amount = Number(req.amountUsdc);
  if (amount < 1) throw new PantaError(400, "AMOUNT_TOO_SMALL", "Amount below minimum fill (mock)");
  const spot = Number((req.side === "yes" ? m.primaryYesPrice : m.primaryNoPrice) ?? "0.5");
  const fee = amount * 0.02;
  // Bonding curve: average fill is a little worse than spot, more so for bigger buys.
  const avg = Math.min(0.99, spot * (1 + Math.min(0.08, amount / 2000)));
  const shares = (amount - fee) / avg;
  const q: MockQuote = {
    quoteId: `qt_mock_${randomUUID()}`,
    wallet: req.wallet,
    marketId: req.marketId,
    side: req.side,
    amountUsdc: amount.toFixed(2),
    shares: shares.toFixed(2),
    avgPrice: avg.toFixed(6),
    feeUsdc: fee.toFixed(2),
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

export function buildPrimaryOrder(req: { quoteId: string; wallet: string; maxSlippageBps: number }) {
  const q = quotes.get(req.quoteId);
  if (!q || q.expiresAtMs < Date.now()) throw new PantaError(400, "QUOTE_EXPIRED", "Quote expired (mock)");
  if (q.wallet !== req.wallet) throw new PantaError(401, "UNAUTHORIZED", "Wallet does not match quote (mock)");
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
      {
        programId: MOCK_PROGRAM_ID,
        data: Buffer.from("mock_primary_order_usdc").toString("base64"),
        accounts: [
          { pubkey: q.wallet, isSigner: true, isWritable: true },
          { pubkey: q.marketId, isSigner: false, isWritable: true },
        ],
      },
    ],
    derived: { event: q.marketId },
    recentBlockhash: bs58.encode(randomBytes(32)),
    lastValidBlockHeight: 1,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    blockhashExpiryHintSec: 60,
  };
}

export function buildClaim(req: { wallet: string; marketId: string }) {
  findMarket(req.marketId);
  const pos = (positions[req.wallet] ?? []).find((p) => p.marketId === req.marketId && p.claimable);
  if (!pos || !pos.outcome) throw new PantaError(400, "NOT_CLAIMABLE", "Nothing to claim (mock)");
  return {
    wallet: req.wallet,
    marketId: req.marketId,
    outcome: pos.outcome.toUpperCase(),
    winningShares: pos.shares,
    instructions: [
      {
        programId: MOCK_PROGRAM_ID,
        data: Buffer.from("mock_claim_win_usdc").toString("base64"),
        accounts: [{ pubkey: req.wallet, isSigner: true, isWritable: true }],
      },
    ],
    derived: {},
    recentBlockhash: bs58.encode(randomBytes(32)),
    lastValidBlockHeight: 1,
  };
}

export function reportTrade(req: { signature: string; wallet: string; marketId: string }) {
  findMarket(req.marketId);
  return { signature: req.signature, status: "processed", marketId: req.marketId, wallet: req.wallet, kind: "buy" as const };
}
