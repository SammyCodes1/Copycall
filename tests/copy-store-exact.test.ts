/**
 * E-01: the Supabase copy store reads numerics as text and keeps them exact.
 * The DB client is stubbed; each query records its select list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const selects: string[] = [];
let row: Record<string, unknown> | null = null;
let rows: Record<string, unknown>[] = [];

function query() {
  const q: Record<string, unknown> = {};
  const self = () => q;
  Object.assign(q, {
    select: (cols: string) => (selects.push(cols), q),
    eq: self,
    in: self,
    order: self,
    limit: () => Promise.resolve({ data: rows, error: null }),
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  });
  return q;
}
vi.mock("@/lib/db", () => ({ getDb: () => ({ from: () => query() }) }));

const { supabaseCopyStore } = await import("@/lib/copy-store-supabase");

const orderRow = (over: Record<string, unknown>) => ({
  id: "o1",
  user_id: "u1",
  wallet: "W",
  kind: "claim",
  leader_trade_id: null,
  market_id: "m",
  side: "YES",
  amount_usdc: "9.996000",
  fee_usdc: "0.000000",
  fee_model: null,
  max_usdc_out: "0.000000",
  shares: "9.996000",
  quote_id: null,
  panta_order_id: null,
  message_hash: "a".repeat(64),
  message_base64: "AA==",
  last_valid_block_height: "1000000",
  created_at: new Date().toISOString(),
  expires_at: new Date().toISOString(),
  status: "pending",
  signature: null,
  ...over,
});

beforeEach(() => {
  selects.length = 0;
  row = null;
  rows = [];
});

describe("E-01: exact numeric reads", () => {
  it("claim shares 9.996000 / 0.125000 / 38.425100 stay exact (the float path made them 10.00 / 0.13 / 38.43)", async () => {
    for (const [v, want] of [
      ["9.996000", "9.996"],
      ["0.125000", "0.125"],
      ["38.425100", "38.4251"],
      ["18.400000", "18.40"],
    ]) {
      row = orderRow({ shares: v, amount_usdc: v });
      const o = await supabaseCopyStore.getPendingOrder("o1");
      expect(o).toMatchObject({ shares: want, amountUsdc: want, lastValidBlockHeight: 1_000_000 });
    }
    expect(selects.every((c) => /shares::text/.test(c) && /amount_usdc::text/.test(c))).toBe(true);
  });

  it("a payout equal to the exact shares is not 'too little' any more", async () => {
    const { usdcToBase } = await import("@/lib/solana-constants");
    row = orderRow({ shares: "9.996000" });
    const o = (await supabaseCopyStore.getPendingOrder("o1"))!;
    const landedPayout = 9_996_000n;
    expect(landedPayout < usdcToBase(o.shares)).toBe(false);
  });

  it("fails closed on a float or malformed numeric instead of rounding it", async () => {
    for (const bad of [9.996, "9.9960001", "1e3", "-1.000000", "", null]) {
      row = orderRow({ shares: bad });
      await expect(supabaseCopyStore.getPendingOrder("o1")).rejects.toThrow(/Database error/);
    }
  });

  it("copies and claims lists are exact too", async () => {
    rows = [
      {
        id: "c1",
        leader_trade_id: "t",
        market_id: "m",
        side: "YES",
        amount_usdc: "4.995000",
        fee_usdc: "0.105000",
        shares: "9.996000",
        signature: "s",
        status: "confirmed",
        created_at: new Date().toISOString(),
      },
    ];
    expect((await supabaseCopyStore.listCopies("u1", 5))[0]).toMatchObject({
      amountUsdc: "4.995",
      feeUsdc: "0.105",
      shares: "9.996",
    });
    rows = [{ id: "k1", market_id: "m", side: "YES", shares: "0.125000", signature: "s", created_at: new Date().toISOString() }];
    expect((await supabaseCopyStore.listClaims("u1", 5))[0]).toMatchObject({ shares: "0.125" });
    expect(selects.join(" ")).not.toMatch(/(^|[ ,])(amount_usdc|fee_usdc|shares)(,|$)/);
  });
});
