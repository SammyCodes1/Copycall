/**
 * The fee model shared by the review screen, the share estimate and the guard:
 * the approved max stake is the hard total, fee included; slippage costs shares, not USDC.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { CopyReview, type CopyReviewData } from "@/components/CopyReview";
import {
  copyAmounts,
  copyUsdcLimitBase,
  DEFAULT_FEE_CAP_BPS,
  feeCapBase,
  fromMicro,
  toMicro,
  totalWithFeeShort,
  totalWithFeeText,
  usdcExact,
} from "@/lib/copy-math";

// The numbers from shots/b3-copy-review-390.png.
const SHOT = {
  feeModel: "inclusive" as const,
  depositUsdc: "5.00",
  feeUsdc: "0.10",
  avgPrice: "0.300750",
  shares: "16.29",
  slippageBps: 200,
};

describe("copy amounts", () => {
  it("takes the fee out of the stake: 5.00 total = 0.10 fee + 4.90 for shares", () => {
    const a = copyAmounts(SHOT);
    expect(a).toMatchObject({ total: "5.00", fee: "0.10", toShares: "4.90", slippagePct: "2.00%" });
    expect(a.feeBase + a.toSharesBase).toBe(a.totalBase);
  });

  it("estimates shares as (total - fee) / price: 16.29, not the fee-on-top 16.62", () => {
    expect(copyAmounts(SHOT).estShares).toBe("16.29");
    // With no fee inside, 5.00 would buy 16.62 (rounded down); that's the fee-on-top reading.
    expect(copyAmounts({ ...SHOT, feeUsdc: "0", shares: "99" }).estShares).toBe("16.62");
    // A quote claiming the fee-on-top number is capped at what 4.90 USDC can buy.
    expect(copyAmounts({ ...SHOT, shares: "16.62" }).estShares).toBe("16.29");
    // And never more than Panta's own estimate.
    expect(copyAmounts({ ...SHOT, shares: "16.00" }).estShares).toBe("16.00");
  });

  it("slippage lowers the minimum shares and never raises the USDC total", () => {
    const a = copyAmounts(SHOT);
    expect(a.minShares).toBe("15.96"); // 16.29 * 0.98, rounded down
    for (const bps of [0, 100, 200, 500]) {
      const b = copyAmounts({ ...SHOT, slippageBps: bps });
      expect(b.totalBase).toBe(a.totalBase);
      expect(toMicro(b.minShares)).toBeLessThanOrEqual(toMicro(b.estShares));
    }
    expect(copyAmounts({ ...SHOT, slippageBps: 0 }).minShares).toBe("16.29");
  });

  it("on top: a 4.90 deposit + 0.10 fee shows the same 5.00 total and 4.90 for shares", () => {
    const a = copyAmounts({ ...SHOT, feeModel: "on_top", depositUsdc: "4.90", shares: "16.29" });
    expect(a).toMatchObject({ total: "5.00", fee: "0.10", toShares: "4.90", estShares: "16.29" });
  });

  it("guard cap == max stake in every model; the total including the fee never exceeds it", () => {
    for (const [stake, fee] of [
      ["5.00", "0.10"],
      ["1.00", "0.02"],
      ["50.00", "1.00"],
      ["7.33", "0.146600"],
    ]) {
      const s = toMicro(stake);
      const f = toMicro(fee);
      expect(copyUsdcLimitBase(s)).toBe(s);
      for (const a of [
        copyAmounts({ ...SHOT, depositUsdc: stake, feeUsdc: fee }),
        copyAmounts({ ...SHOT, feeModel: "on_top", depositUsdc: usdcExact(s - f), feeUsdc: fee }),
      ]) {
        expect(a.totalBase).toBeLessThanOrEqual(copyUsdcLimitBase(s));
        expect(a.totalBase).toBe(s);
      }
    }
  });

  it("D-01 fee cap: 500 bps of the stake by default", () => {
    expect(DEFAULT_FEE_CAP_BPS).toBe(500);
    expect(feeCapBase(toMicro("5.00"), 500)).toBe(toMicro("0.25"));
    expect(feeCapBase(toMicro("5.00"), 300)).toBe(toMicro("0.15"));
  });

  it("refuses quotes that can't fit the model", () => {
    expect(() => copyAmounts({ ...SHOT, feeUsdc: "5.00" })).toThrow();
    expect(() => copyAmounts({ ...SHOT, feeUsdc: "6.00" })).toThrow();
    expect(() => copyAmounts({ ...SHOT, feeUsdc: "-0.10" })).toThrow();
    expect(() => copyAmounts({ ...SHOT, depositUsdc: "0" })).toThrow();
    expect(() => copyAmounts({ ...SHOT, feeModel: "no_fee" })).toThrow();
    expect(() => copyAmounts({ ...SHOT, avgPrice: "0" })).toThrow();
    expect(() => copyAmounts({ ...SHOT, avgPrice: "1.5" })).toThrow();
    expect(() => copyAmounts({ ...SHOT, slippageBps: 1.5 })).toThrow();
  });

  it("shows odd fees exactly instead of rounding them away", () => {
    expect(usdcExact(105_000n)).toBe("0.105");
    expect(usdcExact(5_000_000n)).toBe("5.00");
    expect(copyAmounts({ ...SHOT, feeUsdc: "0.105" })).toMatchObject({ fee: "0.105", toShares: "4.895" });
    expect(fromMicro(16_292_601n)).toBe("16.29");
  });
});

describe("wording", () => {
  it("says total, including the fee", () => {
    expect(totalWithFeeText("5.00", "0.10")).toBe("5.00 USDC total, including a 0.10 USDC fee");
    expect(totalWithFeeShort("5.00", "0.10")).toBe("5.00 USDC total (0.10 fee)");
    expect(totalWithFeeShort("5.00", null)).toBe("5.00 USDC total");
  });

  it("the review card shows total, fee, amount for shares, estimate and minimum; never 'plus the fee'", () => {
    const c: CopyReviewData = {
      leader: "2UqHDhTNCV9HD3ZAeHjRtSBkyWsB2x3Uzzc8WmWbUELj",
      leaderHitRate: 0.86,
      leaderCalls: 7,
      title: "Will USDC supply exceed 80B by November?",
      side: "no",
      leaderShares: "46.71",
      leaderTime: 1_000,
      isCreatorTrade: false,
      depositUsdc: SHOT.depositUsdc,
      feeModel: SHOT.feeModel,
      avgPrice: SHOT.avgPrice,
      shares: SHOT.shares,
      feeUsdc: SHOT.feeUsdc,
      slippageBps: SHOT.slippageBps,
    };
    const html = renderToStaticMarkup(createElement(CopyReview, { c, nowSec: 1_060 })).replace(/<!-- -->/g, "");
    const text = html.replace(/<[^>]+>/g, "|");
    for (const s of [
      "You pay in total",
      "fee included, within your max stake",
      "5.00 USDC",
      "included in the total",
      "0.10 USDC",
      "4.90 USDC",
      "4.90 ÷ price",
      "16.29",
      "costs shares, never extra USDC",
      "15.96",
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toMatch(/plus the fee/i);
    expect(text).not.toContain("16.62");
  });
});
