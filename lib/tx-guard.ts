/**
 * Transaction guard (hard requirement 3 + SECURITY ADDENDUM A and C).
 *
 * Panta's build endpoints return INSTRUCTIONS, not a transaction. We assemble
 * the v0 transaction ourselves (fee payer = the signed-in wallet), check every
 * instruction against a strict allowlist, simulate it, and only then hand the
 * exact bytes to the wallet. The same program/signer checks run again on the
 * transaction fetched from chain at confirm time.
 *
 * Pure module: no RPC and no env. Chain access is injected (see ChainReader).
 */
import { createHash } from "node:crypto";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { outflowBase, type FeeModel } from "./copy-math";
import type { PantaInstruction } from "./schemas";
import {
  ATA_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  associatedTokenAddress,
} from "./solana-constants";

export type TxKind = "copy" | "claim";

/** Panta instruction names per flow (docs: primary_order_usdc, claim_win_usdc). */
export const PANTA_IX_NAMES: Record<TxKind, string> = {
  copy: "primary_order_usdc",
  claim: "claim_win_usdc",
};

/** Largest priority fee we let a build ask the user to pay (0.001 SOL). */
export const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
/** Largest SOL spend allowed in simulation: tx fee + rent for new accounts (0.02 SOL). */
export const MAX_SOL_SPEND_LAMPORTS = 20_000_000n;
export const MAX_INSTRUCTIONS = 12;
/** Token accounts we are willing to check in one simulation. More than this fails closed. */
export const MAX_TOKEN_ACCOUNTS_CHECKED = 100;

/** A rejected transaction. `code` is stable (tests, logs); `message` is shown to the user. */
export class TxRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TxRejected";
  }
}

/**
 * Anchor instruction discriminator: sha256("global:<name>")[0..8].
 * ASSUMPTION (flagged for the Auditor): Panta's program is an Anchor program
 * and uses these instruction names. If not, builds fail closed here.
 */
export function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type GuardContext = {
  kind: TxKind;
  feePayer: string; // the session wallet
  marketId: string; // from OUR stored trade / the claim request, never from the build response
  pantaProgramIds: ReadonlySet<string>;
  /**
   * Most USDC (base units) the user may send via top-level token transfers.
   * Copies: the approved max stake, fee included, in every fee model
   * (lib/copy-math.ts copyUsdcLimitBase). 0 for claims.
   */
  maxUsdcOutBase: bigint;
  /**
   * Copies only (required): the quoted deposit and fee and the fee model they were
   * detected under. The static check counts the Panta instruction's own deposit
   * (+ the fee when it's on top) toward the limit, not just top-level transfers.
   */
  copyOutflow?: { model: FeeModel; depositBase: bigint; feeBase: bigint };
  /**
   * Copies only (required): what the user saw on the review screen. The
   * primary_order_usdc arguments are decoded strictly (PRIMARY_ORDER_LAYOUT) and
   * must match: same side, slippage no looser than the setting, and a minimum
   * share count no lower than the displayed "Min. shares" (micro-shares).
   */
  copyTerms?: { side: "yes" | "no"; maxSlippageBps: number; minSharesBase: bigint };
  /** Claims only (required): winning shares in base units. The claim must pay at least this into the user's USDC ATA. */
  claimMinUsdcInBase?: bigint;
};

/**
 * ASSUMED Anchor argument layout of primary_order_usdc (flagged for the Auditor;
 * Panta doesn't publish its IDL). Borsh, little-endian, exactly 27 bytes:
 *   [0..8)   discriminator  sha256("global:primary_order_usdc")[0..8]
 *   [8..16)  amount         u64, USDC base units: the deposit (must equal the quote)
 *   [16]     side           u8, 1 = YES, 0 = NO (anything else is refused)
 *   [17..25) shares         u64, expected shares in micro-shares (must be > 0)
 *   [25..27) max_slippage   u16, bps; the program fills at least
 *                           shares * (10000 - max_slippage) / 10000
 * Any other length or value fails closed: if the real layout differs, every copy
 * build is refused here rather than signed on a guess.
 */
export const PRIMARY_ORDER_LAYOUT = { length: 27, amount: 8, side: 16, shares: 17, slippage: 25 } as const;

