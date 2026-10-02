/**
 * MOCK CHAIN (MOCK_PANTA=true and tests only). An in-memory stand-in for
 * Solana so the copy and claim flows run end to end without an RPC:
 *  - per-wallet USDC balances in real SPL token-account layout (so the same
 *    simulation checks in lib/tx-guard.ts run unchanged)
 *  - executes the handful of instructions our mock Panta builds use
 *  - `send` verifies ed25519 signatures like a validator would
 *  - `simulateSignAndSend` lands a message WITHOUT a wallet signature. This is
 *    the "simulated signing" of mock mode and exists only here.
 * Nothing here ever touches a network.
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import { randomBytes } from "node:crypto";
import { PublicKey, TransactionMessage, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import marketsJson from "@/fixtures/markets.json";
import positionsJson from "@/fixtures/positions.json";
import type { Chain, LandedTx } from "../chain";
import { payerUsdcOutFromMeta, type TokenBalanceRow } from "../landed";
import type { PantaPosition, Side } from "../schemas";
import {
  ATA_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  associatedTokenAddress,
} from "../solana-constants";
import { anchorDiscriminator, type AccountSnapshot, type SimulationResult } from "../tx-guard";

/** Fake program id used in mock instructions (never a real program). */
export const MOCK_PROGRAM_ID = "MockPanta1111111111111111111111111111111111";
/** A second token the demo wallet holds, so "no other token account changes" is exercised. */
export const MOCK_OTHER_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

export const MOCK_START_USDC = 250_000_000n; // 250 USDC
const MOCK_START_LAMPORTS = 1_000_000_000n; // 1 SOL
const BASE_FEE = 5_000n;
const TOKEN_ACCOUNT_RENT = 2_039_280n;

const DISC_BUY = anchorDiscriminator("primary_order_usdc");
const DISC_CLAIM = anchorDiscriminator("claim_win_usdc");

type TokenAcct = { mint: string; owner: string; amount: bigint };
type MockPosition = { marketId: string; side: Side; sharesBase: bigint; claimed: boolean };

type Ledger = {
  tokens: Map<string, TokenAcct>;
  lamports: Map<string, bigint>;
  positions: Map<string, Map<string, MockPosition>>; // wallet -> market|side
};

type MockChainState = Ledger & {
  landed: Map<string, LandedTx & { simulated: boolean }>;
  seeded: Set<string>;
};

// ---- fixture-derived outcomes (resolved markets) ----
const fixtureOutcomes = new Map<string, Side>();
for (const rows of Object.values(positionsJson as unknown as Record<string, PantaPosition[]>)) {
  for (const p of rows) if (p.outcome) fixtureOutcomes.set(p.marketId, p.outcome);
}
const marketPhase = new Map(
  (marketsJson as unknown as { marketId: string; phase: string }[]).map((m) => [m.marketId, m.phase]),
);

/** Mock markets' resolved outcome (fixtures), or null. */
export function mockOutcome(marketId: string): Side | null {
  return fixtureOutcomes.get(marketId) ?? null;
}

/** Token account data in SPL layout (165 bytes): mint, owner, amount, no delegate, initialized, no close authority. */
export function encodeTokenAccount(a: TokenAcct): Buffer {
  const b = Buffer.alloc(165);
  new PublicKey(a.mint).toBuffer().copy(b, 0);
  new PublicKey(a.owner).toBuffer().copy(b, 32);
  b.writeBigUInt64LE(a.amount, 64);
  b[108] = 1; // AccountState::Initialized
  return b;
}

export function mockVault(marketId: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), new PublicKey(marketId).toBuffer()],
    new PublicKey(MOCK_PROGRAM_ID),
  )[0].toBase58();
}
export function mockPositionPda(marketId: string, wallet: string, side: Side): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), new PublicKey(marketId).toBuffer(), new PublicKey(wallet).toBuffer(), Buffer.from(side)],
    new PublicKey(MOCK_PROGRAM_ID),
  )[0].toBase58();
}

function cloneLedger(l: Ledger): Ledger {
  return {
    tokens: new Map([...l.tokens].map(([k, v]) => [k, { ...v }])),
    lamports: new Map(l.lamports),
    positions: new Map([...l.positions].map(([w, m]) => [w, new Map([...m].map(([k, v]) => [k, { ...v }]))])),
  };
}

class MockTxError extends Error {
  constructor(
    readonly index: number,
    readonly reason: string,
  ) {
    super(`${reason} (instruction ${index})`);
  }
}

