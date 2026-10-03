/**
 * zod schemas for every Panta response we consume and for our own request bodies.
 *
 * Panta shapes were verified against https://docs.panta.market (llms.txt and the
 * API reference pages) on 2026-09-29. Fields the docs mark as `string | number`
 * are accepted as either. Where the docs are ambiguous about casing
 * (e.g. claim `outcome: "YES"` vs positions `outcome: "yes"`) we normalise to
 * lowercase. Unknown extra fields are stripped, not rejected, so additive API
 * changes don't break sync.
 *
 * This file has no secrets and no server-only import, so it can be shared with tests.
 */
import bs58 from "bs58";
import { z } from "zod";

// ---------- primitives ----------

/** Decode base58 and check byte length (32 = pubkey, 64 = signature). */
function isBase58OfLength(value: string, bytes: number): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  try {
    return bs58.decode(value).length === bytes;
  } catch {
    return false;
  }
}

/** A base58 Solana public key (wallet, market/event PDA, program id). */
export const PubkeySchema = z
  .string()
  .min(32)
  .max(44)
  .refine((v) => isBase58OfLength(v, 32), "Invalid Solana public key");

/** A base58 Solana transaction signature. */
export const SignatureSchema = z
  .string()
  .min(64)
  .max(88)
  .refine((v) => isBase58OfLength(v, 64), "Invalid Solana signature");

/** Docs: some numeric fields are "string | number". */
export const StringOrNumber = z.union([z.string(), z.number()]);

/** Human-readable decimal USDC amount, e.g. "20.00" (primary buy format per docs). */
export const DecimalUsdcSchema = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,6})?$/, "Amount must be a decimal string like 20.00");

/** yes/no, case-insensitive on input, lowercase on output. */
export const SideSchema = z
  .string()
  .transform((s) => s.toLowerCase())
  .pipe(z.enum(["yes", "no"]));
export type Side = z.infer<typeof SideSchema>;

/** Market phase per docs: primary | secondary | resolved | cancelled. */
export const PhaseSchema = z.enum(["primary", "secondary", "resolved", "cancelled"]);
export type Phase = z.infer<typeof PhaseSchema>;

// ---------- markets (GET /markets/, GET /markets/{marketId}/) ----------
// https://docs.panta.market/api-reference/markets/list
// https://docs.panta.market/api-reference/markets/get

const nullablePrice = z.string().nullable().optional();

export const MarketSchema = z.object({
  marketId: PubkeySchema, // "Event / market address" - this IS the market address
  category: z.string().nullable().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  images: z.array(z.string()).nullable().optional(),
  phase: PhaseSchema,
  marketType: z.string().nullable().optional(), // "standard" | "breaking"
  startTime: z.number().int().nullable().optional(),
  endTime: z.number().int().nullable().optional(),
  resolutionTime: z.number().int().nullable().optional(),
  region: z.string().nullable().optional(),
  resolved: z.boolean(),
  status: z.string(), // catalog status label, e.g. "open" (NOT the phase)
  volumeUsdc: StringOrNumber.nullable().optional(),
  campaignId: z.string().nullable().optional(),
  createdByPartner: z.boolean(), // true only if OUR API account created it. Not the creator flag.
  yesPrice: nullablePrice,
  noPrice: nullablePrice,
  primaryYesPrice: nullablePrice,
  primaryNoPrice: nullablePrice,
  secondaryYesPrice: nullablePrice,
  secondaryNoPrice: nullablePrice,
});
export type PantaMarket = z.infer<typeof MarketSchema>;

export const MarketListResponseSchema = z.object({
  items: z.array(MarketSchema),
  nextCursor: z.string().nullable().optional(),
});
export type MarketListResponse = z.infer<typeof MarketListResponseSchema>;

// ---------- trades (GET /markets/{id}/trades/, GET /wallets/{wallet}/trades/) ----------
// https://docs.panta.market/api-reference/markets/trades
// https://docs.panta.market/api-reference/markets/wallet-trades

export const TradeRowSchema = z.object({
  id: StringOrNumber,
  marketId: PubkeySchema,
  wallet: PubkeySchema,
  isPrimary: z.boolean(),
  yesAmount: StringOrNumber,
  noAmount: StringOrNumber,
  feePaid: StringOrNumber,
  blockTime: z.number().int().nullable(),
  signature: SignatureSchema,
  quoteAsset: z.string().optional(),
});
export type PantaTradeRow = z.infer<typeof TradeRowSchema>;