export type PrimaryOrderArgs = { amount: bigint; side: "yes" | "no"; shares: bigint; slippageBps: number };

/** Strict decode of primary_order_usdc data (discriminator already checked). Throws TxRejected. */
export function decodePrimaryOrder(data: Buffer): PrimaryOrderArgs {
  const L = PRIMARY_ORDER_LAYOUT;
  if (data.length !== L.length) throw new TxRejected("ORDER_ARGS", "Order data has an unexpected layout");
  const sideByte = data[L.side];
  if (sideByte !== 0 && sideByte !== 1) throw new TxRejected("ORDER_ARGS", "Order side is unreadable");
  return {
    amount: data.readBigUInt64LE(L.amount),
    side: sideByte === 1 ? "yes" : "no",
    shares: data.readBigUInt64LE(L.shares),
    slippageBps: data.readUInt16LE(L.slippage),
  };
}

/** Least shares the order accepts on chain, per the assumed layout. */
export function orderMinSharesBase(a: PrimaryOrderArgs): bigint {
  if (a.slippageBps > 10_000) return 0n;
  return (a.shares * BigInt(10_000 - a.slippageBps)) / 10_000n;
}

const u64 = (b: Buffer, at: number) => b.readBigUInt64LE(at);

/** Static allowlist checks on the instructions Panta returned. Throws TxRejected. */
export function checkInstructions(ixs: PantaInstruction[], ctx: GuardContext): void {
  if (ixs.length === 0 || ixs.length > MAX_INSTRUCTIONS)
    throw new TxRejected("IX_COUNT", "Unexpected number of instructions");

  const allowed = new Set([
    ...ctx.pantaProgramIds,
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ATA_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID,
  ]);
  const disc = anchorDiscriminator(PANTA_IX_NAMES[ctx.kind]);

  // Accounts referenced by Panta instructions: the only valid token-transfer destinations.
  const pantaAccounts = new Set<string>();
  let pantaMain = 0;
  for (const ix of ixs) {
    if (!allowed.has(ix.programId)) throw new TxRejected("UNKNOWN_PROGRAM", `Unknown program ${ix.programId}`);
    for (const a of ix.accounts) {
      if (a.isSigner && a.pubkey !== ctx.feePayer)
        throw new TxRejected("EXTRA_SIGNER", "Transaction asks for another signer");
    }
    if (ctx.pantaProgramIds.has(ix.programId)) {
      const data = Buffer.from(ix.data, "base64");
      if (data.length < 8 || !data.subarray(0, 8).equals(disc)) {
        throw new TxRejected(
          "UNEXPECTED_PANTA_IX",
          `Unexpected Panta instruction (expected ${PANTA_IX_NAMES[ctx.kind]})`,
        );
      }
      const keys = ix.accounts.map((a) => a.pubkey);
      if (!keys.includes(ctx.marketId))
        throw new TxRejected("MARKET_MISMATCH", "Instruction is for a different market");
      if (!keys.includes(ctx.feePayer))
        throw new TxRejected("WALLET_MISMATCH", "Instruction is for a different wallet");
      keys.forEach((k) => pantaAccounts.add(k));
      pantaMain++;
    }
  }
  if (pantaMain !== 1) throw new TxRejected("PANTA_IX_COUNT", "Expected exactly one Panta instruction");

  let cuLimit: bigint | null = null;
  let cuPrice: bigint | null = null;
  let tokenOut = 0n;
  let expectedOut = 0n; // what the fee model says the order costs, from the decoded deposit
  const main = ixs.find((ix) => ctx.pantaProgramIds.has(ix.programId))!;
  if (ctx.kind === "copy") {
    // Strict decode of primary_order_usdc (layout above). Fails closed.
    if (!ctx.copyOutflow) throw new TxRejected("NO_FEE_MODEL", "No fee model for this copy");
    if (!ctx.copyTerms) throw new TxRejected("NO_ORDER_TERMS", "No order terms for this copy");
    const args = decodePrimaryOrder(Buffer.from(main.data, "base64"));
    if (args.amount !== ctx.copyOutflow.depositBase || args.amount > ctx.maxUsdcOutBase)
      throw new TxRejected("DEPOSIT_MISMATCH", "Order amount doesn't match the quote");
    if (args.side !== ctx.copyTerms.side) throw new TxRejected("SIDE_MISMATCH", "Order is for the other side");
    if (args.shares <= 0n) throw new TxRejected("ZERO_SHARES", "Order buys no shares");
    if (args.slippageBps > ctx.copyTerms.maxSlippageBps)
      throw new TxRejected("SLIPPAGE_TOO_HIGH", "Order allows more slippage than your setting");
    if (orderMinSharesBase(args) < ctx.copyTerms.minSharesBase)
      throw new TxRejected("MIN_SHARES_TOO_LOW", "Order accepts fewer shares than the review shows");
    tokenOut += args.amount; // the Panta instruction's own USDC deposit
    expectedOut = outflowBase(ctx.copyOutflow.model, args.amount, ctx.copyOutflow.feeBase);
  } else {
    // B3-03: the payout must go to the user's own USDC ATA, and that ATA must be in the claim.
    if (ctx.claimMinUsdcInBase === undefined || ctx.claimMinUsdcInBase <= 0n)
      throw new TxRejected("NO_CLAIM_AMOUNT", "No claim amount to check");
    if (!main.accounts.some((a) => a.pubkey === associatedTokenAddress(ctx.feePayer, USDC_MINT) && a.isWritable))
      throw new TxRejected("PAYOUT_ACCOUNT", "The claim doesn't pay into your USDC account");
  }
  for (const ix of ixs) {
    const data = Buffer.from(ix.data, "base64");
    const acct = (i: number) => ix.accounts[i]?.pubkey;
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID: {
        // Only SetComputeUnitLimit (2, u32) and SetComputeUnitPrice (3, u64), once each.
        if (data[0] === 2 && data.length === 5 && cuLimit === null) cuLimit = BigInt(data.readUInt32LE(1));
        else if (data[0] === 3 && data.length === 9 && cuPrice === null) cuPrice = u64(data, 1);
        else throw new TxRejected("COMPUTE_BUDGET_IX", "Unexpected compute-budget instruction");
        break;
      }
      case ATA_PROGRAM_ID: {
        // Only CreateIdempotent (1): [payer, ata, owner, mint, system, token program].
        if (data.length !== 1 || data[0] !== 1)
          throw new TxRejected("ATA_IX", "Only idempotent token-account creation is allowed");
        if (acct(0) !== ctx.feePayer)
          throw new TxRejected("ATA_IX", "Token-account creation must be paid by your wallet");
        const tokenProgram = acct(5);
        if (tokenProgram !== TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM_ID)
          throw new TxRejected("ATA_IX", "Bad token program");
        break;
      }
      case TOKEN_PROGRAM_ID:
      case TOKEN_2022_PROGRAM_ID: {
        // Only Transfer (3) and TransferChecked (12) into an account the Panta
        // instruction uses. Approve, ApproveChecked, SetAuthority, CloseAccount
        // and every other token instruction are rejected (Token-2022 too).
        let dest: string | undefined;
        let authority: string | undefined;
        if (data[0] === 3 && data.length === 9) [dest, authority] = [acct(1), acct(2)];
        else if (data[0] === 12 && data.length === 10) [dest, authority] = [acct(2), acct(3)];
        else throw new TxRejected("TOKEN_IX", tokenIxName(data[0]) + " is not allowed");
        if (!dest || !pantaAccounts.has(dest))
          throw new TxRejected("EXTRA_TRANSFER", "Token transfer to an account the order doesn't use");
        if (authority === ctx.feePayer) tokenOut += u64(data, 1);
        break;
      }
      case SYSTEM_PROGRAM_ID:
        // The System program may appear as an account (ATA creation, rent), but a
        // top-level System instruction (e.g. a SOL transfer) is never needed.
        throw new TxRejected("SYSTEM_IX", "Direct System program instructions are not allowed");
      default:
        break; // the Panta instruction, checked above
    }
  }
  if (cuPrice !== null) {
    const fee = (cuPrice * (cuLimit ?? 1_400_000n)) / 1_000_000n; // micro-lamports per CU
    if (fee > MAX_PRIORITY_FEE_LAMPORTS) throw new TxRejected("PRIORITY_FEE", "Priority fee is too high");
  }
  // Actual outflow seen statically: the decoded deposit + every top-level transfer the user signs.
  // An on-top fee charged inside the program (not as a top-level transfer) is counted from the quote.
  if (expectedOut > tokenOut) tokenOut = expectedOut;
  if (tokenOut > ctx.maxUsdcOutBase) throw new TxRejected("OVER_STAKE", "Transfers more than your max stake");
}

