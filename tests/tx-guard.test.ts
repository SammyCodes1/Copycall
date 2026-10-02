/**
 * SECURITY ADDENDUM A: the transaction guard, on the same instruction shapes
 * our mock Panta builds. Every rejection happens before a wallet prompt.
 */
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { TransactionMessage, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import * as panta from "@/lib/panta";
import { MOCK_OTHER_MINT, MOCK_PROGRAM_ID, createMockChain, mockVault } from "@/lib/mock/chain-mock";
import type { BuildResponse, PantaInstruction } from "@/lib/schemas";
import {
  ATA_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  associatedTokenAddress,
  usdcToBase,
} from "@/lib/solana-constants";
import {
  TxRejected,
  assembleTransaction,
  checkInnerPrograms,
  innerProgramIds,
  checkInstructions,
  checkMessageShape,
  simulateAndCheck,
  type GuardContext,
} from "@/lib/tx-guard";
import { copyUsdcLimitBase } from "@/lib/copy-math";
import marketsJson from "@/fixtures/markets.json";
import { testWallet } from "./helpers/wallet";

const primaryMarket = (marketsJson as { marketId: string; phase: string }[]).find(
  (m) => m.phase === "primary",
)!.marketId;
const PROGRAMS = new Set([MOCK_PROGRAM_ID]);
/** Review terms matching a build at 2% slippage: the displayed min is the on-chain min. */
const termsFor = (b: BuildResponse): NonNullable<GuardContext["copyTerms"]> => ({
  side: "yes",
  maxSlippageBps: 200,
  minSharesBase: (usdcToBase(b.expectedShares) * 9_800n) / 10_000n,
});
const randomKey = () => bs58.encode(randomBytes(32));

let wallet: string;
let build: BuildResponse;
let ctx: GuardContext;
let feeBase: bigint;

beforeAll(async () => {
  wallet = testWallet().address;
  const q = await panta.quotePrimaryOrder({ wallet, marketId: primaryMarket, side: "yes", amountUsdc: "5.00" });
  build = await panta.buildPrimaryOrder({ quoteId: q.quoteId, wallet, maxSlippageBps: 200 });
  ctx = {
    kind: "copy",
    feePayer: wallet,
    marketId: primaryMarket,
    pantaProgramIds: PROGRAMS,
    maxUsdcOutBase: copyUsdcLimitBase(usdcToBase("5.00")), // hard total: the fee is inside the 5.00
    copyOutflow: { model: "inclusive", depositBase: usdcToBase("5.00"), feeBase: usdcToBase(q.feeUsdc) },
    copyTerms: termsFor(build),
  };
  feeBase = usdcToBase(q.feeUsdc);
});

const tokenIx = (program: string, data: number[], accounts: string[]): PantaInstruction => ({
  programId: program,
  data: Buffer.from(data).toString("base64"),
  accounts: accounts.map((pubkey, i) => ({
    pubkey,
    isSigner: pubkey === wallet && i === accounts.length - 1,
    isWritable: i < 2,
  })),
});
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return [...b];
};
const reject = (ixs: PantaInstruction[], c: Partial<GuardContext> = {}) => {
  try {
    checkInstructions(ixs, { ...ctx, ...c });
  } catch (e) {
    expect(e).toBeInstanceOf(TxRejected);
    return (e as TxRejected).code;
  }
  return "ACCEPTED";
};

