/** Launch cap parsing (MAX_STAKE_USDC): real mode never falls back to "no limit". */
import { describe, expect, it } from "vitest";
import { StakeCapError, stakeCapFromEnv } from "@/lib/stake-cap";

describe("MAX_STAKE_USDC", () => {
  it("is required in real mode; mock defaults to 5", () => {
    expect(() => stakeCapFromEnv({}, false)).toThrow(StakeCapError);
    expect(() => stakeCapFromEnv({ MAX_STAKE_USDC: "   " }, false)).toThrow(/required/);
    expect(stakeCapFromEnv({}, true)).toBe(5_000_000n);
  });

  it("accepts plain decimals above 0, at most 6 dp, up to 1000", () => {
    expect(stakeCapFromEnv({ MAX_STAKE_USDC: "5" }, false)).toBe(5_000_000n);
    expect(stakeCapFromEnv({ MAX_STAKE_USDC: " 2.5 " }, false)).toBe(2_500_000n);
    expect(stakeCapFromEnv({ MAX_STAKE_USDC: "0.000001" }, false)).toBe(1n);
    expect(stakeCapFromEnv({ MAX_STAKE_USDC: "1000" }, false)).toBe(1_000_000_000n);
  });

  it("refuses zero, junk, number tricks, too many decimals and anything above 1000 (both modes)", () => {
    for (const v of ["0", "0.000000", "-5", "+5", "1e2", "0x5", "5.0000001", "1000.000001", "10000", "abc", "5 USDC", "Infinity", "NaN", ".5", "5."]) {
      expect(() => stakeCapFromEnv({ MAX_STAKE_USDC: v }, false), v).toThrow(StakeCapError);
      expect(() => stakeCapFromEnv({ MAX_STAKE_USDC: v }, true), v).toThrow(StakeCapError);
    }
  });

  it("errors never echo the value", () => {
    try {
      stakeCapFromEnv({ MAX_STAKE_USDC: "secret-ish-9999" }, false);
    } catch (e) {
      expect(String(e)).not.toContain("secret-ish-9999");
    }
  });
});
