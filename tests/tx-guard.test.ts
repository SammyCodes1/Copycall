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
  checkInstructions,
  checkMessageShape,
  simulateAndCheck,
  type GuardContext,
} from "@/lib/tx-guard";
import marketsJson from "@/fixtures/markets.json";
import { testWallet } from "./helpers/wallet";

const primaryMarket = (marketsJson as { marketId: string; phase: string }[]).find(
  (m) => m.phase === "primary",
)!.marketId;
const PROGRAMS = new Set([MOCK_PROGRAM_ID]);
const randomKey = () => bs58.encode(randomBytes(32));

let wallet: string;
let build: BuildResponse;
let ctx: GuardContext;

beforeAll(async () => {
  wallet = testWallet().address;
  const q = await panta.quotePrimaryOrder({ wallet, marketId: primaryMarket, side: "yes", amountUsdc: "5.00" });
  build = await panta.buildPrimaryOrder({ quoteId: q.quoteId, wallet, maxSlippageBps: 200 });
  ctx = {
    kind: "copy",
    feePayer: wallet,
    marketId: primaryMarket,
    pantaProgramIds: PROGRAMS,
    maxUsdcOutBase: usdcToBase("5.00") + usdcToBase(q.feeUsdc),
  };
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
    expect(reject([...build.instructions, ok])).toBe("ACCEPTED");
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

  it("reject when simulation spends more than max stake + quoted fee (static checks can't see it)", async () => {
    const ixs = structuredClone(build.instructions);
    const data = Buffer.from(ixs[3].data, "base64");
    data.writeBigUInt64LE(ctx.maxUsdcOutBase + 1n, 8); // the program would pull more than quoted
    ixs[3].data = data.toString("base64");
    expect(reject(ixs)).toBe("ACCEPTED");
    const tx = assembleTransaction(ixs, build.recentBlockhash, wallet);
    await expect(simulateAndCheck(chain, tx, wallet, ctx.maxUsdcOutBase)).rejects.toMatchObject({ code: "OVER_STAKE" });
  });

  it("reject when another token account the user owns changes", async () => {
    const other = associatedTokenAddress(wallet, MOCK_OTHER_MINT);
    const ix = tokenIx(TOKEN_PROGRAM_ID, [3, ...u64(1n)], [other, mockVault(primaryMarket), wallet]);
    const ixs = [...build.instructions, ix];
    expect(reject(ixs)).toBe("ACCEPTED");
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
