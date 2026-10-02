/**
 * Quote a copy so that the total leaving the wallet, fee included, never
 * exceeds the approved max stake, under the deployment's PINNED fee model.
 *
 * 1. Quote with amountUsdc = stake. Classify the quote's own numbers
 *    (lib/copy-math.ts classifyFeeModel). Ambiguous or unknown: refuse.
 *    A model that contradicts the pin (PANTA_FEE_MODEL): refuse. We never
 *    switch models because Panta's numbers say so.
 * 2. Fee above the cap (stake x feeCapBps / 10_000, D-01): refuse.
 * 3. Pinned inclusive (or no fee): build from this quote; the wallet pays the stake.
 * 4. Pinned on top: re-quote ONCE with deposit = floor_cents(stake - fee).
 *    The re-quote must also read as on top (E-08: not no_fee), its fee must be
 *    under the cap and no higher than the first quote's, and deposit +
 *    re-quoted fee must be <= stake. Otherwise refuse. (Price drift between the
 *    two quotes is bounded by the slippage limit and the min-shares check.)
 *    We don't assume the fee is monotone in the amount.
 *
 * Pure apart from the injected quote function, so the check script
 * (scripts/panta-fee-model.mjs) and the tests run exactly this logic.
 */
import {
  classifyFeeModel,
  feeCapBase,
  fromMicro,
  outflowBase,
  toMicro,
  type FeeModel,
  type FeeModelResult,
} from "./copy-math";

export type PinnedFeeModel = "inclusive" | "on_top";
export type QuoteLike = { amountUsdc: string | number; feeUsdc: string; avgPrice: string; shares: string };

export type FeeModelErrorCode = "FEE_MODEL_UNKNOWN" | "FEE_MODEL_MISMATCH" | "FEE_TOO_HIGH" | "QUOTE_MISMATCH";

export class FeeModelError extends Error {
  constructor(
    readonly code: FeeModelErrorCode,
    message: string,
    readonly detected: FeeModelResult | null = null,
  ) {
    super(message);
  }
}

export type WithinStake<Q> = {
  quote: Q; // the quote to build from
  model: FeeModel; // "no_fee" or the pinned model
  firstModel: FeeModelResult; // what the stake-sized quote classified as
  depositBase: bigint; // amountUsdc of `quote`
  feeBase: bigint;
  outflowBase: bigint; // what the wallet pays, fee included (<= stake)
  quotes: number; // Panta quote calls made (1 or 2)
};

const toApiAmount = (base: bigint) => fromMicro(base, 2);
const floorCents = (base: bigint) => (base / 10_000n) * 10_000n;

export async function quoteWithinStake<Q extends QuoteLike>(
  quote: (amountUsdc: string) => Promise<Q>,
  stakeBase: bigint,
  opts: { pinned: PinnedFeeModel; feeCapBps: number },
): Promise<WithinStake<Q>> {
  if (stakeBase <= 0n) throw new FeeModelError("FEE_TOO_HIGH", "Max stake must be positive");
  const cap = feeCapBase(stakeBase, opts.feeCapBps);
  let calls = 0;
  const ask = async (depositBase: bigint) => {
    const q = await quote(toApiAmount(depositBase));
    calls++;
    let amount: bigint | null = null;
    try {
      amount = toMicro(String(q.amountUsdc));
    } catch {
      /* handled below */
    }
    if (amount !== depositBase) throw new FeeModelError("QUOTE_MISMATCH", "Panta returned a quote for a different amount");
    let feeBase: bigint;
    try {
      feeBase = toMicro(q.feeUsdc);
    } catch {
      throw new FeeModelError("FEE_MODEL_UNKNOWN", "Panta's quote has no readable fee");
    }
    if (feeBase > cap) {
      throw new FeeModelError(
        "FEE_TOO_HIGH",
        `Panta's fee is above ${(opts.feeCapBps / 100).toFixed(2)}% of your stake, so we won't build it. Nothing was sent.`,
      );
    }
    const model = classifyFeeModel({ ...q, amountUsdc: String(q.amountUsdc) }).model;
    return { q, feeBase, model };
  };
  const mismatch = (detected: FeeModelResult) =>
    new FeeModelError(
      "FEE_MODEL_MISMATCH",
      "Panta's quote doesn't match the fee model this server expects, so we won't build it. Nothing was sent.",
      detected,
    );

  const first = await ask(stakeBase);
  if (first.model === "ambiguous" || first.model === "unknown") {
    throw new FeeModelError(
      "FEE_MODEL_UNKNOWN",
      first.model === "ambiguous"
        ? "We can't tell from Panta's quote whether the fee is inside your stake or on top, so we won't build it. Nothing was sent."
        : "Panta's quote doesn't match a fee model we can verify, so we won't build it. Nothing was sent.",
      first.model,
    );
  }
  const result = (q: Q, model: FeeModel, depositBase: bigint, feeBase: bigint): WithinStake<Q> => {
    const out = outflowBase(model, depositBase, feeBase);
    if (out > stakeBase) throw new FeeModelError("FEE_TOO_HIGH", "The fee doesn't fit in your max stake");
    return { quote: q, model, firstModel: first.model, depositBase, feeBase, outflowBase: out, quotes: calls };
  };

  if (first.model === "no_fee") return result(first.q, "no_fee", stakeBase, 0n);
  if (first.model !== opts.pinned) throw mismatch(first.model);
  if (first.model === "inclusive") return result(first.q, "inclusive", stakeBase, first.feeBase);

  // Pinned on top: one re-quote with the fee taken out of the stake.
  const deposit = floorCents(stakeBase - first.feeBase);
  if (deposit <= 0n) throw new FeeModelError("FEE_TOO_HIGH", "The fee doesn't fit in your max stake");
  const second = await ask(deposit);
  // E-08: under the on-top pin the re-quote must also be on top, with a fee no higher than the first.
  if (second.model !== "on_top") throw mismatch(second.model);
  if (deposit + second.feeBase > stakeBase) {
    throw new FeeModelError(
      "FEE_TOO_HIGH",
      "With the fee on top, this copy wouldn't fit in your max stake. Nothing was sent.",
    );
  }
  if (second.feeBase > first.feeBase)
    throw new FeeModelError("FEE_TOO_HIGH", "Panta's fee went up on the re-quote, so we won't build it. Nothing was sent.");
  return result(second.q, "on_top", deposit, second.feeBase);
}
