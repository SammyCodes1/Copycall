/**
 * Copy amounts: one model shared by the review screen, the share estimate,
 * the server quote/build checks and the transaction guard. Pure, no imports,
 * safe for the client bundle.
 *
 * Hard rule (security decision, Sep 2026): the max stake the user approves is
 * the TOTAL the transaction may move out of their wallet, fee included.
 *
 * Panta's docs don't say whether the quoted fee is inside the deposit or added
 * on top, so we detect it from each quote's own numbers (classifyFeeModel):
 *  - "inclusive": shares ~ (amount - fee) / avgPrice; the wallet pays amount.
 *  - "on_top":    shares ~ amount / avgPrice;         the wallet pays amount + fee.
 *  - "no_fee":    fee is 0; both models agree; the wallet pays amount.
 * Anything else (both match, neither matches) is refused.
 *
 * The expected model is PINNED per deployment (PANTA_FEE_MODEL); a quote that
 * contradicts the pin is refused, never treated as the other model. With the
 * fee on top, the server re-quotes once with deposit = stake - fee and requires
 * deposit + re-quoted fee <= stake (lib/fee-quote.ts). Slippage never adds
 * USDC. The guard's cap is the stake itself in every model.
 */

const SCALE = 1_000_000n; // 6 decimals for USDC, prices and shares

