#!/usr/bin/env node
/**
 * BUILD-AND-SIMULATE-ONLY check of one copy against live Panta and the RPC,
 * before any real wallet signs anything.
 *
 *   node --env-file=.env.local scripts/panta-build-check.mjs --market <marketId> --side yes|no \
 *        --amount 5.00 --wallet <pubkey> [--slippage-bps 200]
 *   MOCK_PANTA=true node scripts/panta-build-check.mjs        # mock fixtures and mock chain
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pantaKey = (process.env.PANTA_API_KEY ?? "").trim();
const rpcUrl = (process.env.SOLANA_RPC_URL ?? "").trim();
const MIN_KEY_LEN = 8;
if (pantaKey.length > 0 && pantaKey.length < MIN_KEY_LEN) {
  process.stderr.write("error: PANTA_API_KEY is too short to be a real key; refusing to run\n");
  process.exit(1);
}

/** Secrets to strip from output: the Panta key and every sensitive piece of the RPC URL. */
function secretsFromRpcUrl(raw) {
  const out = [];
  if (!raw) return out;
  out.push(raw);
  try {
    const u = new URL(raw);
    if (u.username) out.push(decodeURIComponent(u.username), u.username);
    if (u.password) out.push(decodeURIComponent(u.password), u.password);
    for (const [, v] of u.searchParams) if (v.length >= 4) out.push(v, encodeURIComponent(v));
    for (const seg of u.pathname.split("/")) if (seg.length >= 8) out.push(seg);
    out.push(`${u.origin}${u.pathname}`);
  } catch {
    /* not a URL: the whole string is still redacted */
  }
  return out;
}
const secrets = [...(pantaKey ? [pantaKey] : []), ...secretsFromRpcUrl(rpcUrl)]
  .filter((s) => s.length >= 4)
  .sort((a, b) => b.length - a.length);

function redact(text) {
  let s = String(text);
  for (const k of secrets) s = s.split(k).join("[redacted]");
  return s
    .replace(/pk_(test|live)_[A-Za-z0-9_\-]+/g, "pk_$1_[redacted]")
    .replace(/(api[-_]?key|token|secret|auth)=([^&\s"']+)/gi, "$1=[redacted]");
}
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
    process.exit(0);
  }
  return {
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
  if (!market && mock) {
    const { default: markets } = await import(join(root, "fixtures/markets.json"), { with: { type: "json" } });
    market = markets.find((m) => m.phase === "primary")?.marketId;
  }
  if (!market || !isPubkey(market)) fail("--market <marketId> (a base58 public key) is required");
  if (a.side !== "yes" && a.side !== "no") fail("--side must be yes or no");
  try {
    check.parseCheckAmount(a.amount);
  } catch (e) {
    fail(e.message);
  }
  if (!/^\d{1,3}$/.test(a.slippage)) fail("--slippage-bps must be an integer");
  let wallet = a.wallet;
  if (!wallet && mock) {
    const bs58 = (await import("bs58")).default;
    wallet = bs58.encode(randomBytes(32));
  }
  if (!wallet || !isPubkey(wallet)) fail("--wallet <pubkey> is required (a public key; never a private key)");

  let fee;
  try {
    fee = feeConfig.feeConfigFromEnv(process.env, mock);
  } catch (e) {
    fail(e.message); // names the variable, never its value
  }

  let capBase;
  try {
    capBase = stakeCap.stakeCapFromEnv(process.env, mock);
  } catch (e) {
    fail(e.message); // names the variable, never its value
  }
  if (check.parseCheckAmount(a.amount) > capBase) fail(`--amount must be at most MAX_STAKE_USDC (${stakeCap.formatCap(capBase)})`);

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
      feeCapBps: fee.feeCapBps,
      pantaProgramIds: programIds,
      maxStakeCapBase: capBase,
    },
    { quote: panta.quotePrimaryOrder, build: panta.buildPrimaryOrder, chain },
  );

  if (r.feeModel) out(`fee model: ${r.feeModel} (${r.quotes} quote call(s))`);
  if (r.order)
    out(`order args: amount=${r.order.amount} side=${r.order.side} shares=${r.order.shares} maxSlippageBps=${r.order.slippageBps} onChainMinShares=${r.order.minShares}`);
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
  out("checks:");
  for (const c of r.checks) out(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  if (r.ok) {
    out("result: PASS (nothing was signed or sent)");
    process.exit(0);
  }
  out(`result: FAIL at ${r.failed} (nothing was signed or sent)`);
  process.exit(3);
} catch (err) {
  const e = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  fail(e);
}
