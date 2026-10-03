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

  it("E-08: on top, a re-quote with a higher fee is refused even when it fits the stake", async () => {
    // The auditor's case: 0.105 then 0.11. 4.89 + 0.11 = 5.00 fits the stake, but the fee went up.
    const calls: string[] = [];
    const fees = ["0.105", "0.11"];
    const up = async (amountUsdc: string) => {
      calls.push(amountUsdc);
      return { amountUsdc, feeUsdc: fees[calls.length - 1], avgPrice: PRICE.toFixed(6), shares: (Number(amountUsdc) / PRICE).toFixed(2) };
    };
    await expect(quoteWithinStake(up, stake, PIN("on_top"))).rejects.toMatchObject({
      code: "FEE_TOO_HIGH",
      message: expect.stringContaining("went up"),
    });
    expect(calls).toEqual(["5.00", "4.89"]);
    // An equal or lower re-quoted fee is fine.
    let m = 0;
    const down = fakePanta("on_top", { feeFn: () => [0.1, 0.09][m++] ?? 1 });
    expect((await quoteWithinStake(down.quote, stake, PIN("on_top"))).feeBase).toBe(toMicro("0.09"));
  });

  it("E-08: on top, a no_fee re-quote is refused (it contradicts the pin)", async () => {
    let n = 0;
    const drop = fakePanta("on_top", { feeFn: () => [0.1, 0][n++] ?? 1 });
    await expect(quoteWithinStake(drop.quote, stake, PIN("on_top"))).rejects.toMatchObject({
      code: "FEE_MODEL_MISMATCH",
      detected: "no_fee",
    });
  });

  it("refuses a quote for a different amount", async () => {
    const wrong = async () => ({ amountUsdc: "50.00", feeUsdc: "1.00", avgPrice: "0.300750", shares: "163.00" });
    await expect(quoteWithinStake(wrong, stake, PIN("inclusive"))).rejects.toBeInstanceOf(FeeModelError);
    await expect(quoteWithinStake(wrong, stake, PIN("inclusive"))).rejects.toMatchObject({ code: "QUOTE_MISMATCH" });
  });
});

