/**
 * F-02: a USDC ATA created in the same transaction must match a fresh-account
 * template after simulation (owner = user, mint = USDC, no delegate, delegated
 * amount 0, no close authority, initialized, not native, SPL Token owned).
 */
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { encodeTokenAccount } from "@/lib/mock/chain-mock";
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT } from "@/lib/solana-constants";
import { TxRejected, isFreshTokenAccountTail, simulateAndCheck, type ChainReader } from "@/lib/tx-guard";

const wallet = Keypair.generate().publicKey;
const W = wallet.toBase58();
const tx = new VersionedTransaction(
  new TransactionMessage({ payerKey: wallet, recentBlockhash: bs58.encode(Buffer.alloc(32, 2)), instructions: [] }).compileToV0Message(),
);
const fresh = (amount = 18_400_000n) => encodeTokenAccount({ mint: USDC_MINT, owner: W, amount });

/** A chain where the user has NO token accounts before the tx and the ATA appears in the post-state. */
function chainWith(post: Buffer, owner = TOKEN_PROGRAM_ID): ChainReader {
  return {
    getTokenAccounts: async () => [],
    getLamports: async () => 1_000_000_000,
    simulate: async () => ({
      err: null,
      logs: [],
      innerPrograms: [TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID],
      innerSystemOps: [],
      tokenAuthorityOps: [],
      accounts: [
        { data: Buffer.alloc(0), lamports: 997_000_000, owner: SYSTEM_PROGRAM_ID, executable: false },
        { data: post, lamports: 2_039_280, owner, executable: false },
      ],
    }),
  };
}
const claim = (c: ChainReader) => simulateAndCheck(c, tx, W, 0n, 18_400_000n);
async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof TxRejected) return e.code;
    throw e;
  }
}
const attacker = () => new PublicKey(Keypair.generate().publicKey.toBytes()).toBuffer();

describe("F-02: fresh USDC ATA template", () => {
  it("an honest fresh ATA that receives the payout passes", async () => {
    expect(isFreshTokenAccountTail(fresh())).toBe(true);
    expect(await codeOf(claim(chainWith(fresh())))).toBe("OK");
  });

  it("a delegate (with u64::MAX delegated) set by CPI is refused", async () => {
    const d = fresh();
    d.writeUInt32LE(1, 72);
    attacker().copy(d, 76);
    d.writeBigUInt64LE(0xffffffffffffffffn, 121);
    expect(await codeOf(claim(chainWith(d)))).toBe("USDC_NEW_ACCOUNT");
  });

  it("a close authority is refused", async () => {
    const d = fresh();
    d.writeUInt32LE(1, 129);
    attacker().copy(d, 133);
    expect(await codeOf(claim(chainWith(d)))).toBe("USDC_NEW_ACCOUNT");
  });

  it("a delegated amount alone, a frozen or uninitialized state, or a native account is refused", async () => {
    const amt = fresh();
    amt.writeBigUInt64LE(1n, 121);
    expect(await codeOf(claim(chainWith(amt)))).toBe("USDC_NEW_ACCOUNT");
    for (const state of [0, 2]) {
      const d = fresh();
      d[108] = state;
      expect(await codeOf(claim(chainWith(d)))).toBe("USDC_NEW_ACCOUNT");
    }
    const native = fresh();
    native.writeUInt32LE(1, 109);
    native.writeBigUInt64LE(2_039_280n, 113);
    expect(await codeOf(claim(chainWith(native)))).toBe("USDC_NEW_ACCOUNT");
  });

  it("extension bytes (not 165 bytes) are refused", async () => {
    expect(await codeOf(claim(chainWith(Buffer.concat([fresh(), Buffer.alloc(10)]))))).toBe("USDC_NEW_ACCOUNT");
  });

  it("a Token-2022-owned account, the wrong mint or the wrong owner is refused", async () => {
    expect(await codeOf(claim(chainWith(fresh(), TOKEN_2022_PROGRAM_ID)))).toBe("USDC_ACCOUNT");
    const mint = fresh();
    attacker().copy(mint, 0);
    expect(await codeOf(claim(chainWith(mint)))).toBe("USDC_ACCOUNT");
    const owner = fresh();
    attacker().copy(owner, 32);
    expect(await codeOf(claim(chainWith(owner)))).toBe("USDC_ACCOUNT");
  });

  it("an existing ATA keeps its own delegate rules (only the amount may change)", async () => {
    const pre = fresh(5_000_000n);
    const post = fresh(5_000_000n + 18_400_000n);
    const c: ChainReader = {
      ...chainWith(post),
      getTokenAccounts: async () => [{ pubkey: (await import("@/lib/solana-constants")).associatedTokenAddress(W, USDC_MINT), data: pre, lamports: 2_039_280 }],
    };
    expect(await codeOf(claim(c))).toBe("OK");
  });
});
