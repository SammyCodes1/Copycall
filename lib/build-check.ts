/**
 * Build-and-simulate-only check of ONE copy against live Panta and the RPC
 * (scripts/panta-build-check.mjs). It quotes, builds, assembles the exact
 * transaction the app would hand to a wallet, simulates it (sigVerify false)
 * and runs the full transaction guard. It never signs or broadcasts: it has no
 * private key and no send path.
 *
 * Pure apart from the injected Panta functions and chain reader, so tests run it
 * against the mock chain with tampered builds.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import { copyAmounts, outflowBase, toMicro, usdcExact } from "./copy-math";
import { FeeModelError, quoteWithinStake, type PinnedFeeModel } from "./fee-quote";
import type { BuildRequest, BuildResponse, QuoteRequest, QuoteResponse } from "./schemas";
import { MAX_SLIPPAGE_BPS } from "./schemas";
import { USDC_MINT, TOKEN_PROGRAM_ID, associatedTokenAddress } from "./solana-constants";
import {
  PANTA_ACCOUNT_ROLES,
  PANTA_IX_NAMES,
  TxRejected,
  assembleTransaction,
  checkInstructions,
  decodePrimaryOrder,
  orderMinSharesBase,
  simulateAndCheck,
  type ChainReader,
  type SimulationResult,
} from "./tx-guard";

/** The check script never builds above this, whatever the deployment's cap. */
export const BUILD_CHECK_MAX_USDC = "5";

export type BuildCheckOptions = {
  marketId: string;
  side: "yes" | "no";
  amountUsdc: string; // plain decimal, <= BUILD_CHECK_MAX_USDC
  wallet: string;
  slippageBps: number;
  pinned: PinnedFeeModel;
  feeCapBps: number;
  pantaProgramIds: ReadonlySet<string>;
  /** MAX_STAKE_USDC (launch cap) in base units; the amount must also be at or under it. */
  maxStakeCapBase?: bigint;
};

export type BuildCheckDeps = {
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  build(req: BuildRequest): Promise<BuildResponse>;
  chain: ChainReader;
};

export type CheckLine = { name: string; ok: boolean; detail: string };
export type BuildCheckReport = {
  ok: boolean;
  failed: string | null; // "<check>: <code>"
  checks: CheckLine[];
  feeModel?: string;
  quotes?: number;
  order?: { amount: string; side: string; shares: string; slippageBps: number; minShares: string };
  roles?: { slot: number; role: string; expected: string; actual: string; ok: boolean }[];
  innerPrograms?: string[] | null;
  usdcDelta?: string; // negative = leaves the wallet
  solSpentLamports?: string;
  simulationLogs?: string[];
};

const AMOUNT_RE = /^\d{1,4}(\.\d{1,2})?$/;

/** Validates the amount: plain decimal, at most 2 dp, > 0 and <= the check's own cap. */
export function parseCheckAmount(v: string): bigint {
  if (!AMOUNT_RE.test(v)) throw new Error("--amount must be a plain decimal with at most 2 decimals");
  const base = toMicro(v);
  if (base <= 0n) throw new Error("--amount must be above 0");
  if (base > toMicro(BUILD_CHECK_MAX_USDC)) throw new Error(`--amount must be at most ${BUILD_CHECK_MAX_USDC}`);
  return base;
}