function tokenIxName(tag: number | undefined): string {
  const names: Record<number, string> = {
    4: "Approve",
    6: "SetAuthority",
    7: "MintTo",
    8: "Burn",
    9: "CloseAccount",
    13: "ApproveChecked",
  };
  return tag !== undefined && names[tag] ? names[tag] : `Token instruction ${tag ?? "?"}`;
}

/** Build the v0 transaction (fee payer = session wallet) from checked instructions. */
export function assembleTransaction(
  ixs: PantaInstruction[],
  recentBlockhash: string,
  feePayer: string,
): VersionedTransaction {
  const instructions = ixs.map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        data: Buffer.from(ix.data, "base64"),
        keys: ix.accounts.map((a) => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: a.isSigner,
          isWritable: a.isWritable,
        })),
      }),
  );
  const message = new TransactionMessage({
    payerKey: new PublicKey(feePayer),
    recentBlockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  checkMessageShape(tx.message, feePayer);
  return tx;
}

/** Fee payer is the session wallet and is the ONLY signer; no lookup tables. */
export function checkMessageShape(message: VersionedMessage, wallet: string): void {
  if (message.header.numRequiredSignatures !== 1)
    throw new TxRejected("SIGNERS", "Transaction needs more than your signature");
  if (message.staticAccountKeys[0]?.toBase58() !== wallet)
    throw new TxRejected("FEE_PAYER", "Fee payer is not your wallet");
  if (message.addressTableLookups.length > 0)
    throw new TxRejected("LOOKUP_TABLES", "Address lookup tables are not allowed");
}

/** Programs invoked by a compiled message (for the confirm-time re-check). */
export function invokedPrograms(message: VersionedMessage): string[] {
  const keys = message.staticAccountKeys;
  return message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58() ?? "?");
}

