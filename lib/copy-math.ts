/**
 * Copy amounts: one model shared by the review screen, the share estimate,
 * the server quote/build checks and the transaction guard. Pure, no imports,
 * safe for the client bundle.
 *
 * Fee model (security decision, Sep 2026): the max stake the user approves is
 * the HARD TOTAL the transaction may move out of their wallet, fee included.
 *  - We quote Panta with amountUsdc = max stake. Panta's quote `feeUsdc` is
 *    taken out of that amount, so what buys shares is stake - fee.
 *  - Slippage never adds USDC: the USDC in is fixed, so a moved curve means
 *    fewer shares (or Panta refuses the build with QUOTE_STALE). We show the
 *    minimum shares at the slippage cap instead of any extra USDC.
 *  - The guard's USDC limit (static checks and simulation) is exactly the max
 *    stake. There is no headroom for the fee or for slippage above it.
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

/** The most USDC (base units) a copy transaction may move out of the wallet: the approved max stake, fee included. */
export function copyUsdcLimitBase(maxStakeBase: bigint): bigint {
  return maxStakeBase;
}

export type CopyQuoteNumbers = {
  amountUsdc: string; // what we quoted: the max stake = the total
  feeUsdc: string;
  avgPrice: string;
  shares: string; // Panta's estimate
  slippageBps: number;
};

export type CopyAmounts = {
  totalBase: bigint;
  feeBase: bigint;
  toSharesBase: bigint;
  limitBase: bigint;
  total: string; // "5.00"
  fee: string; // "0.10"
  toShares: string; // "4.90"
  limit: string; // "5.00"
  estShares: string; // "16.29"
  minShares: string; // "15.96" at the slippage cap
  slippagePct: string; // "2.00%"
};

/**
 * Break a quote down the way the guard sees it. Throws when the quote can't
 * fit the model (fee missing, negative or not smaller than the total).
 *
 * The share estimate is (total - fee) / avgPrice, rounded down, and never more
 * than Panta's own `shares`, so the screen can't promise more than either.
 */
export function copyAmounts(q: CopyQuoteNumbers): CopyAmounts {
  const totalBase = toMicro(q.amountUsdc);
  const feeBase = toMicro(q.feeUsdc);
  if (totalBase <= 0n) throw new Error("Stake must be positive");
  if (feeBase >= totalBase) throw new Error("Fee is not smaller than the stake");
  const price = toMicro(q.avgPrice);
  if (price <= 0n || price > SCALE) throw new Error("Price must be in (0, 1]");
  if (!Number.isInteger(q.slippageBps) || q.slippageBps < 0 || q.slippageBps > 10_000)
    throw new Error("Invalid slippage");

  const toSharesBase = totalBase - feeBase;
  const implied = (toSharesBase * SCALE) / price; // micro-shares, rounded down
  const panta = toMicro(q.shares);
  const est = implied < panta ? implied : panta;
  const cent = 10_000n; // 0.01 share
  const estCents = (est / cent) * cent;
  const minShares = (estCents * BigInt(10_000 - q.slippageBps)) / 10_000n;
  const limitBase = copyUsdcLimitBase(totalBase);
  return {
    totalBase,
    feeBase,
    toSharesBase,
    limitBase,
    total: usdcExact(totalBase),
    fee: usdcExact(feeBase),
    toShares: usdcExact(toSharesBase),
    limit: usdcExact(limitBase),
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