/** Run a message against a ledger (mutates it). Throws MockTxError on failure. */
function execute(l: Ledger, message: VersionedMessage, inner: string[] = []): void {
  const decoded = TransactionMessage.decompile(message);
  const payer = decoded.payerKey.toBase58();
  let cuPrice = 0n;
  let cuLimit = 200_000n;

  decoded.instructions.forEach((ix, i) => {
    const program = ix.programId.toBase58();
    const key = (n: number) => ix.keys[n]?.pubkey.toBase58() ?? "";
    const data = Buffer.from(ix.data);
    if (program === COMPUTE_BUDGET_PROGRAM_ID) {
      if (data[0] === 2) cuLimit = BigInt(data.readUInt32LE(1));
      if (data[0] === 3) cuPrice = data.readBigUInt64LE(1);
      return;
    }
    if (program === ATA_PROGRAM_ID) {
      inner.push(TOKEN_PROGRAM_ID); // the real ATA program CPIs Token (and System when it creates)
      const ata = key(1);
      if (!l.tokens.has(ata)) {
        inner.push(SYSTEM_PROGRAM_ID);
        l.tokens.set(ata, { mint: key(3), owner: key(2), amount: 0n });
        debitLamports(l, key(0), TOKEN_ACCOUNT_RENT, i);
      }
      return;
    }
    if (program === TOKEN_PROGRAM_ID || program === TOKEN_2022_PROGRAM_ID) {
      const [src, dst, auth] = data[0] === 12 ? [key(0), key(2), key(3)] : [key(0), key(1), key(2)];
      if (data[0] !== 3 && data[0] !== 12) {
        applyOtherTokenIx(l, data[0], src, dst, i);
        return;
      }
      moveTokens(l, src, dst, auth, data.readBigUInt64LE(1), i);
      return;
    }
    if (program === MOCK_PROGRAM_ID) {
      inner.push(TOKEN_PROGRAM_ID); // buy and claim move USDC through the Token program
      const disc = data.subarray(0, 8);
      const wallet = key(0);
      const market = key(1);
      if (disc.equals(DISC_BUY)) {
        const amount = data.readBigUInt64LE(8);
        const side: Side = data[16] === 1 ? "yes" : "no";
        const shares = data.readBigUInt64LE(17);
        if (marketPhase.get(market) !== "primary") throw new MockTxError(i, "MarketNotInPrimary");
        moveTokens(l, key(2), key(3), wallet, amount, i);
        const pos = positionsFor(l, wallet);
        const k = `${market}|${side}`;
        const prev = pos.get(k);
        pos.set(k, { marketId: market, side, sharesBase: (prev?.sharesBase ?? 0n) + shares, claimed: false });
        return;
      }
      if (disc.equals(DISC_CLAIM)) {
        const outcome = mockOutcome(market);
        const pos = outcome ? positionsFor(l, wallet).get(`${market}|${outcome}`) : undefined;
        if (!pos || pos.claimed) throw new MockTxError(i, "NotClaimable");
        const amount = data.readBigUInt64LE(8);
        if (amount !== pos.sharesBase) throw new MockTxError(i, "ClaimAmountMismatch");
        const ata = key(2);
        if (!l.tokens.has(ata)) throw new MockTxError(i, "AccountNotFound");
        l.tokens.get(ata)!.amount += amount; // 1 USDC per winning share
        pos.claimed = true;
        return;
      }
      throw new MockTxError(i, "UnknownInstruction");
    }
    throw new MockTxError(i, `UnsupportedProgram ${program}`);
  });

  debitLamports(l, payer, BASE_FEE + (cuPrice * cuLimit) / 1_000_000n, -1);
}

function positionsFor(l: Ledger, wallet: string) {
  let m = l.positions.get(wallet);
  if (!m) l.positions.set(wallet, (m = new Map()));
  return m;
}

function debitLamports(l: Ledger, who: string, amount: bigint, i: number) {
  const bal = l.lamports.get(who) ?? 0n;
  if (bal < amount) throw new MockTxError(i, "InsufficientFundsForFee");
  l.lamports.set(who, bal - amount);
}

function moveTokens(l: Ledger, src: string, dst: string, authority: string, amount: bigint, i: number) {
  const from = l.tokens.get(src);
  if (!from) throw new MockTxError(i, "AccountNotFound");
  if (from.owner !== authority) throw new MockTxError(i, "OwnerMismatch");
  if (from.amount < amount) throw new MockTxError(i, "InsufficientFunds");
  const to = l.tokens.get(dst) ?? { mint: from.mint, owner: "vault", amount: 0n };
  from.amount -= amount;
  to.amount += amount;
  l.tokens.set(dst, to);
}