/** Confirm-time program check on the transaction as it landed on chain (addendum C). */
export function checkLandedPrograms(message: VersionedMessage, pantaProgramIds: ReadonlySet<string>): void {
  const allowed = new Set([
    ...pantaProgramIds,
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ATA_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID,
  ]);
  for (const p of invokedPrograms(message)) {
    if (!allowed.has(p)) throw new TxRejected("UNKNOWN_PROGRAM", `Unknown program ${p}`);
  }
}

// ---------------------------------------------------------------- simulation

export type AccountSnapshot = { pubkey: string; data: Buffer; lamports: number };
export type SimulationResult = {
  err: unknown | null;
  logs: string[];
  /** Post-state, in the order of the addresses passed in; null = account doesn't exist. */
  accounts: ({ data: Buffer; lamports: number } | null)[];
};

/** What the guard needs from chain (real RPC or the mock chain). */
export interface ChainReader {
  /** Every SPL Token and Token-2022 account owned by `owner`, with raw data. */
  getTokenAccounts(owner: string): Promise<AccountSnapshot[]>;
  getLamports(owner: string): Promise<number>;
  simulate(tx: VersionedTransaction, addresses: string[]): Promise<SimulationResult>;
}

// SPL token account layout: mint 0..32, owner 32..64, amount 64..72, then delegate/state/close authority.
const AMOUNT_START = 64;
const AMOUNT_END = 72;
const readAmount = (data: Buffer) => (data.length >= AMOUNT_END ? data.readBigUInt64LE(AMOUNT_START) : 0n);
const withoutAmount = (data: Buffer) => Buffer.concat([data.subarray(0, AMOUNT_START), data.subarray(AMOUNT_END)]);

