/**
 * P1-5: the check scripts print Panta's error `code` (and `field`) so a real 400 is diagnosable,
 * but only in strict printable shapes, never the raw body, and always redacted.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PantaError, describeError } from "@/lib/panta-error";

const root = join(__dirname, "..");
const stub = join(root, "tests", "helpers", "stub-panta-fetch.mjs");

function run(script: string, args: string[], env: Record<string, string>) {
  const base = { ...process.env };
  for (const k of ["MOCK_PANTA", "MOCK_PANTA_FEE_MODEL", "PANTA_FEE_MODEL", "PANTA_FEE_CAP_BPS", "PANTA_API_KEY", "PANTA_BASE_URL", "PANTA_PROGRAM_IDS", "SOLANA_RPC_URL", "MAX_STAKE_USDC"])
    delete base[k];
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--import", stub, join(root, "scripts", script), ...args],
      { cwd: root, env: { ...base, ...env }, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: unknown }).code as number) : 0;
        resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
      },
    );
  });
}

describe("describeError", () => {
  it("prints a printable code and field, and nothing raw", () => {
    expect(describeError(new PantaError(400, "MARKET_NOT_IN_PRIMARY", "Panta request failed (400)", "marketId"))).toBe(
      "PantaError: Panta request failed (400) code=MARKET_NOT_IN_PRIMARY field=marketId",
    );
    expect(describeError(new PantaError(400, "HTTP_400", "Panta request failed (400)"))).toBe(
      "PantaError: Panta request failed (400) code=HTTP_400",
    );
    for (const bad of [`pk_live_${"x".repeat(12)}`, "market_not_found", "BAD\nCODE", "", "A".repeat(65), "HTTP_4000"])
      expect(describeError(new PantaError(400, bad, "m"))).toBe("PantaError: m code=(unprintable)");
    expect(describeError(new PantaError(400, "X", "m", "amount\nUsdc"))).toBe("PantaError: m code=X");
    expect(describeError(new PantaError(400, "X", "m", "pk_live_x/y"))).toBe("PantaError: m code=X");
    // Another module graph's PantaError (or any error) with a string code is treated the same.
    const foreign = Object.assign(new Error("boom"), { name: "PantaError", code: "QUOTE_STALE", field: "side" });
    expect(describeError(foreign)).toBe("PantaError: boom code=QUOTE_STALE field=side");
    expect(describeError(new Error("plain"))).toBe("Error: plain");
    expect(describeError("str")).toBe("str");
  });
});

describe("scripts print Panta's 400 code (real mode, stubbed fetch)", () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const market = Keypair.generate().publicKey.toBase58();
  const pantaKey = `pk_live_${Keypair.generate().publicKey.toBase58()}`;
  const rpcPathKey = "pathsecret0123456789";
  const rpc = `https://user:pw0rd123@rpc.example/${rpcPathKey}/?api-key=${Keypair.generate().publicKey.toBase58()}`;
  const env = (body: string) => ({
    PANTA_API_KEY: pantaKey,
    PANTA_FEE_MODEL: "inclusive",
    MAX_STAKE_USDC: "5",
    PANTA_PROGRAM_IDS: Keypair.generate().publicKey.toBase58(),
    SOLANA_RPC_URL: rpc,
    STUB_PANTA_STATUS: "400",
    STUB_PANTA_BODY: body,
  });
  const noSecrets = (out: string) => {
    for (const s of [pantaKey, pantaKey.slice(8), rpcPathKey, "pw0rd123", "rpc.example/", rpc]) expect(out).not.toContain(s);
  };
  const cases = [
    {
      name: "a Panta envelope (code + field, no message)",
      body: JSON.stringify({ code: "MARKET_NOT_IN_PRIMARY", field: "marketId" }),
      expectLine: "PantaError: Panta request failed (400) code=MARKET_NOT_IN_PRIMARY field=marketId",
    },
    {
      name: "a malicious code (key-like, lowercase, newline) and field",
      body: JSON.stringify({ code: `${pantaKey}\nFAKE_LINE`, field: "x\ny" }),
      expectLine: "PantaError: Panta request failed (400) code=(unprintable)",
    },
    {
      name: "a non-JSON body (envelope didn't parse: HTTP_400)",
      body: "<html>gateway says no " + pantaKey + "</html>",
      expectLine: "PantaError: Panta request failed (400) code=HTTP_400",
    },
  ];

  for (const c of cases) {
    it(`panta-fee-model: ${c.name}`, async () => {
      const r = await run("panta-fee-model.mjs", ["--market", market, "--side", "yes", "--wallet", wallet], env(c.body));
      expect(r.code).toBe(1); // unchanged
      const errLine = r.out.split("\n").find((l) => l.startsWith("error: "));
      expect(errLine).toBe(`error: ${c.expectLine}`);
      expect(r.out).not.toContain("FAKE_LINE");
      expect(r.out).not.toContain("gateway says no");
      noSecrets(r.out);
    }, 60_000);

    it(`panta-build-check: ${c.name}`, async () => {
      const r = await run("panta-build-check.mjs", ["--market", market, "--side", "yes", "--amount", "1.00", "--wallet", wallet], env(c.body));
      expect(r.code).toBe(3); // unchanged: a failed check after config
      expect(r.out).toContain(`  FAIL error: ${c.expectLine}`);
      expect(r.out).toContain(`result: FAIL at error: ${c.expectLine}`);
      expect(r.out).not.toContain("FAKE_LINE");
      expect(r.out).not.toContain("gateway says no");
      noSecrets(r.out);
    }, 60_000);
  }
});