describe("static instruction checks", () => {
  it("accept Panta's build as-is", () => {
    expect(reject(build.instructions)).toBe("ACCEPTED");
  });

  it("reject an unknown program", () => {
    const evil = { programId: randomKey(), data: "AA==", accounts: [] };
    expect(reject([...build.instructions, evil])).toBe("UNKNOWN_PROGRAM");
    // Panta's program is only allowed if it is in PANTA_PROGRAM_IDS
    expect(reject(build.instructions, { pantaProgramIds: new Set([randomKey()]) })).toBe("UNKNOWN_PROGRAM");
  });

  it("reject a different fee payer / an extra signer", () => {
    expect(reject(build.instructions, { feePayer: randomKey() })).toBe("EXTRA_SIGNER");
    const tx = assembleTransaction(build.instructions, build.recentBlockhash, wallet);
    expect(() => checkMessageShape(tx.message, randomKey())).toThrow(/Fee payer/);
    // An instruction that needs a second signer can't be assembled into a 1-signature tx.
    const other = randomKey();
    const withSigner = structuredClone(build.instructions);
    withSigner[3].accounts.push({ pubkey: other, isSigner: true, isWritable: false });
    expect(reject(withSigner)).toBe("EXTRA_SIGNER");
  });

  for (const [name, tag] of [
    ["Approve", 4],
    ["SetAuthority", 6],
    ["CloseAccount", 9],
    ["ApproveChecked", 13],
    ["Burn", 8],
    ["MintTo", 7],
  ] as const) {
    it(`reject ${name} on Token and Token-2022`, () => {
      const ata = associatedTokenAddress(wallet);
      for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const ix = tokenIx(program, [tag, ...u64(1n)], [ata, randomKey(), wallet]);
        expect(reject([...build.instructions, ix])).toBe("TOKEN_IX");
      }
    });
  }

  it("reject a token transfer to an account the Panta instruction doesn't use", () => {
    const ata = associatedTokenAddress(wallet);
    const ix = tokenIx(TOKEN_PROGRAM_ID, [3, ...u64(1n)], [ata, randomKey(), wallet]);
    expect(reject([...build.instructions, ix])).toBe("EXTRA_TRANSFER");
    const checked = tokenIx(TOKEN_2022_PROGRAM_ID, [12, ...u64(1n), 6], [ata, USDC_MINT, randomKey(), wallet]);
    expect(reject([...build.instructions, checked])).toBe("EXTRA_TRANSFER");
  });

  it("reject transfers into Panta's accounts above the max stake", () => {
    const ata = associatedTokenAddress(wallet);
    const ok = tokenIx(TOKEN_PROGRAM_ID, [3, ...u64(1_000_000n)], [ata, mockVault(primaryMarket), wallet]);
    // Counted on top of the 5.00 deposit: fits a 6.00 cap, not the 5.00 one.
    expect(reject([...build.instructions, ok], { maxUsdcOutBase: usdcToBase("6.00") })).toBe("ACCEPTED");
    expect(reject([...build.instructions, ok])).toBe("OVER_STAKE");
    const big = tokenIx(
      TOKEN_PROGRAM_ID,
      [3, ...u64(ctx.maxUsdcOutBase + 1n)],
      [ata, mockVault(primaryMarket), wallet],
    );
    expect(reject([...build.instructions, big])).toBe("OVER_STAKE");
  });

  it("reject System instructions, non-idempotent ATA creation and big priority fees", () => {
    const sys = {
      programId: SYSTEM_PROGRAM_ID,
      data: Buffer.from([2, 0, 0, 0, ...u64(1n)]).toString("base64"),
      accounts: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: randomKey(), isSigner: false, isWritable: true },
      ],
    };
    expect(reject([...build.instructions, sys])).toBe("SYSTEM_IX");
    const ata = structuredClone(build.instructions);
    ata[2].data = Buffer.from([0]).toString("base64"); // Create (not idempotent)
    expect(reject(ata)).toBe("ATA_IX");
    const fee = structuredClone(build.instructions);
    fee[1].data = Buffer.from([3, ...u64(1_000_000_000n)]).toString("base64");
    expect(reject(fee)).toBe("PRIORITY_FEE");
    expect(
      reject([
        {
          ...build.instructions[2],
          programId: ATA_PROGRAM_ID,
          accounts: build.instructions[2].accounts.map((a, i) => (i === 0 ? { ...a, pubkey: randomKey() } : a)),
        },
        ...build.instructions.slice(3),
      ]),
    ).not.toBe("ACCEPTED");
  });

  it("reject a Panta instruction for another market or of another kind", () => {
    expect(reject(build.instructions, { marketId: randomKey() })).toBe("MARKET_MISMATCH");
    expect(reject(build.instructions, { kind: "claim" })).toBe("UNEXPECTED_PANTA_IX");
    expect(reject([...build.instructions, build.instructions[3]])).toBe("PANTA_IX_COUNT");
  });
});

