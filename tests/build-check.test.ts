/**
 * Build-and-simulate-only check (lib/build-check.ts, scripts/panta-build-check.mjs).
 * Mock Panta and the mock chain; tampered builds must fail with the failing check named.
 * The script must never sign or send, and never print the Panta key or the RPC URL's key.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { ensureMockData } from "@/lib/data";
import { runBuildCheck, parseCheckAmount, type BuildCheckOptions } from "@/lib/build-check";
import { MOCK_PROGRAM_ID, getSharedMockChain } from "@/lib/mock/chain-mock";
import * as panta from "@/lib/panta";
import marketsJson from "@/fixtures/markets.json";

const root = join(__dirname, "..");
const script = join(root, "scripts", "panta-build-check.mjs");
const market = (marketsJson as unknown as { marketId: string; phase: string }[]).find((m) => m.phase === "primary")!.marketId;

beforeAll(async () => {
  await ensureMockData();
});

type Ix = Awaited<ReturnType<typeof panta.buildPrimaryOrder>>["instructions"][number];
const opts = (over: Partial<BuildCheckOptions> = {}): BuildCheckOptions => ({
  marketId: market,
  side: "yes",
  amountUsdc: "5.00",
  wallet: Keypair.generate().publicKey.toBase58(),
  slippageBps: 200,
  pinned: "inclusive",
  feeCapBps: 500,
  pantaProgramIds: new Set([MOCK_PROGRAM_ID]),
  ...over,
});
/** A chain reader with no send path at all: the check can only read and simulate. */
const readOnlyChain = () => {
  const c = getSharedMockChain();
  return { getTokenAccounts: c.getTokenAccounts, getLamports: c.getLamports, simulate: c.simulate };
};
const tampered = (mutate: (main: Ix) => void) => ({
  quote: panta.quotePrimaryOrder,
  build: async (req: Parameters<typeof panta.buildPrimaryOrder>[0]) => {
    const b = await panta.buildPrimaryOrder(req);
    const ixs = structuredClone(b.instructions);
    mutate(ixs.find((i) => i.programId === MOCK_PROGRAM_ID)!);
    return { ...b, instructions: ixs };
  },
  chain: readOnlyChain(),
});

describe("runBuildCheck", () => {
  it("an honest mock build passes every check and reports model, args, roles, CPIs and USDC delta", async () => {
    const r = await runBuildCheck(opts(), { quote: panta.quotePrimaryOrder, build: panta.buildPrimaryOrder, chain: readOnlyChain() });
    expect(r.failed).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.feeModel).toBe("inclusive");
    expect(r.order).toMatchObject({ amount: "5.00", side: "yes", slippageBps: 200 });
    expect(r.roles?.slice(0, 3).every((x) => x.ok)).toBe(true);
    expect(r.innerPrograms).toBeTruthy();
    expect(r.usdcDelta).toBe("-5.00");
    expect(r.checks.map((c) => c.name)).toEqual(["quote", "build", "static guard", "simulation guard"]);
  });

  it("refuses amounts above 5, malformed amounts and zero", () => {
    for (const v of ["5.01", "6", "1e1", "0x5", "-1", "1.001", "0", "0.00", ""]) expect(() => parseCheckAmount(v)).toThrow();
    expect(parseCheckAmount("5")).toBe(5_000_000n);
  });

  it("a market in the wrong slot fails the static guard, and the role table shows which slot", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const r = await runBuildCheck(opts(), tampered((m) => (m.accounts[1] = { ...m.accounts[1], pubkey: other })));
    expect(r.ok).toBe(false);
    expect(r.failed).toBe("static guard: MARKET_MISMATCH");
    expect(r.roles?.find((x) => x.slot === 1)?.ok).toBe(false);
  });

  it("a replaced USDC source and a deposit above the quote fail the static guard", async () => {
    const thief = Keypair.generate().publicKey.toBase58();
    const r1 = await runBuildCheck(opts(), tampered((m) => (m.accounts[2] = { ...m.accounts[2], pubkey: thief })));
    expect(r1.failed).toBe("static guard: USDC_SOURCE");
    const r2 = await runBuildCheck(
      opts(),
      tampered((m) => {
        const d = Buffer.from(m.data, "base64");
        d.writeBigUInt64LE(d.readBigUInt64LE(8) + 1n, 8);
        m.data = d.toString("base64");
      }),
    );
    expect(r2.failed).toBe("static guard: DEPOSIT_MISMATCH");
  });

  it("an unexpected CPI in the simulation fails the simulation guard and is reported", async () => {
    const c = readOnlyChain();
    const evil = Keypair.generate().publicKey.toBase58();
    const r = await runBuildCheck(opts(), {
      quote: panta.quotePrimaryOrder,
      build: panta.buildPrimaryOrder,
      chain: { ...c, simulate: async (tx, a) => ({ ...(await c.simulate(tx, a)), innerPrograms: [evil] }) },
    });
    expect(r.failed).toBe("simulation guard: UNEXPECTED_CPI");
    expect(r.innerPrograms).toEqual([evil]);
  });

  it("a quote that contradicts the pinned fee model fails at the quote, before any build", async () => {
    let builds = 0;
    const r = await runBuildCheck(opts({ pinned: "on_top" }), {
      quote: panta.quotePrimaryOrder,
      build: async (req) => {
        builds++;
        return panta.buildPrimaryOrder(req);
      },
      chain: readOnlyChain(),
    });
    expect(r.failed).toBe("quote: FEE_MODEL_MISMATCH");
    expect(builds).toBe(0);
  });
});