class CheckFailed extends Error {
  constructor(
    readonly check: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function runBuildCheck(o: BuildCheckOptions, deps: BuildCheckDeps): Promise<BuildCheckReport> {
  const report: BuildCheckReport = { ok: false, failed: null, checks: [] };
  const pass = (name: string, detail: string) => report.checks.push({ name, ok: true, detail });
  try {
    const stake = parseCheckAmount(o.amountUsdc);
    if (o.maxStakeCapBase !== undefined && stake > o.maxStakeCapBase)
      throw new CheckFailed("input", "STAKE_ABOVE_CAP", `amount is above MAX_STAKE_USDC (${usdcExact(o.maxStakeCapBase)})`);
    if (!Number.isInteger(o.slippageBps) || o.slippageBps < 0 || o.slippageBps > MAX_SLIPPAGE_BPS)
      throw new CheckFailed("input", "SLIPPAGE", `slippage must be 0..${MAX_SLIPPAGE_BPS} bps`);

    // 1. Quote (the app's own logic: one quote, plus one re-quote when the fee is on top).
    let w;
    try {
      w = await quoteWithinStake(
        async (amountUsdc) => {
          const q = await deps.quote({ wallet: o.wallet, marketId: o.marketId, side: o.side, amountUsdc });
          if (q.marketId !== o.marketId || q.side.toLowerCase() !== o.side)
            throw new FeeModelError("QUOTE_MISMATCH", "Panta returned a quote for a different order");
          return q;
        },
        stake,
        { pinned: o.pinned, feeCapBps: o.feeCapBps },
      );
    } catch (err) {
      if (err instanceof FeeModelError)
        throw new CheckFailed("quote", err.code, `${err.message}${err.detected ? ` (read: ${err.detected})` : ""}`);
      throw err;
    }
    report.feeModel = w.model;
    report.quotes = w.quotes;
    pass("quote", `fee model ${w.model} (pinned ${o.pinned}), deposit ${usdcExact(w.depositBase)}, fee ${usdcExact(w.feeBase)}, outflow ${usdcExact(w.outflowBase)} <= ${usdcExact(stake)}, ${w.quotes} quote call(s)`);

    // 2. Build, and it must be the quoted order.
    const b = await deps.build({ quoteId: w.quote.quoteId, wallet: o.wallet, maxSlippageBps: o.slippageBps });
    if (
      b.wallet !== o.wallet ||
      b.marketId !== o.marketId ||
      b.side.toLowerCase() !== o.side ||
      toMicro(String(b.amountUsdc)) !== w.depositBase ||
      toMicro(b.feeUsdc) !== w.feeBase ||
      b.quoteId !== w.quote.quoteId
    )
      throw new CheckFailed("build", "BUILD_MISMATCH", "Panta built a different order than the one quoted");
    const minSharesBase = toMicro(
      copyAmounts({
        feeModel: w.model,
        depositUsdc: usdcExact(w.depositBase),
        feeUsdc: w.quote.feeUsdc,
        avgPrice: w.quote.avgPrice,
        shares: w.quote.shares,
        slippageBps: o.slippageBps,
      }).minShares,
    );
    pass("build", `${b.instructions.length} instruction(s), matches the quote`);

    // 3. Decoded order args and account roles of the Panta instruction (informational, then enforced below).
    const main = b.instructions.find((ix) => o.pantaProgramIds.has(ix.programId));
    if (main) {
      try {
        const a = decodePrimaryOrder(Buffer.from(main.data, "base64"));
        report.order = {
          amount: usdcExact(a.amount),
          side: a.side,
          shares: usdcExact(a.shares),
          slippageBps: a.slippageBps,
          minShares: usdcExact(orderMinSharesBase(a)),
        };
      } catch {
        /* reported by the static guard */
      }
      const R = PANTA_ACCOUNT_ROLES;
      const expect: [number, string, string, (x: { pubkey: string; isSigner: boolean; isWritable: boolean } | undefined) => boolean][] = [
        [R.user, "user (signer, writable)", o.wallet, (x) => !!x && x.pubkey === o.wallet && x.isSigner && x.isWritable],
        [R.market, "market", o.marketId, (x) => x?.pubkey === o.marketId],
        [R.userUsdc, "user USDC ATA (writable)", associatedTokenAddress(o.wallet, USDC_MINT), (x) => !!x && x.pubkey === associatedTokenAddress(o.wallet, USDC_MINT) && x.isWritable],
        [R.mint, "USDC mint", USDC_MINT, (x) => x?.pubkey === USDC_MINT],
        [R.tokenProgram, "SPL Token program", TOKEN_PROGRAM_ID, (x) => x?.pubkey === TOKEN_PROGRAM_ID],
      ];
      report.roles = main.accounts.map((acc, slot) => {
        const e = expect.find(([s]) => s === slot);
        const flags = `${acc.isSigner ? "s" : "-"}${acc.isWritable ? "w" : "-"}`;
        return e
          ? { slot, role: e[1], expected: e[2], actual: `${acc.pubkey} ${flags}`, ok: e[3](acc) }
          : { slot, role: "(not checked)", expected: "-", actual: `${acc.pubkey} ${flags}`, ok: true };
      });
      for (const [slot, role, expected] of expect)
        if (slot >= main.accounts.length) report.roles.push({ slot, role, expected, actual: "(missing)", ok: false });
    }

    // 4. Static guard (the same checkInstructions the app runs).
    const maxOut = stake;
    const ctx = {
      kind: "copy" as const,
      feePayer: o.wallet,
      marketId: o.marketId,
      pantaProgramIds: o.pantaProgramIds,
      maxUsdcOutBase: maxOut,
      copyOutflow: { model: w.model, depositBase: w.depositBase, feeBase: w.feeBase },
      copyTerms: { side: o.side, maxSlippageBps: o.slippageBps, minSharesBase },
    };
    guarded("static guard", () => checkInstructions(b.instructions, ctx));
    if (outflowBase(w.model, w.depositBase, w.feeBase) > maxOut)
      throw new CheckFailed("static guard", "OVER_STAKE", "outflow above the amount");
    pass("static guard", `${PANTA_IX_NAMES.copy}: args, account roles, programs and transfers OK`);

    // 5. Assemble and simulate (sigVerify false, exact bytes), then the simulation guard.
    let tx!: VersionedTransaction;
    guarded("assemble", () => {
      tx = assembleTransaction(b.instructions, b.recentBlockhash, o.wallet);
    });
    let sim: SimulationResult | null = null;
    const spy: ChainReader = {
      ...deps.chain,
      getTokenAccounts: (w2) => deps.chain.getTokenAccounts(w2),
      getLamports: (w2) => deps.chain.getLamports(w2),
      simulate: async (t, addresses) => (sim = await deps.chain.simulate(t, addresses)),
    };
    let checked;
    try {
      checked = await simulateAndCheck(spy, tx, o.wallet, maxOut, 0n, o.pantaProgramIds);
    } catch (err) {
      const s = sim as SimulationResult | null;
      if (s) {
        report.innerPrograms = s.innerPrograms;
        report.simulationLogs = s.logs.slice(-20);
      }
      if (err instanceof TxRejected) throw new CheckFailed("simulation guard", err.code, err.message);
      throw err;
    }
    const s = sim as SimulationResult | null;
    report.innerPrograms = s?.innerPrograms ?? null;
    report.simulationLogs = s?.logs.slice(-20) ?? [];
    report.usdcDelta = (checked.usdcDecrease > 0n ? "-" : "+") + usdcExact(checked.usdcDecrease < 0n ? -checked.usdcDecrease : checked.usdcDecrease);
    report.solSpentLamports = checked.lamportsSpent.toString();
    pass("simulation guard", `USDC ${report.usdcDelta}, SOL spent ${checked.lamportsSpent} lamports, ${checked.accountsChecked} accounts checked`);
    report.ok = true;
  } catch (err) {
    if (err instanceof CheckFailed) {
      report.failed = `${err.check}: ${err.code}`;
      report.checks.push({ name: err.check, ok: false, detail: `${err.code}: ${err.message}` });
    } else {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      report.failed = `error: ${msg}`;
      report.checks.push({ name: "error", ok: false, detail: msg });
    }
  }
  return report;
}

function guarded(check: string, f: () => void) {
  try {
    f();
  } catch (err) {
    if (err instanceof TxRejected) throw new CheckFailed(check, err.code, err.message);
    throw err;
  }
}