describe("Q-01: an explicit pin resolves an ambiguous quote that fits it", () => {
  // The live 1.00 USDC quote of 2026-10-03 (market 5cyM...): on top, but too small to classify.
  const LIVE_PRICE = 0.506453;
  const one = toMicro("1.00");
  /** Panta-like quote: 2% fee (cents), shares priced per `fits` ("neither" = between the two). */
  const quoteAs = (fits: "on_top" | "inclusive" | "neither") => {
    const calls: string[] = [];
    const quote = async (amountUsdc: string) => {
      calls.push(amountUsdc);
      const a = Number(amountUsdc);
      const fee = Number((a * 0.02).toFixed(2));
      const top = a / LIVE_PRICE;
      const inc = (a - fee) / LIVE_PRICE;
      const shares = fits === "on_top" ? top : fits === "inclusive" ? inc : (top + inc) / 2;
      return { amountUsdc, feeUsdc: fee.toFixed(2), avgPrice: LIVE_PRICE.toFixed(6), shares: shares.toFixed(6) };
    };
    return { quote, calls };
  };
  const EXPLICIT = (pinned: "inclusive" | "on_top") => ({ ...PIN(pinned), explicitPin: true });

  it("the live numbers really are ambiguous (and fit on top)", () => {
    expect(classifyFeeModel({ amountUsdc: "1.00", feeUsdc: "0.02", avgPrice: "0.506453", shares: "1.974514" }).model).toBe("ambiguous");
  });

  it("pinned on_top + ambiguous that fits on top: accepted (re-quote too), outflow within the stake", async () => {
    const p = quoteAs("on_top");
    const r = await quoteWithinStake(p.quote, one, EXPLICIT("on_top"));
    expect(p.calls).toEqual(["1.00", "0.98"]);
    expect(r).toMatchObject({ model: "on_top", firstModel: "ambiguous", quotes: 2 });
    expect(r.depositBase).toBe(toMicro("0.98"));
    expect(r.outflowBase).toBe(one);
  });

  it("pinned inclusive + ambiguous that fits inclusive: accepted", async () => {
    const r = await quoteWithinStake(quoteAs("inclusive").quote, one, EXPLICIT("inclusive"));
    expect(r).toMatchObject({ model: "inclusive", firstModel: "ambiguous", quotes: 1, outflowBase: one });
  });

  it("pinned + ambiguous that contradicts the pin: refused (mismatch), no re-quote", async () => {
    for (const [pin, fits] of [["inclusive", "on_top"], ["on_top", "inclusive"]] as const) {
      const p = quoteAs(fits);
      await expect(quoteWithinStake(p.quote, one, EXPLICIT(pin))).rejects.toMatchObject({
        code: "FEE_MODEL_MISMATCH",
        detected: "ambiguous",
      });
      expect(p.calls).toEqual(["1.00"]);
    }
  });

  it("pinned + ambiguous that fits neither model: refused FEE_MODEL_UNKNOWN", async () => {
    for (const pin of ["inclusive", "on_top"] as const)
      await expect(quoteWithinStake(quoteAs("neither").quote, one, EXPLICIT(pin))).rejects.toMatchObject({
        code: "FEE_MODEL_UNKNOWN",
        detected: "ambiguous",
      });
  });

  it("pinned + a clear classification that contradicts the pin: still refused", async () => {
    await expect(quoteWithinStake(fakePanta("inclusive").quote, toMicro("5.00"), EXPLICIT("on_top"))).rejects.toMatchObject({
      code: "FEE_MODEL_MISMATCH",
      detected: "inclusive",
    });
  });

  it("unpinned (mock default, explicitPin false or absent) + ambiguous: refused as before", async () => {
    for (const opts of [PIN("on_top"), { ...PIN("on_top"), explicitPin: false }]) {
      const p = quoteAs("on_top");
      await expect(quoteWithinStake(p.quote, one, opts)).rejects.toMatchObject({ code: "FEE_MODEL_UNKNOWN", detected: "ambiguous" });
      expect(p.calls).toEqual(["1.00"]);
    }
  });

  it("FeeConfig.pinned is true only when PANTA_FEE_MODEL is set", () => {
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "on_top" }, false).pinned).toBe(true);
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "inclusive" }, true).pinned).toBe(true);
    expect(feeConfigFromEnv({}, true).pinned).toBe(false);
    expect(feeConfigFromEnv({ MOCK_PANTA_FEE_MODEL: "on_top" }, true).pinned).toBe(false);
  });
});

describe("fee config (PANTA_FEE_MODEL pin, PANTA_FEE_CAP_BPS)", () => {
  it("real mode requires the pin; mock defaults to MOCK_PANTA_FEE_MODEL or inclusive", () => {
    expect(() => feeConfigFromEnv({}, false)).toThrow(/PANTA_FEE_MODEL is required/);
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "on_top" }, false)).toEqual({ model: "on_top", feeCapBps: 500, pinned: true });
    expect(feeConfigFromEnv({}, true)).toEqual({ model: "inclusive", feeCapBps: 500, pinned: false });
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
    // E-07: Number() would accept these; only plain digits are allowed.
    for (const v of ["0", "1001", "2.5", "abc", "1e2", "0x1f4", "0b11", "+300", "500.0", "3e2", "-5", "00500"])
      expect(() => feeConfigFromEnv({ PANTA_FEE_MODEL: "inclusive", PANTA_FEE_CAP_BPS: v }, false)).toThrow();
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "inclusive", PANTA_FEE_CAP_BPS: "300" }, false).feeCapBps).toBe(300);
    expect(feeConfigFromEnv({ PANTA_FEE_MODEL: "inclusive", PANTA_FEE_CAP_BPS: " 1000 " }, false).feeCapBps).toBe(1000);
  });
});
