#!/usr/bin/env node
/**
 * BUILD-AND-SIMULATE-ONLY check of one copy against live Panta and the RPC,
 * before any real wallet signs anything.
 *
 *   node --env-file=.env.local scripts/panta-build-check.mjs --market <marketId> --side yes|no \
 *        --amount 5.00 --wallet <pubkey> [--slippage-bps 200]
 *   MOCK_PANTA=true node scripts/panta-build-check.mjs        # mock fixtures and mock chain
 *   node --env-file=.env.local scripts/panta-build-check.mjs --claim --market <marketId> --wallet <pubkey>
 *
 * --claim (G-05): one POST /claimbuild/, assemble, simulate ONLY, run the app's claim guard (no USDC
 * out, payout >= winningShares into the user's own USDC ATA), then print every instruction's program,
 * accounts (signer/writable) and data (hex + base64), the role table, the inner programs, the USDC
 * delta, and the post-simulation owner / size / data of each account the Panta instruction lists, so
 * Panta's real claim and position layout can be learned. On-chain position verification is reported
 * as unavailable (the app refuses real claims until a reader exists). No --amount or --side.
 *
 * What it does (lib/build-check.ts): the app's quote logic (one POST /primaryorderquote/,
 * plus one re-quote when the fee is on top), one POST /primaryorderbuild/, assembles the
 * exact v0 transaction the app would hand to the wallet, runs simulateTransaction with
 * sigVerify false, then the full guard (static + simulation). It prints the detected fee
 * model, the decoded order args, each Panta account slot against PANTA_ACCOUNT_ROLES, the
 * inner (CPI) programs and the simulated USDC delta.
 *
 * Safety:
 * - It NEVER signs or broadcasts. It has no private key (only --wallet, a public key) and
 *   never calls a send path. A Panta build is not an order until it's signed and sent.
 * - --amount is at most 5 USDC (plain decimal, <= 2 dp) and at most MAX_STAKE_USDC (required in
 *   real mode, like the app).
 * - PANTA_API_KEY is read only from the env by lib/panta.ts. SOLANA_RPC_URL (which usually
 *   embeds an API key) is read only by lib/solana.ts. Every output line passes through
 *   redact(), which removes the Panta key, the full RPC URL, its credentials, query values
 *   and path segments, and anything that looks like a key. A Panta key shorter than 8
 *   characters can't be redacted safely, so the script refuses to run.
 * - One logical Panta call may be up to 5 HTTP requests (429 retries in lib/panta.ts).
 *
 * Exit 0 when every check passes; 3 when a check fails (the failing check is printed);
 * 1 on usage or other errors.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { makeRedact } from "./redact.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pantaKey = (process.env.PANTA_API_KEY ?? "").trim();
const rpcUrl = (process.env.SOLANA_RPC_URL ?? "").trim();
const MIN_KEY_LEN = 8;
if (pantaKey.length > 0 && pantaKey.length < MIN_KEY_LEN) {
  process.stderr.write("error: PANTA_API_KEY is too short to be a real key; refusing to run\n");
  process.exit(1);
}

const redact = makeRedact(pantaKey, rpcUrl); // K-03: shared with panta-fee-model.mjs
const out = (line) => process.stdout.write(redact(line) + "\n");
const fail = (msg, code = 1) => {
  process.stderr.write(redact(`error: ${msg}`) + "\n");
  process.exit(code);
};

function args() {
  const a = process.argv.slice(2);
  const get = (k) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  if (a.includes("--help") || a.includes("-h")) {
    out("usage: node scripts/panta-build-check.mjs --market <marketId> --side yes|no --amount <<=5> --wallet <pubkey> [--slippage-bps 200]");
    out("       node scripts/panta-build-check.mjs --claim --market <marketId> --wallet <pubkey>   (simulate a claim only)");
    process.exit(0);
  }
  const claim = a.includes("--claim");
  if (claim && (a.includes("--amount") || a.includes("--side") || a.includes("--slippage-bps"))) {
    process.stderr.write("error: --claim takes only --market and --wallet\n");
    process.exit(1);
  }
  return {
    claim,
    market: get("market"),
    side: (get("side") ?? "yes").toLowerCase(),
    amount: get("amount") ?? "5.00",
    wallet: get("wallet"),
    slippage: get("slippage-bps") ?? "200",
  };
}

async function load(rel) {
  const { runnerImport } = await import("vite");
  const { module } = await runnerImport(join(root, rel), {
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: { "@": root, "server-only": join(root, "tests/helpers/server-only-stub.ts") },
    },
  });
  return module;
}

try {
  const a = args();
  const [check, panta, env, feeConfig, constants, stakeCap] = await Promise.all([
    load("lib/build-check.ts"),
    load("lib/panta.ts"),
    load("lib/env.ts"),
    load("lib/fee-config.ts"),
    load("lib/solana-constants.ts"),
    load("lib/stake-cap.ts"),
  ]);
  const { PublicKey } = await import("@solana/web3.js");
  const isPubkey = (v) => {
    try {
      return typeof v === "string" && new PublicKey(v).toBase58() === v;
    } catch {
      return false;
    }
  };
  const mock = env.isMockMode();

  let market = a.market;
  if (!market && mock && !a.claim) {
    const { default: markets } = await import(join(root, "fixtures/markets.json"), { with: { type: "json" } });
    market = markets.find((m) => m.phase === "primary")?.marketId;
  }
  let wallet = a.wallet;
  if (!wallet && mock) {
    const bs58 = (await import("bs58")).default;
    wallet = bs58.encode(randomBytes(32));
  }
  if (!wallet || !isPubkey(wallet)) fail("--wallet <pubkey> is required (a public key; never a private key)");
  if (!market && mock && a.claim) {
    // Mock: the demo wallet's winning market.
    market = (await panta.getPositions(wallet)).positions.find((p) => p.claimable && !p.claimed)?.marketId;
  }
  if (!market || !isPubkey(market)) fail("--market <marketId> (a base58 public key) is required");
  if (a.side !== "yes" && a.side !== "no") fail("--side must be yes or no");
  try {
    check.parseCheckAmount(a.amount);
  } catch (e) {
    fail(e.message);
  }
  if (!/^\d{1,3}$/.test(a.slippage)) fail("--slippage-bps must be an integer");

  // A claim moves no stake, so it needs neither the fee pin nor the launch cap (as in the app, E-09).
  let fee;
  let capBase;
  if (!a.claim) {
    try {
      fee = feeConfig.feeConfigFromEnv(process.env, mock);
    } catch (e) {
      fail(e.message); // names the variable, never its value
    }
    try {
      capBase = stakeCap.stakeCapFromEnv(process.env, mock);
    } catch (e) {
      fail(e.message); // names the variable, never its value
    }
    if (check.parseCheckAmount(a.amount) > capBase) fail(`--amount must be at most MAX_STAKE_USDC (${stakeCap.formatCap(capBase)})`);
  }

  let programIds;
  let chain;
  if (mock) {
    const m = await load("lib/mock/chain-mock.ts");
    programIds = new Set([m.MOCK_PROGRAM_ID]);
    chain = m.getSharedMockChain();
  } else {
    const ids = (process.env.PANTA_PROGRAM_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0 || !ids.every(isPubkey)) fail("PANTA_PROGRAM_IDS must list Panta program ids (base58)");
    programIds = new Set(ids);
    if (!rpcUrl) fail("SOLANA_RPC_URL is required in real mode");
    const solana = await load("lib/solana.ts");
    // Read-only use: getTokenAccounts, getLamports and simulate. Nothing here calls send().
    const { getTokenAccounts, getLamports, simulate } = solana.rpcChain;
    chain = { getTokenAccounts, getLamports, simulate };
  }

  out(`mode: ${mock ? "MOCK (fixtures, mock chain)" : "REAL (live Panta + RPC; build and simulate only, nothing is signed or sent)"}`);
  if (a.claim) {
    out(`input: CLAIM market=${market} wallet=${wallet}`);
    out(`config: programs=${[...programIds].join(",")}`);
    out(`user USDC ATA (payout): ${constants.associatedTokenAddress(wallet, constants.USDC_MINT)}`);
    const r = await check.runClaimCheck({ marketId: market, wallet, pantaProgramIds: programIds }, { buildClaim: panta.buildClaim, chain });
    if (r.claim) {
      out(`claim: outcome=${r.claim.outcome} winningShares=${r.claim.winningShares} lastValidBlockHeight=${r.claim.lastValidBlockHeight ?? "(none)"}`);
      for (const [k, v] of Object.entries(r.claim.derived)) out(`  derived.${k}: ${v}`);
    }
    for (const ix of r.instructions ?? []) {
      out(`instruction ${ix.index}: program=${ix.programId}${ix.panta ? " (PANTA)" : ""} dataLength=${ix.dataLength}`);
      out(`  data hex: ${ix.dataHex}`);
      out(`  data base64: ${ix.dataBase64}`);
      ix.accounts.forEach((x, i) => out(`  [${i}] ${x.signer ? "s" : "-"}${x.writable ? "w" : "-"} ${x.pubkey}`));
    }
    printCommon(r);
    out("Panta instruction accounts after simulation:");
    for (const x of r.pantaAccountsAfter ?? [])
      out(
        x.exists
          ? `  ${x.pubkey}: owner=${x.owner} executable=${x.executable} lamports=${x.lamports} dataLength=${x.dataLength} data(base64, first ${check.CLAIM_DATA_PRINT_MAX} bytes)=${x.dataBase64}`
          : `  ${x.pubkey}: (no account)`,
      );
    out("on-chain position verification: UNAVAILABLE (no position reader yet; the app refuses real claims with CLAIM_UNVERIFIED)");
    finish(r);
  }
  out(`input: market=${market} side=${a.side} amount=${a.amount} wallet=${wallet} slippageBps=${a.slippage}`);
  out(`config: PANTA_FEE_MODEL=${fee.model} PANTA_FEE_CAP_BPS=${fee.feeCapBps} MAX_STAKE_USDC=${stakeCap.formatCap(capBase)} programs=${[...programIds].join(",")}`);
  out(`user USDC ATA: ${constants.associatedTokenAddress(wallet, constants.USDC_MINT)}`);

  const r = await check.runBuildCheck(
    {
      marketId: market,
      side: a.side,
      amountUsdc: a.amount,
      wallet,
      slippageBps: Number(a.slippage),
      pinned: fee.model,
      explicitPin: fee.pinned, // Q-01
      feeCapBps: fee.feeCapBps,
      pantaProgramIds: programIds,
      maxStakeCapBase: capBase,
    },
    { quote: panta.quotePrimaryOrder, build: panta.buildPrimaryOrder, chain },
  );

  if (r.feeModel) out(`fee model: ${r.feeModel} (${r.quotes} quote call(s))`);
  if (r.order)
    out(`order args: amount=${r.order.amount} side=${r.order.side} shares=${r.order.shares} maxSlippageBps=${r.order.slippageBps} onChainMinShares=${r.order.minShares}`);
  printCommon(r);
  finish(r);
} catch (err) {
  // P1-5: also Panta's error code (and field), only in their strict printable shapes; still redacted.
  let e;
  try {
    e = (await load("lib/panta-error.ts")).describeError(err);
  } catch {
    e = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  fail(e);
}

function printCommon(r) {
  if (r.roles) {
    out("account roles (PANTA_ACCOUNT_ROLES, assumed order):");
    for (const x of r.roles) out(`  [${x.slot}] ${x.ok ? "ok  " : "FAIL"} ${x.role}: ${x.actual}${x.expected !== "-" && !x.ok ? ` (expected ${x.expected})` : ""}`);
  }
  if (r.innerPrograms !== undefined) out(`inner programs: ${r.innerPrograms === null ? "(unknown: fails closed)" : r.innerPrograms.length ? [...new Set(r.innerPrograms)].join(", ") : "(none)"}`);
  if (r.usdcDelta) out(`simulated USDC delta: ${r.usdcDelta}   SOL spent: ${r.solSpentLamports} lamports`);
  if (r.simulationLogs?.length) {
    out("simulation logs (last 20):");
    for (const l of r.simulationLogs) out(`  ${l}`);
  }
}

function finish(r) {
  out("checks:");
  for (const c of r.checks) out(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  if (r.ok) {
    out("result: PASS (nothing was signed or sent)");
    process.exit(0);
  }
  out(`result: FAIL at ${r.failed} (nothing was signed or sent)`);
  process.exit(3);
}