export const MarketTradesResponseSchema = z.object({
  marketId: z.string(),
  items: z.array(TradeRowSchema),
});
export type MarketTradesResponse = z.infer<typeof MarketTradesResponseSchema>;

export const WalletTradesResponseSchema = z.object({
  wallet: z.string(),
  items: z.array(TradeRowSchema),
});
export type WalletTradesResponse = z.infer<typeof WalletTradesResponseSchema>;

// ---------- positions (GET /positions/?wallet=) ----------
// https://docs.panta.market/api-reference/positions

export const PositionSchema = z.object({
  marketId: PubkeySchema,
  category: z.string().nullable().optional(),
  side: SideSchema,
  shares: z.string(),
  phase: PhaseSchema,
  claimable: z.boolean(),
  claimed: z.boolean(),
  outcome: SideSchema.nullable().optional(), // yes/no after resolution, else null
});
export type PantaPosition = z.infer<typeof PositionSchema>;

export const PositionsResponseSchema = z.object({
  wallet: z.string(),
  positions: z.array(PositionSchema),
});
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;

// ---------- instructions (build responses) ----------

export const InstructionSchema = z.object({
  programId: PubkeySchema,
  data: z.string(), // base64
  accounts: z.array(
    z.object({
      pubkey: PubkeySchema,
      isSigner: z.boolean(),
      isWritable: z.boolean(),
    }),
  ),
});
export type PantaInstruction = z.infer<typeof InstructionSchema>;

// ---------- primary buy (POST /primaryorderquote/, POST /primaryorderbuild/) ----------
// https://docs.panta.market/api-reference/orders/quote
// https://docs.panta.market/api-reference/orders/build

export const QuoteRequestSchema = z.object({
  wallet: PubkeySchema,
  marketId: PubkeySchema,
  side: SideSchema,
  amountUsdc: DecimalUsdcSchema,
  userId: z.string().max(128).optional(),
});
export type QuoteRequest = z.input<typeof QuoteRequestSchema>;

export const QuoteResponseSchema = z.object({
  quoteId: z.string().min(1),
  marketId: z.string(),
  side: SideSchema,
  amountUsdc: StringOrNumber,
  shares: z.string(),
  avgPrice: z.string(),
  feeUsdc: z.string(),
  expiresAt: z.string(),
  blockhashExpiryHintSec: z.number().optional(),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

/** Our own hard slippage cap (hard requirement 4): 5% even though Panta allows 5000 bps. */
export const MAX_SLIPPAGE_BPS = 500;
export const DEFAULT_SLIPPAGE_BPS = 200;

export const BuildRequestSchema = z.object({
  quoteId: z.string().min(1).max(128),
  wallet: PubkeySchema,
  userId: z.string().max(128).optional(),
  maxSlippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS),
});
export type BuildRequest = z.input<typeof BuildRequestSchema>;

export const BuildResponseSchema = z.object({
  orderId: z.string().min(1),
  quoteId: z.string(),
  wallet: PubkeySchema,
  marketId: PubkeySchema,
  side: SideSchema,
  amountUsdc: StringOrNumber,
  expectedShares: z.string(),
  feeUsdc: z.string(),
  status: z.string(),
  instructions: z.array(InstructionSchema).min(1),
  derived: z.record(z.string(), z.string()).optional(),
  recentBlockhash: z.string().min(32),
  lastValidBlockHeight: z.number().int().optional(),
  expiresAt: z.string().optional(),
  blockhashExpiryHintSec: z.number().optional(),
});
export type BuildResponse = z.infer<typeof BuildResponseSchema>;

// ---------- claims (POST /claim/build/) ----------
// https://docs.panta.market/api-reference/claims/build

export const ClaimBuildRequestSchema = z.object({
  wallet: PubkeySchema,
  marketId: PubkeySchema,
});
export type ClaimBuildRequest = z.input<typeof ClaimBuildRequestSchema>;

export const ClaimBuildResponseSchema = z.object({
  wallet: PubkeySchema,
  marketId: PubkeySchema,
  outcome: SideSchema, // docs example shows "YES"; normalised to lowercase
  winningShares: z.string(),
  instructions: z.array(InstructionSchema).min(1),
  derived: z.record(z.string(), z.string()).optional(),
  recentBlockhash: z.string().min(32),
  lastValidBlockHeight: z.number().int().optional(),
});
export type ClaimBuildResponse = z.infer<typeof ClaimBuildResponseSchema>;

// ---------- report trade (POST /trades/) ----------
// https://docs.panta.market/api-reference/trades/report

export const ReportTradeRequestSchema = z.object({
  signature: SignatureSchema,
  wallet: PubkeySchema,
  marketId: PubkeySchema,
  quoteId: z.string().max(128).optional(),
  clientOrderId: z.string().max(128).optional(),
  userId: z.string().max(128).optional(),
});
export type ReportTradeRequest = z.input<typeof ReportTradeRequestSchema>;

export const ReportTradeResponseSchema = z.object({
  signature: z.string(),
  status: z.string(), // "processed" when stored
  marketId: z.string().optional(),
  wallet: z.string().optional(),
  side: SideSchema.optional(),
  kind: z.enum(["buy", "claim"]).optional(),
});
export type ReportTradeResponse = z.infer<typeof ReportTradeResponseSchema>;

// ---------- error envelope ----------
// https://docs.panta.market/guides/errors

export const PantaErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  field: z.string().optional(),
  // Kept as-is (any shape) so a malformed `fields` doesn't hide Panta's code; only its names are
  // ever printed, by describeError (lib/panta-error.ts).
  fields: z.unknown().optional(),
});