function run(env: Record<string, string | undefined>, args: string[] = []) {
  const base = { ...process.env };
  for (const k of [
    "MOCK_PANTA",
    "MOCK_PANTA_FEE_MODEL",
    "PANTA_FEE_MODEL",
    "PANTA_FEE_CAP_BPS",
    "PANTA_API_KEY",
    "PANTA_BASE_URL",
    "PANTA_PROGRAM_IDS",
    "SOLANA_RPC_URL",
  ])
    delete base[k];
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: root, env: { ...base, ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) ?? 1 : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

describe("panta-build-check script", () => {
  it("mock: passes and prints the report", async () => {
    const r = await run({ MOCK_PANTA: "true" });
    expect(r.code).toBe(0);
    for (const s of ["fee model: inclusive", "order args:", "account roles", "inner programs:", "simulated USDC delta: -5.00", "result: PASS"])
      expect(r.out).toContain(s);
  }, 60_000);

  it("mock on top: passes with the re-quote", async () => {
    const r = await run({ MOCK_PANTA: "true", MOCK_PANTA_FEE_MODEL: "on_top", PANTA_FEE_MODEL: "on_top" }, ["--amount", "4.50"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fee model: on_top (2 quote call(s))");
  }, 60_000);

  it("refuses --amount above 5 and a non-pubkey wallet (usage, exit 1)", async () => {
    expect((await run({ MOCK_PANTA: "true" }, ["--amount", "5.01"])).code).toBe(1);
    expect((await run({ MOCK_PANTA: "true" }, ["--amount", "50"])).code).toBe(1);
    const w = await run({ MOCK_PANTA: "true" }, ["--wallet", "not-a-key"]);
    expect(w.code).toBe(1);
    expect(w.out).not.toContain("not-a-key");
  }, 60_000);

  it("a failing check exits 3 and names it", async () => {
    const r = await run({ MOCK_PANTA: "true", MOCK_PANTA_FEE_MODEL: "on_top", PANTA_FEE_MODEL: "inclusive" });
    expect(r.code).toBe(3);
    expect(r.out).toContain("result: FAIL at quote: FEE_MODEL_MISMATCH");
  }, 60_000);

  it("real mode never prints the Panta key or any part of the RPC URL's key", async () => {
    // Make both secrets equal values the script prints, so a missed redaction would show.
    const wallet = Keypair.generate().publicKey.toBase58();
    const pantaKey = Keypair.generate().publicKey.toBase58();
    const rpcPathKey = "pathsecret0123456789";
    const env = {
      PANTA_API_KEY: pantaKey,
      PANTA_BASE_URL: "https://evil.example/api/v1", // refused by lib/panta.ts before any request
      PANTA_FEE_MODEL: "inclusive",
      PANTA_PROGRAM_IDS: Keypair.generate().publicKey.toBase58(),
      SOLANA_RPC_URL: `https://user:pw0rd123@rpc.example/${rpcPathKey}/?api-key=${wallet}`,
    };
    const r = await run(env, ["--market", pantaKey, "--side", "yes", "--amount", "1.00", "--wallet", wallet]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("PANTA_BASE_URL must be");
    for (const s of [pantaKey, wallet, rpcPathKey, "pw0rd123", "rpc.example/"]) expect(r.out).not.toContain(s);
    expect(r.out).toContain("[redacted]");
  }, 60_000);

  it("real mode requires the wallet, program ids, RPC URL and a fee pin", async () => {
    const m = Keypair.generate().publicKey.toBase58();
    const base = { PANTA_FEE_MODEL: "inclusive", PANTA_PROGRAM_IDS: m, SOLANA_RPC_URL: "https://rpc.example/" };
    expect((await run(base, ["--market", m])).code).toBe(1); // no wallet
    const w = Keypair.generate().publicKey.toBase58();
    expect((await run({ ...base, PANTA_FEE_MODEL: "" }, ["--market", m, "--wallet", w])).code).toBe(1);
    expect((await run({ ...base, PANTA_PROGRAM_IDS: "" }, ["--market", m, "--wallet", w])).code).toBe(1);
    expect((await run({ ...base, SOLANA_RPC_URL: "" }, ["--market", m, "--wallet", w])).code).toBe(1);
  }, 120_000);

  it("refuses a Panta key too short to redact", async () => {
    const r = await run({ MOCK_PANTA: "true", PANTA_API_KEY: "Zq9x7" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("Zq9x7");
  }, 60_000);

  it("has no signing or sending path: no private key, no send, no wallet signature", () => {
    for (const f of [script, join(root, "lib", "build-check.ts")]) {
      const src = readFileSync(f, "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const banned of ["Keypair", "secretKey", "fromSecretKey", "nacl", ".sign(", "sendRawTransaction", "sendTransaction", ".send(", "simulateSignAndSend", "writeFile", "reportTrade"])
        expect(src, `${f} contains ${banned}`).not.toContain(banned);
    }
  });
});
