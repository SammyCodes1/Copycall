/**
 * Fee-model detection (inclusive / on top) from a quote's own numbers, and the
 * re-quote that keeps deposit + fee within the max stake. Fails closed otherwise.
 */
import { describe, expect, it } from "vitest";
import { classifyFeeModel, toMicro } from "@/lib/copy-math";
import { feeConfigFromEnv } from "@/lib/fee-config";
import { FeeModelError, quoteWithinStake } from "@/lib/fee-quote";

const PRICE = 0.30075;
/** A fake Panta: fee = rate x amount (cents), shares priced per model. */
function fakePanta(model: "inclusive" | "on_top", opts: { rate?: number; feeFn?: (a: number) => number } = {}) {
  const calls: string[] = [];
  const quote = async (amountUsdc: string) => {
    calls.push(amountUsdc);
    const a = Number(amountUsdc);
    const fee = opts.feeFn ? opts.feeFn(a) : Number((a * (opts.rate ?? 0.02)).toFixed(2));
    const shares = (model === "on_top" ? a : a - fee) / PRICE;
    return { amountUsdc, feeUsdc: fee.toFixed(2), avgPrice: PRICE.toFixed(6), shares: shares.toFixed(2) };
  };
  return { quote, calls };
}

describe("classifyFeeModel", () => {
  it("inclusive: shares = (amount - fee) / price (the b3 screenshot)", () => {
    expect(classifyFeeModel({ amountUsdc: "5.00", feeUsdc: "0.10", avgPrice: "0.300750", shares: "16.29" }).model).toBe(
      "inclusive",
    );
  });
  it("on top: shares = amount / price", () => {
    expect(classifyFeeModel({ amountUsdc: "5.00", feeUsdc: "0.10", avgPrice: "0.300750", shares: "16.63" }).model).toBe(
      "on_top",
    );
    // Panta's own docs example (20.00 in, 0.40 fee, 0.5208, 38.42 shares) reads as on top.
    expect(classifyFeeModel({ amountUsdc: "20.00", feeUsdc: "0.40", avgPrice: "0.520800", shares: "38.42" }).model).toBe(
      "on_top",
    );
  });
  it("no fee: both models agree", () => {
    expect(classifyFeeModel({ amountUsdc: "5.00", feeUsdc: "0", avgPrice: "0.300750", shares: "16.62" }).model).toBe(
      "no_fee",
    );
  });
  it("ambiguous: a fee too small to tell the models apart", () => {
    expect(
      classifyFeeModel({ amountUsdc: "5.00", feeUsdc: "0.001", avgPrice: "0.300750", shares: "16.62" }).model,
    ).toBe("ambiguous");
    // Even when only one prediction matches, predictions closer than 2x the combined tolerance are refused.
    expect(
      classifyFeeModel({ amountUsdc: "5.00", feeUsdc: "0.008", avgPrice: "0.300750", shares: "16.60" }).model,
    ).toBe("ambiguous");
  });
  it("unknown: matches neither model, or junk", () => {
    const base = { amountUsdc: "5.00", feeUsdc: "0.10", avgPrice: "0.300750" };
    expect(classifyFeeModel({ ...base, shares: "16.45" }).model).toBe("unknown"); // in between
    expect(classifyFeeModel({ ...base, shares: "15.90" }).model).toBe("unknown"); // fee taken twice
    expect(classifyFeeModel({ ...base, shares: "abc" }).model).toBe("unknown");
    expect(classifyFeeModel({ ...base, feeUsdc: "5.00", shares: "1" }).model).toBe("unknown");
    expect(classifyFeeModel({ ...base, avgPrice: "0", shares: "1" }).model).toBe("unknown");
  });
  it("tolerance is 0.01 share + 5 bps of the prediction", () => {
    // inclusive prediction 4.90 / 0.30075 = 16.2926; 5 bps = 0.0081 -> window ~ +/- 0.018
    const q = { amountUsdc: "5.00", feeUsdc: "0.10", avgPrice: "0.300750" };
    expect(classifyFeeModel({ ...q, shares: "16.31" }).model).toBe("inclusive");
    expect(classifyFeeModel({ ...q, shares: "16.32" }).model).toBe("unknown");
    expect(classifyFeeModel({ ...q, shares: "16.27" }).model).toBe("unknown");
  });
});

const PIN = (pinned: "inclusive" | "on_top", feeCapBps = 500) => ({ pinned, feeCapBps });