/** Enough of Approve / SetAuthority / CloseAccount for tests to prove the guard would have caught them. */
function applyOtherTokenIx(l: Ledger, tag: number, src: string, _dst: string, i: number) {
  const acct = l.tokens.get(src);
  if (!acct) throw new MockTxError(i, "AccountNotFound");
  if (tag === 9) l.tokens.delete(src); // CloseAccount
  // Approve / SetAuthority change fields we don't model; the static guard rejects them first.
}

export type MockChain = Chain & {
  state: MockChainState;
  /** Give a wallet its demo balances and demo positions (idempotent). */
  seedWallet(wallet: string): void;
  /** Land an arbitrary message as if someone else sent it (tests). */
  landForeign(message: VersionedMessage, err?: unknown): string;
  /** Positions for a wallet (read by the mock Panta positions endpoint). */
  positionsOf(wallet: string): PantaPosition[];
  landedKind(signature: string): { kind: "buy" | "claim"; wallet: string; marketId: string; side: Side } | null;
};

/** Resolved fixture markets used for the demo claim (one win, one loss). */
function demoResolved(): { win?: [string, Side]; loss?: [string, Side] } {
  const resolved = [...fixtureOutcomes.entries()].filter(([id]) => marketPhase.get(id) === "resolved");
  const flip = (s: Side): Side => (s === "yes" ? "no" : "yes");
  return {
    win: resolved[0] ? [resolved[0][0], resolved[0][1]] : undefined,
    loss: resolved[1] ? [resolved[1][0], flip(resolved[1][1])] : undefined,
  };
}

