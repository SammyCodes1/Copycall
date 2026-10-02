/** E-03 / E-11: landed USDC attribution fails closed (null), never counts unknown rows as 0. */
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { payerUsdcOutFromMeta, type TokenBalanceRow } from "@/lib/landed";
import { USDC_MINT, associatedTokenAddress } from "@/lib/solana-constants";
import { createMockChain } from "@/lib/mock/chain-mock";
import { TransactionMessage, PublicKey, TransactionInstruction } from "@solana/web3.js";

const key = () => bs58.encode(randomBytes(32));
const payer = key();
const ata = associatedTokenAddress(payer, USDC_MINT);
const vault = key();
const keys = [payer, ata, vault];
const NO_OWNER = "<none>";
const row = (accountIndex: number, amount: bigint, owner: string = payer, mint = USDC_MINT): TokenBalanceRow => ({
  accountIndex,
  mint,
  ...(owner === NO_OWNER ? {} : { owner }),
  uiTokenAmount: { amount: amount.toString() },
});

describe("E-03: payerUsdcOutFromMeta", () => {
  it("measures the payer's USDC decrease, keyed by account index and owner", () => {
    const pre = [row(2, 0n, "vaultOwner"), row(1, 10_000_000n)];
    const post = [row(1, 5_000_000n), row(2, 5_000_000n, "vaultOwner")];
    expect(payerUsdcOutFromMeta({ preTokenBalances: pre, postTokenBalances: post }, keys, payer)).toBe(5_000_000n);
    // A non-USDC row is ignored.
    const other = row(2, 7n, payer, key());
    expect(payerUsdcOutFromMeta({ preTokenBalances: [...pre, other], postTokenBalances: post }, keys, payer)).toBe(5_000_000n);
  });

  it("the auditor's PoF: rows without owner are unknown (null), not 0", () => {
    const pre = [row(1, 10_000_000n, NO_OWNER)];
    const post = [row(1, 5_000_000n, NO_OWNER)];
    expect(payerUsdcOutFromMeta({ preTokenBalances: pre, postTokenBalances: post }, keys, payer)).toBeNull();
    // Even a foreign row without owner makes the whole result unknown.
    const mixed = [row(1, 10_000_000n), row(2, 0n, NO_OWNER)];
    expect(payerUsdcOutFromMeta({ preTokenBalances: mixed, postTokenBalances: [row(1, 5_000_000n)] }, keys, payer)).toBeNull();
  });

  it("the auditor's PoF: empty or missing lists are unknown (null), not 0", () => {
    expect(payerUsdcOutFromMeta({ preTokenBalances: [], postTokenBalances: [] }, keys, payer)).toBeNull();
    expect(payerUsdcOutFromMeta({ preTokenBalances: null, postTokenBalances: [row(1, 1n)] }, keys, payer)).toBeNull();
    expect(payerUsdcOutFromMeta({ postTokenBalances: [row(1, 1n)] }, keys, payer)).toBeNull();
    expect(payerUsdcOutFromMeta(null, keys, payer)).toBeNull();
    expect(payerUsdcOutFromMeta(undefined, keys, payer)).toBeNull();
  });

  it("the user's ATA in the tx without any row for it is unknown", () => {
    const pre = [row(2, 0n, "vaultOwner")];
    const post = [row(2, 5_000_000n, "vaultOwner")];
    expect(payerUsdcOutFromMeta({ preTokenBalances: pre, postTokenBalances: post }, keys, payer)).toBeNull();
  });

  it("bad account index, foreign owner on the user's ATA, or a malformed amount are unknown", () => {
    const post = [row(1, 5_000_000n)];
    expect(payerUsdcOutFromMeta({ preTokenBalances: [row(9, 10_000_000n)], postTokenBalances: post }, keys, payer)).toBeNull();
    expect(
      payerUsdcOutFromMeta({ preTokenBalances: [row(1, 10_000_000n, key())], postTokenBalances: post }, keys, payer),
    ).toBeNull();
    const bad = { ...row(1, 0n), uiTokenAmount: { amount: "1e9" } };
    expect(payerUsdcOutFromMeta({ preTokenBalances: [bad], postTokenBalances: post }, keys, payer)).toBeNull();
  });

  it("an account closed in the tx (pre row, no post row) counts as outflow", () => {
    const pre = [row(1, 10_000_000n)];
    expect(payerUsdcOutFromMeta({ preTokenBalances: pre, postTokenBalances: [] }, keys, payer)).toBe(10_000_000n);
  });

  it("E-11: the mock chain no longer defaults an unknown outflow to 0", async () => {
    const chain = createMockChain();
    const msg = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: bs58.encode(Buffer.alloc(32, 1)),
      instructions: [new TransactionInstruction({ programId: new PublicKey(vault), keys: [], data: Buffer.alloc(0) })],
    }).compileToV0Message();
    const sig = chain.landForeign(msg);
    const t = await chain.getLandedTransaction(sig);
    expect(t?.payerUsdcOutBase).toBeNull();
    expect(t?.innerPrograms).toBeNull();
  });
});