describe("quoteWithinStake (pinned model)", () => {
  const stake = toMicro("5.00");

  it("pinned inclusive: one quote at the stake; outflow = 5.00", async () => {
    const p = fakePanta("inclusive");
    const r = await quoteWithinStake(p.quote, stake, PIN("inclusive"));
    expect(p.calls).toEqual(["5.00"]);
    expect(r).toMatchObject({ model: "inclusive", depositBase: stake, outflowBase: stake, quotes: 1 });
  });

  it("pinned on top: re-quotes once with stake - fee = 4.90; 4.90 + 0.10 = 5.00 <= 5.00", async () => {
    const p = fakePanta("on_top");
    const r = await quoteWithinStake(p.quote, stake, PIN("on_top"));
    expect(p.calls).toEqual(["5.00", "4.90"]);
    expect(r).toMatchObject({ model: "on_top", firstModel: "on_top", quotes: 2 });
    expect(r.depositBase).toBe(toMicro("4.90"));
    expect(r.feeBase).toBe(toMicro("0.10"));
    expect(r.outflowBase).toBe(stake);
  });

  it("a quote that contradicts the pin is an error, never a switch (both directions)", async () => {
    await expect(quoteWithinStake(fakePanta("on_top").quote, stake, PIN("inclusive"))).rejects.toMatchObject({
      code: "FEE_MODEL_MISMATCH",
      detected: "on_top",
    });
    const p = fakePanta("inclusive");
    await expect(quoteWithinStake(p.quote, stake, PIN("on_top"))).rejects.toMatchObject({
      code: "FEE_MODEL_MISMATCH",
      detected: "inclusive",
    });
    expect(p.calls).toEqual(["5.00"]); // no re-quote
  });

  it("on top: the re-quoted deposit + re-quoted fee must fit; a fee that grows is refused (one re-quote only)", async () => {
    const p = fakePanta("on_top", { feeFn: (a) => (a >= 5 ? 0.1 : 0.12) }); // 4.90 + 0.12 = 5.02
    await expect(quoteWithinStake(p.quote, stake, PIN("on_top"))).rejects.toMatchObject({ code: "FEE_TOO_HIGH" });
    expect(p.calls).toEqual(["5.00", "4.90"]);
  });

  it("on top: a re-quote that flips to inclusive is refused", async () => {
    let n = 0;
    const flip = async (amountUsdc: string) => {
      const a = Number(amountUsdc);
      const fee = Number((a * 0.02).toFixed(2));
      const shares = (n++ === 0 ? a : a - fee) / PRICE;
      return { amountUsdc, feeUsdc: fee.toFixed(2), avgPrice: PRICE.toFixed(6), shares: shares.toFixed(2) };
    };
    await expect(quoteWithinStake(flip, stake, PIN("on_top"))).rejects.toMatchObject({ code: "FEE_MODEL_MISMATCH" });
  });

  it("refuses ambiguous and unknown quotes under either pin, with no re-quote", async () => {
    const amb = async (amountUsdc: string) => ({ amountUsdc, feeUsdc: "0.001", avgPrice: "0.300750", shares: "16.62" });
    for (const pin of ["inclusive", "on_top"] as const) {
      await expect(quoteWithinStake(amb, stake, PIN(pin))).rejects.toMatchObject({
        code: "FEE_MODEL_UNKNOWN",
        detected: "ambiguous",
      });
      let calls = 0;
      const unk = async (amountUsdc: string) => {
        calls++;
        return { amountUsdc, feeUsdc: "0.10", avgPrice: "0.300750", shares: "16.45" };
      };
      await expect(quoteWithinStake(unk, stake, PIN(pin))).rejects.toMatchObject({
        code: "FEE_MODEL_UNKNOWN",
        detected: "unknown",
      });
      expect(calls).toBe(1);
    }
  });

  it("D-01: a fee above the cap (default 500 bps = 0.25 on 5.00) is refused; at the cap is fine", async () => {
    await expect(quoteWithinStake(fakePanta("inclusive", { rate: 0.06 }).quote, stake, PIN("inclusive"))).rejects.toMatchObject({
      code: "FEE_TOO_HIGH",
    });
    const atCap = await quoteWithinStake(fakePanta("inclusive", { rate: 0.05 }).quote, stake, PIN("inclusive"));
    expect(atCap.feeBase).toBe(toMicro("0.25"));
    // A stricter deployment cap of 100 bps refuses the normal 2% fee.
    await expect(quoteWithinStake(fakePanta("inclusive").quote, stake, PIN("inclusive", 100))).rejects.toMatchObject({
      code: "FEE_TOO_HIGH",
    });
    // The cap is checked on the on-top re-quote too.
    let n = 0;
    const grow = fakePanta("on_top", { feeFn: () => [0.1, 0.3][n++] ?? 1 });
    await expect(quoteWithinStake(grow.quote, stake, PIN("on_top"))).rejects.toMatchObject({ code: "FEE_TOO_HIGH" });
  });

  it("refuses a quote for a different amount", async () => {
    const wrong = async () => ({ amountUsdc: "50.00", feeUsdc: "1.00", avgPrice: "0.300750", shares: "163.00" });
    await expect(quoteWithinStake(wrong, stake, PIN("inclusive"))).rejects.toBeInstanceOf(FeeModelError);
    await expect(quoteWithinStake(wrong, stake, PIN("inclusive"))).rejects.toMatchObject({ code: "QUOTE_MISMATCH" });
  });
});

describe("fee config (PANTA_FEE_MODEL pin, PANTA_FEE_CAP_BPS)", () => {
  it("real mode requires the pin; mock defaults to MOCK_PANTA_FEE_MODEL or inclusive", () => {
    expect(() => feeConfigFromEnv({}, false)).toThrow(/PANTA_FEE_MODEL is required/);
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "on_top" }, false)).toEqual({ model: "on_top", feeCapBps: 500 });
    expect(feeConfigFromEnv({}, true)).toEqual({ model: "inclusive", feeCapBps: 500 });
    expect(feeConfigFromEnv({ MOCK_PANTA_FEE_MODEL: "on_top" }, true).model).toBe("on_top");
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "inclusive", MOCK_PANTA_FEE_MODEL: "on_top" }, true).model).toBe(
      "inclusive",
    );
  });
  it("rejects bad values without echoing them", () => {
    expect(() => feeConfigFromEnv({ PANTA_FEE_MODEL: "guess-xyz" }, false)).toThrow(/inclusive or on_top/);
    try {
      feeConfigFromEnv({ PANTA_FEE_MODEL: "guess-xyz" }, false);
    } catch (e) {
      expect(String(e)).not.toContain("guess-xyz");
    }
    for (const v of ["0", "1001", "2.5", "abc"])
      expect(() => feeConfigFromEnv({ PANTA_FEE_MODEL: "inclusive", PANTA_FEE_CAP_BPS: v }, false)).toThrow();
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "inclusive", PANTA_FEE_CAP_BPS: "300" }, false).feeCapBps).toBe(300);
  });
});