// ---------- our own auth request bodies ----------

export const NonceRequestSchema = z.object({ wallet: PubkeySchema }).strict();

export const VerifyRequestSchema = z
  .object({
    wallet: PubkeySchema,
    nonce: z.string().regex(/^[A-Za-z0-9]{16,64}$/),
    signature: SignatureSchema, // base58 ed25519 signature of the SIWS message
  })
  .strict();

// ---------- follow + settings (our own routes) ----------

export const FollowRequestSchema = z.object({ wallet: PubkeySchema }).strict();

/** Per-copy stake limits (USDC). Panta rejects tiny fills; 1000 keeps a demo account safe. */
export const MIN_STAKE_USDC = 1;
export const MAX_STAKE_USDC = 1000;

export const SettingsRequestSchema = z
  .object({
    // Decimal string or number, at most 2 dp; normalised to "12.50".
    maxStakeUsdc: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .pipe(z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, "Max stake must be a USDC amount like 5 or 12.50"))
      .transform((v) => Number(v))
      .refine((n) => n >= MIN_STAKE_USDC && n <= MAX_STAKE_USDC, `Max stake must be ${MIN_STAKE_USDC}-${MAX_STAKE_USDC} USDC`)
      .transform((n) => n.toFixed(2)),
    // Hard requirement 4: server-side cap of 500 bps (5%), whatever the client sends.
    slippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS, "Slippage can't exceed 5%"),
    alertsEnabled: z.boolean(),
  })
  .strict();
export type SettingsRequest = z.infer<typeof SettingsRequestSchema>;

// ---------- copy and claim flows (our own routes) ----------

const Uuid = z.string().uuid();

/** POST /api/copy/[tradeId]/build. Only the quote token: amount, side and market come from the server. */
export const CopyBuildRequestSchema = z.object({ quoteToken: Uuid }).strict();

/** POST /api/claim/build */
export const ClaimBuildBodySchema = z.object({ marketId: PubkeySchema }).strict();

/**
 * POST /api/copy/confirm and /api/claim/confirm. Exactly one of:
 *  - signedTransaction: the exact bytes we built, signed by the wallet (base64)
 *  - signature: a retry for an already-broadcast transaction
 *  - simulated: mock mode only
 */
export const ConfirmRequestSchema = z.union([
  z.object({ orderId: Uuid, signedTransaction: z.string().min(100).max(1700).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  z.object({ orderId: Uuid, signature: SignatureSchema }).strict(),
  z.object({ orderId: Uuid, simulated: z.literal(true) }).strict(),
]);
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;
