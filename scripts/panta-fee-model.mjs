#!/usr/bin/env node
/**
 * ONE quote-only Panta call that prints which fee model the quote's own numbers
 * match, so a human can set PANTA_FEE_MODEL for the deployment.
 *
 *   node --env-file=.env.local scripts/panta-fee-model.mjs --market <marketId> --side yes|no [--amount 5.00] [--wallet <base58>]
 *   MOCK_PANTA=true node scripts/panta-fee-model.mjs            # mock fixtures, any primary market
 *   MOCK_PANTA=true MOCK_PANTA_FEE_MODEL=on_top node scripts/panta-fee-model.mjs
 *
 * - Calls POST /primaryorderquote/ once through lib/panta.ts (host allowlist,
 *   X-Api-Key header, schema validation). It NEVER builds, signs or sends anything.
 *   "Once" is one logical quote: lib/panta.ts retries a 429 up to 4 times, so it can
 *   be up to 5 HTTP requests (E-12).
 * - The key is read only from the server env (PANTA_API_KEY) by lib/panta.ts. It is
 *   never printed, logged or written: every line of output passes through redact()
 *   (scripts/redact.mjs), which also strips SOLANA_RPC_URL and its pieces if it is set.
 *   A key shorter than 8 characters can't be redacted safely, so the script refuses to run.
 * - Exit 0 when the quote clearly matches inclusive or on_top, 2 when ambiguous or
 *   unknown (do not pin anything then), 1 on errors.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { makeRedact } from "./redact.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secret = (process.env.PANTA_API_KEY ?? "").trim();
const rpcUrl = (process.env.SOLANA_RPC_URL ?? "").trim();

const MIN_KEY_LEN = 8;
if (secret.length > 0 && secret.length < MIN_KEY_LEN) {
  // E-12: too short to redact without mangling every other line; never print it.
  process.stderr.write("error: PANTA_API_KEY is too short to be a real key; refusing to run\n");
  process.exit(1);
}

/**
 * K-03: the same redaction as panta-build-check.mjs: the key, anything that looks like a Panta
 * key, and the RPC URL with its credentials, query values and path segments (in case it's in
 * the env, e.g. from .env.local), plus api-key/token/secret/auth query values.
 */
const redact = makeRedact(secret, rpcUrl);
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
    out("usage: node scripts/panta-fee-model.mjs --market <marketId> --side yes|no [--amount 5.00] [--wallet <base58>]");
    process.exit(0);
  }
  return { market: get("market"), side: (get("side") ?? "yes").toLowerCase(), amount: get("amount") ?? "5.00", wallet: get("wallet") };
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
  const [panta, math, env] = await Promise.all([load("lib/panta.ts"), load("lib/copy-math.ts"), load("lib/env.ts")]);
  const mock = env.isMockMode();
  let market = a.market;
  if (!market && mock) {
    const { default: markets } = await import(join(root, "fixtures/markets.json"), { with: { type: "json" } });
    market = markets.find((m) => m.phase === "primary")?.marketId;
  }
  if (!market) fail("--market <marketId> is required in real mode");
  if (a.side !== "yes" && a.side !== "no") fail("--side must be yes or no");
  const bs58 = (await import("bs58")).default;
  const wallet = a.wallet ?? bs58.encode(randomBytes(32)); // quote-only: any buyer address works for the estimate

  out(`mode: ${mock ? "MOCK (fixtures)" : "REAL (live Panta, quote only)"}`);
  out(`quote: market=${market} side=${a.side} amountUsdc=${a.amount}`);
  const q = await panta.quotePrimaryOrder({ wallet, marketId: market, side: a.side, amountUsdc: a.amount });
  out(`panta: amountUsdc=${q.amountUsdc} feeUsdc=${q.feeUsdc} avgPrice=${q.avgPrice} shares=${q.shares}`);
  const c = math.classifyFeeModel({ amountUsdc: String(q.amountUsdc), feeUsdc: q.feeUsdc, avgPrice: q.avgPrice, shares: q.shares });
  out(`predicted shares: inclusive=${c.inclusiveShares ?? "-"} on_top=${c.onTopShares ?? "-"}`);
  out(`tolerance: 0.01 share + ${math.FEE_MODEL_TOLERANCE_BPS} bps of the prediction`);
  out(`detected: ${c.model}`);
  const pinned = (process.env.PANTA_FEE_MODEL ?? "").trim() || "(unset)";
  if (c.model === "inclusive" || c.model === "on_top") {
    out(`suggest: PANTA_FEE_MODEL=${c.model}   (currently ${pinned}${pinned === c.model ? ", matches" : pinned === "(unset)" ? "" : ", MISMATCH"})`);
    process.exit(0);
  }
  out(c.model === "no_fee" ? "suggest: fee was 0, so this quote can't tell; try a larger --amount" : "suggest: do NOT pin from this quote; try another market or a larger --amount");
  process.exit(2);
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