export function createMockChain(): MockChain {
  const state: MockChainState = {
    tokens: new Map(),
    lamports: new Map(),
    positions: new Map(),
    landed: new Map(),
    seeded: new Set(),
  };

  function seedWallet(wallet: string) {
    if (state.seeded.has(wallet)) return;
    state.seeded.add(wallet);
    state.lamports.set(wallet, MOCK_START_LAMPORTS);
    state.tokens.set(associatedTokenAddress(wallet, USDC_MINT), {
      mint: USDC_MINT,
      owner: wallet,
      amount: MOCK_START_USDC,
    });
    state.tokens.set(associatedTokenAddress(wallet, MOCK_OTHER_MINT), {
      mint: MOCK_OTHER_MINT,
      owner: wallet,
      amount: 1_000_000_00000n,
    });
    // Demo holdings so the claim flow is demoable: one resolved win, one resolved loss.
    const { win, loss } = demoResolved();
    const pos = positionsFor(state, wallet);
    if (win)
      pos.set(`${win[0]}|${win[1]}`, { marketId: win[0], side: win[1], sharesBase: 18_400_000n, claimed: false });
    if (loss)
      pos.set(`${loss[0]}|${loss[1]}`, { marketId: loss[0], side: loss[1], sharesBase: 9_600_000n, claimed: false });
  }

  /** Token-balance rows for the message's accounts, shaped like RPC meta.pre/postTokenBalances. */
  const tokenRows = (l: Ledger, keys: string[]): TokenBalanceRow[] =>
    keys.flatMap((k, accountIndex) => {
      const t = l.tokens.get(k);
      return t ? [{ accountIndex, mint: t.mint, owner: t.owner, uiTokenAmount: { amount: t.amount.toString() } }] : [];
    });

  function land(message: VersionedMessage, signature: string, simulated: boolean) {
    if (state.landed.has(signature)) throw new Error("Transaction already processed");
    const keys = message.staticAccountKeys.map((k) => k.toBase58());
    const preTokenBalances = tokenRows(state, keys);
    const next = cloneLedger(state);
    let err: unknown = null;
    const inner: string[] = [];
    try {
      execute(next, message, inner);
      state.tokens = next.tokens;
      state.lamports = next.lamports;
      state.positions = next.positions;
    } catch (e) {
      err = e instanceof MockTxError ? { InstructionError: [e.index, e.reason] } : { error: String(e) };
    }
    // The same attribution code as the real RPC path (lib/landed.ts).
    const payerUsdcOutBase = payerUsdcOutFromMeta(
      { preTokenBalances, postTokenBalances: tokenRows(state, keys) },
      keys,
      keys[0],
    );
    state.landed.set(signature, {
      err,
      message,
      signatures: [signature],
      simulated,
      payerUsdcOutBase,
      innerPrograms: inner,
    });
    return signature;
  }

  const chain: MockChain = {
    state,
    seedWallet,

    async getTokenAccounts(owner): Promise<AccountSnapshot[]> {
      seedWallet(owner);
      return [...state.tokens]
        .filter(([, a]) => a.owner === owner)
        .map(([pubkey, a]) => ({ pubkey, data: encodeTokenAccount(a), lamports: Number(TOKEN_ACCOUNT_RENT) }));
    },

    async getPositionSharesBase(marketId, wallet, side) {
      seedWallet(wallet);
      const p = state.positions.get(wallet)?.get(`${marketId}|${side}`);
      return p && !p.claimed ? p.sharesBase : null;
    },

    async getLamports(owner) {
      seedWallet(owner);
      return Number(state.lamports.get(owner) ?? 0n);
    },

    async simulate(tx: VersionedTransaction, addresses: string[]): Promise<SimulationResult> {
      const next = cloneLedger(state);
      const inner: string[] = [];
      try {
        execute(next, tx.message, inner);
      } catch (e) {
        return {
          err: { InstructionError: [(e as MockTxError).index, (e as MockTxError).reason] },
          logs: [],
          accounts: [],
          innerPrograms: inner,
        };
      }
      return {
        err: null,
        logs: ["Program log: mock simulation"],
        innerPrograms: inner,
        accounts: addresses.map((a) => {
          const t = next.tokens.get(a);
          if (t) return { data: encodeTokenAccount(t), lamports: Number(TOKEN_ACCOUNT_RENT) };
          const lamports = next.lamports.get(a);
          return lamports === undefined ? null : { data: Buffer.alloc(0), lamports: Number(lamports) };
        }),
      };
    },

    async send(raw) {
      const tx = VersionedTransaction.deserialize(raw);
      const msg = tx.message.serialize();
      const n = tx.message.header.numRequiredSignatures;
      for (let i = 0; i < n; i++) {
        const ok = nacl.sign.detached.verify(msg, tx.signatures[i], tx.message.staticAccountKeys[i].toBytes());
        if (!ok) throw new Error("Transaction signature verification failure");
      }
      return land(tx.message, bs58.encode(tx.signatures[0]), false);
    },

    async waitForConfirmation(signature) {
      const t = state.landed.get(signature);
      if (!t) return "pending";
      return t.err ? "failed" : "confirmed";
    },

    async getLandedTransaction(signature) {
      const t = state.landed.get(signature);
      return t
        ? {
            err: t.err,
            message: t.message,
            signatures: t.signatures,
            // E-11: unknown stays unknown (fail closed), like the real RPC.
            payerUsdcOutBase: t.payerUsdcOutBase ?? null,
            innerPrograms: t.innerPrograms ?? null,
          }
        : null;
    },

    async simulateSignAndSend(messageBytes) {
      const message = VersionedMessage.deserialize(messageBytes);
      return land(message, bs58.encode(randomBytes(64)), true);
    },

    landForeign(message, err = null) {
      const sig = bs58.encode(randomBytes(64));
      state.landed.set(sig, { err, message, signatures: [sig], simulated: false });
      return sig;
    },

    positionsOf(wallet) {
      seedWallet(wallet);
      return [...(state.positions.get(wallet)?.values() ?? [])].map((p) => {
        const outcome = mockOutcome(p.marketId);
        const phase = (marketPhase.get(p.marketId) ?? "primary") as PantaPosition["phase"];
        return {
          marketId: p.marketId,
          category: null,
          side: p.side,
          shares: (Number(p.sharesBase) / 1e6).toFixed(2),
          phase,
          claimable: phase === "resolved" && outcome === p.side && !p.claimed,
          claimed: p.claimed,
          outcome: phase === "resolved" ? outcome : null,
        };
      });
    },

    landedKind(signature) {
      const t = state.landed.get(signature);
      if (!t || t.err) return null;
      const decoded = TransactionMessage.decompile(t.message);
      const ix = decoded.instructions.find((x) => x.programId.toBase58() === MOCK_PROGRAM_ID);
      if (!ix) return null;
      const data = Buffer.from(ix.data);
      const wallet = ix.keys[0].pubkey.toBase58();
      const marketId = ix.keys[1].pubkey.toBase58();
      if (data.subarray(0, 8).equals(DISC_BUY))
        return { kind: "buy", wallet, marketId, side: data[16] === 1 ? "yes" : "no" };
      if (data.subarray(0, 8).equals(DISC_CLAIM))
        return { kind: "claim", wallet, marketId, side: mockOutcome(marketId) ?? "yes" };
      return null;
    },
  };
  return chain;
}

/** One mock chain per server process (mock mode only). */
export function getSharedMockChain(): MockChain {
  const g = globalThis as unknown as { __copycallMockChain?: MockChain };
  return (g.__copycallMockChain ??= createMockChain());
}
