import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsafeBootError, assertBootSafe } from "@/lib/boot";

afterEach(() => {
  delete process.env.VERCEL_ENV;
  process.env.MOCK_PANTA = "true";
  vi.resetModules();
});

describe("mock mode can never boot in production (addendum I)", () => {
  it("refuses MOCK_PANTA=true with VERCEL_ENV=production", () => {
    expect(() => assertBootSafe({ MOCK_PANTA: "true", VERCEL_ENV: "production" })).toThrow(UnsafeBootError);
    expect(() => assertBootSafe({ MOCK_PANTA: "TRUE", VERCEL_ENV: "production" })).toThrow(UnsafeBootError);
  });

  it("allows mock in preview/dev and real mode in production", () => {
    expect(() => assertBootSafe({ MOCK_PANTA: "true", VERCEL_ENV: "preview" })).not.toThrow();
    expect(() => assertBootSafe({ MOCK_PANTA: "true" })).not.toThrow();
    expect(() => assertBootSafe({ MOCK_PANTA: "false", VERCEL_ENV: "production" })).not.toThrow();
  });

  it("instrumentation register() throws at server start", async () => {
    process.env.VERCEL_ENV = "production";
    const { register } = await import("@/instrumentation");
    expect(() => register()).toThrow(/Refusing to boot/);
  });

  // resetModules() gives fresh module instances, so match on the message, not the class.
  it("next.config refuses to load (so the build fails)", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(import("@/next.config")).rejects.toThrow(/Refusing to boot/);
  });

  it("the mock Panta client and the in-memory auth store refuse to run", async () => {
    process.env.VERCEL_ENV = "production";
    const panta = await import("@/lib/panta");
    await expect(panta.listMarkets()).rejects.toThrow(/Refusing to boot/);
    const { createMemoryAuthStore } = await import("@/lib/mock/auth-store-memory");
    expect(() => createMemoryAuthStore()).toThrow();
  });

  it("Q-01: register() logs MAX_STAKE_USDC below the minimum once at startup (and still boots)", async () => {
    const prev = process.env.MAX_STAKE_USDC;
    process.env.MAX_STAKE_USDC = "1";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { register } = await import("@/instrumentation");
      expect(() => register()).not.toThrow();
      const hits = spy.mock.calls.filter((c) => String(c[0]).includes("below the 2 USDC minimum"));
      expect(hits).toHaveLength(1);
      expect(String(hits[0][0])).toBe("[copy] MAX_STAKE_USDC is below the 2 USDC minimum stake (MIN_STAKE_USDC): copying is disabled");
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.MAX_STAKE_USDC;
      else process.env.MAX_STAKE_USDC = prev;
    }
  });
});