describe("simulation checks", () => {
  const chain = createMockChain();

  it("pass for the real build: USDC decrease == stake, nothing else changes", async () => {
    const tx = assembleTransaction(build.instructions, build.recentBlockhash, wallet);
    const r = await simulateAndCheck(chain, tx, wallet, ctx.maxUsdcOutBase);
    expect(r.usdcDecrease).toBe(usdcToBase("5.00"));
    expect(r.accountsChecked).toBeGreaterThanOrEqual(2);
  });

  it("the limit is the max stake itself: fee and slippage get no headroom on top", () => {
    expect(ctx.maxUsdcOutBase).toBe(usdcToBase("5.00"));
    expect(feeBase).toBeGreaterThan(0n);
  });

  it("reject a build that pulls the stake PLUS the fee (5.00 approved, 5.10 out)", async () => {
    const ixs = structuredClone(build.instructions);
    const data = Buffer.from(ixs[3].data, "base64");
    data.writeBigUInt64LE(usdcToBase("5.00") + feeBase, 8); // fee added on top of the stake
    ixs[3].data = data.toString("base64");
    const tx = assembleTransaction(ixs, build.recentBlockhash, wallet);
    await expect(simulateAndCheck(chain, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({ code: "OVER_STAKE" });
    // One base unit over is already too much.
    data.writeBigUInt64LE(usdcToBase("5.00") + 1n, 8);
    ixs[3].data = data.toString("base64");
    const tx2 = assembleTransaction(ixs, build.recentBlockhash, wallet);
    await expect(simulateAndCheck(chain, tx2, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({ code: "OVER_STAKE" });
  });

  it("on top: a build of 5.00 + fee is caught by the static check AND the simulation", async () => {
    const prev = process.env.MOCK_PANTA_FEE_MODEL;
    process.env.MOCK_PANTA_FEE_MODEL = "on_top";
    try {
      // Not re-quoted: deposit = stake, fee on top (a separate SPL transfer in the mock).
      const q = await panta.quotePrimaryOrder({ wallet, marketId: primaryMarket, side: "yes", amountUsdc: "5.00" });
      const b = await panta.buildPrimaryOrder({ quoteId: q.quoteId, wallet, maxSlippageBps: 200 });
      const f = usdcToBase(q.feeUsdc);
      const onTop = { ...ctx, copyOutflow: { model: "on_top" as const, depositBase: usdcToBase("5.00"), feeBase: f }, copyTerms: termsFor(b) };
      expect(reject(b.instructions, onTop)).toBe("OVER_STAKE");
      // Even if the fee were charged inside the program (no top-level transfer), the model counts it.
      const withoutFeeIx = b.instructions.filter((i) => i.programId !== TOKEN_PROGRAM_ID);
      expect(reject(withoutFeeIx, onTop)).toBe("OVER_STAKE");
      const tx = assembleTransaction(b.instructions, b.recentBlockhash, wallet);
      await expect(simulateAndCheck(chain, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({ code: "OVER_STAKE" });

      // Re-quoted at 4.90: 4.90 + 0.10 = 5.00 passes both, and the simulation moves exactly 5.00.
      const q2 = await panta.quotePrimaryOrder({ wallet, marketId: primaryMarket, side: "yes", amountUsdc: "4.90" });
      const b2 = await panta.buildPrimaryOrder({ quoteId: q2.quoteId, wallet, maxSlippageBps: 200 });
      const f2 = usdcToBase(q2.feeUsdc);
      expect(usdcToBase("4.90") + f2).toBeLessThanOrEqual(usdcToBase("5.00"));
      const ok = { ...ctx, copyOutflow: { model: "on_top" as const, depositBase: usdcToBase("4.90"), feeBase: f2 }, copyTerms: termsFor(b2) };
      expect(reject(b2.instructions, ok)).toBe("ACCEPTED");
      const tx2 = assembleTransaction(b2.instructions, b2.recentBlockhash, wallet);
      const r = await simulateAndCheck(chain, tx2, wallet, ctx.maxUsdcOutBase);
      expect(r.usdcDecrease).toBe(usdcToBase("4.90") + f2);
      expect(r.usdcDecrease).toBeLessThanOrEqual(usdcToBase("5.00"));
    } finally {
      if (prev === undefined) delete process.env.MOCK_PANTA_FEE_MODEL;
      else process.env.MOCK_PANTA_FEE_MODEL = prev;
    }
  });

  it("a copy without a fee model, or with a deposit that doesn't match the quote, is refused", () => {
    expect(reject(build.instructions, { copyOutflow: undefined })).toBe("NO_FEE_MODEL");
    expect(
      reject(build.instructions, { copyOutflow: { model: "inclusive", depositBase: usdcToBase("4.99"), feeBase } }),
    ).toBe("DEPOSIT_MISMATCH");
  });

  it("reject a top-level transfer of stake + fee", () => {
    const ata = associatedTokenAddress(wallet);
    const ix = (n: bigint) => tokenIx(TOKEN_PROGRAM_ID, [3, ...u64(n)], [ata, mockVault(primaryMarket), wallet]);
    expect(reject([...build.instructions, ix(usdcToBase("5.00") + feeBase)])).toBe("OVER_STAKE");
  });

  it("reject when simulation spends more than the max stake (static checks can't see it)", async () => {
    const ixs = structuredClone(build.instructions);
    const data = Buffer.from(ixs[3].data, "base64");
    data.writeBigUInt64LE(ctx.maxUsdcOutBase + 1n, 8); // the program would pull more than quoted
    ixs[3].data = data.toString("base64");
    expect(reject(ixs)).toBe("DEPOSIT_MISMATCH"); // the decoded deposit no longer matches the quote
    const tx = assembleTransaction(ixs, build.recentBlockhash, wallet);
    await expect(simulateAndCheck(chain, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({ code: "OVER_STAKE" });
  });

  it("reject when another token account the user owns changes", async () => {
    const other = associatedTokenAddress(wallet, MOCK_OTHER_MINT);
    const ix = tokenIx(TOKEN_PROGRAM_ID, [3, ...u64(1n)], [other, mockVault(primaryMarket), wallet]);
    const ixs = [...build.instructions, ix];
    // Statically refused since B3-05 (only the user's USDC account may be a source) ...
    expect(reject(ixs, { maxUsdcOutBase: usdcToBase("6.00") })).toBe("TOKEN_SOURCE");
    // ... and the simulation still catches it on its own.
    const tx = assembleTransaction(ixs, build.recentBlockhash, wallet);
    await expect(simulateAndCheck(chain, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({
      code: "OTHER_ACCOUNT_CHANGED",
    });
  });

  it("reject a failing simulation", async () => {
    const ixs = structuredClone(build.instructions);
    const data = Buffer.from(ixs[3].data, "base64");
    data.writeBigUInt64LE(10_000_000_000n, 8); // more than the wallet holds
    ixs[3].data = data.toString("base64");
    const tx = assembleTransaction(ixs, build.recentBlockhash, wallet);
    await expect(simulateAndCheck(chain, tx, wallet, 20_000_000_000n)).rejects.toMatchObject({
      code: "SIMULATION_FAILED",
    });
  });

  it("reject a USDC account that gets a new delegate or is closed", async () => {
    const tx = assembleTransaction(build.instructions, build.recentBlockhash, wallet);
    const ata = associatedTokenAddress(wallet);
    const fake = {
      ...chain,
      simulate: async (t: VersionedTransaction, addresses: string[]) => {
        const r = await chain.simulate(t, addresses);
        const i = addresses.indexOf(ata);
        const data = Buffer.from(r.accounts[i]!.data);
        data[72] = 1; // delegate option = Some
        r.accounts[i] = { ...r.accounts[i]!, data };
        return r;
      },
    };
    await expect(simulateAndCheck(fake, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({
      code: "USDC_AUTHORITY",
    });
    const closed = {
      ...chain,
      simulate: async (t: VersionedTransaction, a: string[]) => {
        const r = await chain.simulate(t, a);
        return { ...r, accounts: r.accounts.map((acc, i) => (a[i] === ata ? null : acc)) };
      },
    };
    await expect(simulateAndCheck(closed, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({
      code: "USDC_CLOSED",
    });
  });
});

describe("assembly", () => {
  it("puts the session wallet as fee payer and only signer, v0, no lookup tables", () => {
    const tx = assembleTransaction(build.instructions, build.recentBlockhash, wallet);
    expect(tx.message.staticAccountKeys[0].toBase58()).toBe(wallet);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.version).toBe(0);
    // A message compiled with another payer is refused.
    const other = new TransactionMessage({
      payerKey: new PublicKey(randomKey()),
      recentBlockhash: build.recentBlockhash,
      instructions: [
        new TransactionInstruction({ programId: new PublicKey(MOCK_PROGRAM_ID), keys: [], data: Buffer.alloc(0) }),
      ],
    }).compileToV0Message();
    expect(() => checkMessageShape(other, wallet)).toThrow(TxRejected);
  });
});

describe("B3-05: token accounts must be the user's own USDC account", () => {
  const ataIx = (accts: string[]): PantaInstruction => ({
    programId: ATA_PROGRAM_ID,
    data: Buffer.from([1]).toString("base64"),
    accounts: accts.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 2 })),
  });
  const withAta = (accts: string[]) => [...build.instructions.filter((i) => i.programId !== ATA_PROGRAM_ID), ataIx(accts)];

  it("accepts creating the user's own USDC ATA", () => {
    const ata = associatedTokenAddress(wallet, USDC_MINT);
    expect(reject(withAta([wallet, ata, wallet, USDC_MINT, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID]))).toBe("ACCEPTED");
  });

  it("refuses the auditor's PoF: CreateIdempotent for a random owner and a random mint", () => {
    const owner = randomKey();
    const mint = randomKey();
    const foreign = associatedTokenAddress(owner, mint);
    expect(reject(withAta([wallet, foreign, owner, mint, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID]))).toBe("ATA_OWNER");
    const otherMint = associatedTokenAddress(wallet, mint);
    expect(reject(withAta([wallet, otherMint, wallet, mint, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID]))).toBe("ATA_MINT");
  });

  it("refuses a USDC ATA under Token-2022, or an address that isn't the derived ATA", () => {
    const ata22 = associatedTokenAddress(wallet, USDC_MINT, TOKEN_2022_PROGRAM_ID);
    expect(reject(withAta([wallet, ata22, wallet, USDC_MINT, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]))).toBe("ATA_IX");
    expect(reject(withAta([wallet, randomKey(), wallet, USDC_MINT, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID]))).toBe(
      "ATA_ADDRESS",
    );
  });

  it("refuses transfers from another account, under Token-2022, or of another mint", () => {
    const ata = associatedTokenAddress(wallet);
    const vault = mockVault(primaryMarket);
    const other = associatedTokenAddress(wallet, MOCK_OTHER_MINT);
    const t = (program: string, data: number[], accts: string[]) => [...build.instructions, tokenIx(program, data, accts)];
    expect(reject(t(TOKEN_PROGRAM_ID, [3, ...u64(1n)], [other, vault, wallet]), { maxUsdcOutBase: 10n ** 9n })).toBe(
      "TOKEN_SOURCE",
    );
    expect(reject(t(TOKEN_2022_PROGRAM_ID, [3, ...u64(1n)], [ata, vault, wallet]), { maxUsdcOutBase: 10n ** 9n })).toBe(
      "TOKEN_SOURCE",
    );
    expect(
      reject(t(TOKEN_PROGRAM_ID, [12, ...u64(1n), 6], [ata, MOCK_OTHER_MINT, vault, wallet]), { maxUsdcOutBase: 10n ** 9n }),
    ).toBe("TOKEN_MINT");
    expect(
      reject(t(TOKEN_PROGRAM_ID, [12, ...u64(1n), 6], [ata, USDC_MINT, vault, wallet]), { maxUsdcOutBase: 10n ** 9n }),
    ).toBe("ACCEPTED");
  });

  it("simulation refuses a 'USDC account' whose owner isn't the user", async () => {
    const chain = createMockChain();
    const tx = assembleTransaction(build.instructions, build.recentBlockhash, wallet);
    const fake = {
      ...chain,
      simulate: async (t: VersionedTransaction, addrs: string[]) => {
        const r = await chain.simulate(t, addrs);
        const data = Buffer.from(r.accounts[1]!.data);
        new PublicKey(randomKey()).toBuffer().copy(data, 32); // owner field
        r.accounts[1] = { ...r.accounts[1]!, data };
        return r;
      },
    };
    await expect(simulateAndCheck(fake, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({ code: "USDC_AUTHORITY" });
    // A freshly created account (no pre-state) is checked too.
    const fresh = { ...fake, getTokenAccounts: async () => [] };
    await expect(simulateAndCheck(fresh, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({ code: "USDC_ACCOUNT" });
  });
});

describe("B3-04: inner instructions (CPI) are checked against the allowlist", () => {
  const withInner = (programs: string[] | null) => {
    const chain = createMockChain();
    return {
      ...chain,
      simulate: async (t: VersionedTransaction, addrs: string[]) => {
        const r = await chain.simulate(t, addrs);
        return { ...r, innerPrograms: programs === null ? null : [...(r.innerPrograms ?? []), ...programs] };
      },
    };
  };
  const tx = () => assembleTransaction(build.instructions, build.recentBlockhash, wallet);

  it("the mock build's CPIs (Token, System) and a Panta self-CPI pass", async () => {
    await expect(simulateAndCheck(withInner([MOCK_PROGRAM_ID]), tx(), wallet, ctx.maxUsdcOutBase, 0n, PROGRAMS)).resolves
      .toBeTruthy();
  });

  it("a Panta program that CPIs into the Stake program (or anything else) is refused", async () => {
    const STAKE = "Stake11111111111111111111111111111111111111";
    await expect(simulateAndCheck(withInner([STAKE]), tx(), wallet, ctx.maxUsdcOutBase, 0n, PROGRAMS)).rejects
      .toMatchObject({ code: "UNEXPECTED_CPI" });
    await expect(simulateAndCheck(withInner([randomKey()]), tx(), wallet, ctx.maxUsdcOutBase, 0n, PROGRAMS)).rejects
      .toMatchObject({ code: "UNEXPECTED_CPI" });
    // Compute Budget is top-level only.
    await expect(
      simulateAndCheck(withInner(["ComputeBudget111111111111111111111111111111"]), tx(), wallet, ctx.maxUsdcOutBase, 0n, PROGRAMS),
    ).rejects.toMatchObject({ code: "UNEXPECTED_CPI" });
  });

  it("fails closed when the RPC returns no inner instructions", async () => {
    await expect(simulateAndCheck(withInner(null), tx(), wallet, ctx.maxUsdcOutBase, 0n, PROGRAMS)).rejects.toMatchObject({
      code: "INNER_UNAVAILABLE",
    });
    expect(() => checkInnerPrograms(undefined, PROGRAMS)).toThrow(TxRejected);
  });

  it("reads parsed and compiled RPC shapes; refuses unreadable ones", () => {
    const keys = [wallet, TOKEN_PROGRAM_ID, randomKey()];
    expect(innerProgramIds([{ index: 0, instructions: [{ programIdIndex: 1 }, { programId: new PublicKey(SYSTEM_PROGRAM_ID) }] }], keys)).toEqual([
      TOKEN_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
    ]);
    expect(innerProgramIds([], keys)).toEqual([]);
    for (const bad of [null, undefined, "x", [{ index: 0 }], [{ index: 0, instructions: [{ programIdIndex: 9 }] }], [{ index: 0, instructions: [{}] }]])
      expect(() => innerProgramIds(bad, keys)).toThrow(TxRejected);
  });
});