/** "5.00" -> 5_000_000n. Plain non-negative decimals only; digits past 6 dp are dropped (rounded down). */
export function toMicro(v: string): bigint {
  const m = /^(\d{1,12})(?:\.(\d{1,6})\d*)?$/.exec(v.trim());
  if (!m) throw new Error(`Invalid amount: ${v}`);
  return BigInt(m[1]) * SCALE + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** 16_292_601n -> "16.29" (dp decimals, rounded down so we never overstate). */
export function fromMicro(v: bigint, dp = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const unit = 10n ** BigInt(6 - dp);
  const whole = a / SCALE;
  const frac = (a % SCALE) / unit;
  return `${neg ? "-" : ""}${whole}${dp > 0 ? "." + frac.toString().padStart(dp, "0") : ""}`;
}

/** Exact USDC for display: at least 2 dp, more only when needed ("0.10", "0.105"). Never rounds. */
export function usdcExact(v: bigint): string {
  const full = fromMicro(v, 6);
  return full.replace(/(\.\d{2}\d*?)0+$/, "$1");
}

export type FeeModel = "inclusive" | "on_top" | "no_fee";
export type FeeModelResult = FeeModel | "ambiguous" | "unknown";

/**
 * Tolerance for matching a quote's shares against a model's prediction:
 * 0.01 share (Panta rounds shares to 2 dp) plus 5 bps of the prediction
 * (avgPrice is rounded to 6 dp). A 2% fee separates the models by ~200 bps.
 */
export const FEE_MODEL_TOLERANCE_BPS = 5n;
export const FEE_MODEL_TOLERANCE_ABS = 10_000n; // 0.01 share in micro-units

function tolerance(predicted: bigint): bigint {
  return FEE_MODEL_TOLERANCE_ABS + (predicted * FEE_MODEL_TOLERANCE_BPS) / 10_000n;
}
function withinTolerance(actual: bigint, predicted: bigint): boolean {
  const diff = actual > predicted ? actual - predicted : predicted - actual;
  return diff <= tolerance(predicted);
}

/**
 * Q-01: does the quote's share count fit this model's prediction (within tolerance)? Used only to
 * resolve an "ambiguous" classification under an explicit PANTA_FEE_MODEL pin. False on odd numbers.
 */
export function quoteFitsFeeModel(
  q: { amountUsdc: string; feeUsdc: string; avgPrice: string; shares: string },
  model: "inclusive" | "on_top",
): boolean {
  let amount: bigint, fee: bigint, price: bigint, shares: bigint;
  try {
    [amount, fee, price, shares] = [toMicro(q.amountUsdc), toMicro(q.feeUsdc), toMicro(q.avgPrice), toMicro(q.shares)];
  } catch {
    return false;
  }
  if (amount <= 0n || price <= 0n || price > SCALE || shares <= 0n || fee <= 0n || fee >= amount) return false;
  const predicted = model === "on_top" ? (amount * SCALE) / price : ((amount - fee) * SCALE) / price;
  return withinTolerance(shares, predicted);
}

/** Which fee model a quote's own numbers fit. Pure; never throws on odd numbers (returns "unknown"). */
export function classifyFeeModel(q: { amountUsdc: string; feeUsdc: string; avgPrice: string; shares: string }): {
  model: FeeModelResult;
  inclusiveShares: string | null;
  onTopShares: string | null;
} {
  let amount: bigint, fee: bigint, price: bigint, shares: bigint;
  try {
    [amount, fee, price, shares] = [toMicro(q.amountUsdc), toMicro(q.feeUsdc), toMicro(q.avgPrice), toMicro(q.shares)];
  } catch {
    return { model: "unknown", inclusiveShares: null, onTopShares: null };
  }
  if (amount <= 0n || price <= 0n || price > SCALE || shares <= 0n || fee >= amount)
    return { model: "unknown", inclusiveShares: null, onTopShares: null };
  const inc = ((amount - fee) * SCALE) / price;
  const top = (amount * SCALE) / price;
  const out = { inclusiveShares: fromMicro(inc, 6), onTopShares: fromMicro(top, 6) };
  const a = withinTolerance(shares, inc);
  const b = withinTolerance(shares, top);
  if (fee === 0n) return { model: a ? "no_fee" : "unknown", ...out };
  // The two predictions must be at least twice the combined tolerance apart, or
  // rounding could make a quote look like either: refuse those as ambiguous.
  if (a && b) return { model: "ambiguous", ...out };
  if (top - inc <= 2n * (tolerance(inc) + tolerance(top))) return { model: "ambiguous", ...out };
  if (a) return { model: "inclusive", ...out };
  if (b) return { model: "on_top", ...out };
  return { model: "unknown", ...out };
}

/** USDC (base units) the wallet pays for a deposit under a fee model. */
export function outflowBase(model: FeeModel, depositBase: bigint, feeBase: bigint): bigint {
  return model === "on_top" ? depositBase + feeBase : depositBase;
}

/**
 * The most USDC (base units) a copy transaction may move out of the wallet: the
 * approved max stake, fee included, in every fee model. The model only changes
 * what deposit we ask Panta for; it never raises (or lowers) this cap.
 */
export function copyUsdcLimitBase(maxStakeBase: bigint): bigint {
  return maxStakeBase;
}

/**
 * Smallest max stake a user may save (USDC). 2, not 1 (Q-01): under 2 USDC Panta's ~2% fee is
 * too small for the quote to separate the fee models reliably. Shared by the Settings form and the
 * API schema (lib/schemas.ts).
 */
export const MIN_STAKE_USDC = 2;

/** Default fee sanity cap (D-01): a quote or build fee above 5% of the stake is refused. */
export const DEFAULT_FEE_CAP_BPS = 500;
export const MAX_FEE_CAP_BPS = 1_000;

/** Fee cap in base units for a stake: floor(stake x bps / 10_000). */
export function feeCapBase(stakeBase: bigint, capBps: number): bigint {
  return (stakeBase * BigInt(capBps)) / 10_000n;
}

export type CopyQuoteNumbers = {
  feeModel: FeeModel;
  depositUsdc: string; // amountUsdc sent to Panta (the stake, or stake - fee when the fee is on top)
  feeUsdc: string;
  avgPrice: string;
  shares: string; // Panta's estimate
  slippageBps: number;
};

export type CopyAmounts = {
  totalBase: bigint; // what leaves the wallet, fee included
  feeBase: bigint;
  toSharesBase: bigint;
  total: string; // "5.00"
  fee: string; // "0.10"
  toShares: string; // "4.90"
  estShares: string; // "16.29"
  minShares: string; // "15.96" at the slippage cap
  slippagePct: string; // "2.00%"
};

/**
 * Break a quote down the way the guard sees it. Throws when the quote can't
 * fit the model (fee missing, negative or not smaller than the deposit).
 *
 * The share estimate is (USDC that buys shares) / avgPrice, rounded down, and
 * never more than Panta's own `shares`, so the screen can't promise more than either.
 */
export function copyAmounts(q: CopyQuoteNumbers): CopyAmounts {
  const depositBase = toMicro(q.depositUsdc);
  const feeBase = toMicro(q.feeUsdc);
  if (depositBase <= 0n) throw new Error("Deposit must be positive");
  if (feeBase >= depositBase) throw new Error("Fee is not smaller than the deposit");
  if (q.feeModel === "no_fee" && feeBase !== 0n) throw new Error("no_fee with a fee");
  const price = toMicro(q.avgPrice);
  if (price <= 0n || price > SCALE) throw new Error("Price must be in (0, 1]");
  if (!Number.isInteger(q.slippageBps) || q.slippageBps < 0 || q.slippageBps > 10_000)
    throw new Error("Invalid slippage");

  const totalBase = outflowBase(q.feeModel, depositBase, feeBase);
  const toSharesBase = q.feeModel === "on_top" ? depositBase : depositBase - feeBase;
  const implied = (toSharesBase * SCALE) / price; // micro-shares, rounded down
  const panta = toMicro(q.shares);
  const est = implied < panta ? implied : panta;
  const cent = 10_000n; // 0.01 share
  const estCents = (est / cent) * cent;
  const minShares = (estCents * BigInt(10_000 - q.slippageBps)) / 10_000n;
  return {
    totalBase,
    feeBase,
    toSharesBase,
    total: usdcExact(totalBase),
    fee: usdcExact(feeBase),
    toShares: usdcExact(toSharesBase),
    estShares: fromMicro(estCents),
    minShares: fromMicro(minShares),
    slippagePct: `${(q.slippageBps / 100).toFixed(2)}%`,
  };
}

/** "5.00 USDC total, including a 0.10 USDC fee" */
export function totalWithFeeText(total: string, fee: string): string {
  return `${total} USDC total, including a ${fee} USDC fee`;
}

/** "5.00 USDC total (0.10 fee)" for compact lists; the fee is omitted when unknown (old rows). */
export function totalWithFeeShort(total: string, fee: string | null): string {
  return fee === null ? `${total} USDC total` : `${total} USDC total (${fee} fee)`;
}