export type SimulationCheck = {
  usdcAta: string;
  usdcBefore: bigint;
  usdcAfter: bigint;
  /** Positive = USDC left the wallet. */
  usdcDecrease: bigint;
  lamportsSpent: bigint;
  accountsChecked: number;
};

/**
 * Simulate the exact transaction and require (addendum A):
 *  - success
 *  - the user's USDC decrease <= maxUsdcDecreaseBase (copies: the max stake, fee and
 *    slippage inside it, in every fee model; claims: 0)
 *  - claims: the user's own USDC ATA (associatedTokenAddress(wallet, USDC_MINT))
 *    increases by at least minUsdcIncreaseBase (the winning shares, B3-03)
 *  - the USDC account keeps its owner, delegate and close authority (only the amount may change)
 *  - no other user-owned token account changes at all
 *  - SOL spent stays under MAX_SOL_SPEND_LAMPORTS
 */
export async function simulateAndCheck(
  chain: ChainReader,
  tx: VersionedTransaction,
  wallet: string,
  maxUsdcDecreaseBase: bigint,
  minUsdcIncreaseBase = 0n,
): Promise<SimulationCheck> {
  const usdcAta = associatedTokenAddress(wallet, USDC_MINT);
  const [tokenAccounts, lamportsBefore] = await Promise.all([
    chain.getTokenAccounts(wallet),
    chain.getLamports(wallet),
  ]);
  if (tokenAccounts.length > MAX_TOKEN_ACCOUNTS_CHECKED) {
    throw new TxRejected("TOO_MANY_ACCOUNTS", "Too many token accounts to verify safely");
  }
  const pre = new Map(tokenAccounts.map((a) => [a.pubkey, a]));
  const addresses = [wallet, usdcAta, ...tokenAccounts.map((a) => a.pubkey).filter((p) => p !== usdcAta)];

  const sim = await chain.simulate(tx, addresses);
  if (sim.err !== null)
    throw new TxRejected("SIMULATION_FAILED", "Simulation failed: the transaction would not succeed");
  if (sim.accounts.length !== addresses.length)
    throw new TxRejected("SIMULATION_ACCOUNTS", "Simulation returned the wrong accounts");

  const walletAfter = sim.accounts[0];
  const lamportsSpent = BigInt(lamportsBefore) - BigInt(walletAfter?.lamports ?? 0);
  if (lamportsSpent > MAX_SOL_SPEND_LAMPORTS) throw new TxRejected("SOL_SPEND", "Transaction spends too much SOL");

  // USDC account: only the amount may change, and not by more than allowed.
  const usdcPre = pre.get(usdcAta);
  const usdcPost = sim.accounts[1];
  if (usdcPre && !usdcPost) throw new TxRejected("USDC_CLOSED", "Transaction closes your USDC account");
  if (usdcPre && usdcPost && !withoutAmount(usdcPre.data).equals(withoutAmount(usdcPost.data))) {
    throw new TxRejected("USDC_AUTHORITY", "Transaction changes your USDC account's owner or delegate");
  }
  const usdcBefore = usdcPre ? readAmount(usdcPre.data) : 0n;
  const usdcAfter = usdcPost ? readAmount(usdcPost.data) : 0n;
  const usdcDecrease = usdcBefore - usdcAfter;
  if (usdcDecrease > maxUsdcDecreaseBase)
    throw new TxRejected("OVER_STAKE", "Simulation spends more USDC than allowed");
  if (minUsdcIncreaseBase > 0n && -usdcDecrease < minUsdcIncreaseBase)
    throw new TxRejected("PAYOUT_TOO_LOW", "Simulation doesn't pay your winnings into your USDC account");

  // Every other token account the user owns must be byte-for-byte unchanged.
  for (let i = 2; i < addresses.length; i++) {
    const before = pre.get(addresses[i]);
    const after = sim.accounts[i];
    if (!before || !after || !before.data.equals(after.data)) {
      throw new TxRejected("OTHER_ACCOUNT_CHANGED", "Transaction changes another token account you own");
    }
  }
  return { usdcAta, usdcBefore, usdcAfter, usdcDecrease, lamportsSpent, accountsChecked: addresses.length - 1 };
}
