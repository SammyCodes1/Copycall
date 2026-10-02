/**
 * scripts/panta-fee-model.mjs: one quote-only call that prints the matching fee
 * model. Runs in mock mode here (no network). The Panta key must never appear
 * in its output, including error output.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const script = join(root, "scripts", "panta-fee-model.mjs");

function run(env: Record<string, string | undefined>, args: string[] = []) {
  const base = { ...process.env };
  for (const k of ["MOCK_PANTA", "MOCK_PANTA_FEE_MODEL", "PANTA_FEE_MODEL", "PANTA_API_KEY", "PANTA_BASE_URL"]) delete base[k];
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: root, env: { ...base, ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) ?? 1 : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

describe("panta-fee-model script", () => {
  const key = `pk_test_${randomBytes(12).toString("hex")}`;

  it("mock inclusive: prints the detected model and a suggestion; never the key", async () => {
    const r = await run({ MOCK_PANTA: "true", PANTA_API_KEY: key });
    expect(r.code).toBe(0);
    expect(r.out).toContain("detected: inclusive");
    expect(r.out).toContain("suggest: PANTA_FEE_MODEL=inclusive");
    expect(r.out).not.toContain(key);
  }, 60_000);

  it("mock on top, with a contradicting pin: reports on_top and flags the mismatch", async () => {
    const r = await run({ MOCK_PANTA: "true", MOCK_PANTA_FEE_MODEL: "on_top", PANTA_FEE_MODEL: "inclusive", PANTA_API_KEY: key });
    expect(r.code).toBe(0);
    expect(r.out).toContain("detected: on_top");
    expect(r.out).toContain("MISMATCH");
    expect(r.out).not.toContain(key);
  }, 60_000);

  it("real mode errors are redacted (the key passed as an argument and a refused host)", async () => {
    // A non-Panta host is refused by lib/panta.ts before any request is made.
    const env = { PANTA_API_KEY: key, PANTA_BASE_URL: "https://evil.example/api/v1" };
    const echoed = await run(env, ["--market", key, "--side", "yes"]);
    expect(echoed.code).toBe(1);
    expect(echoed.out).not.toContain(key);
    expect(echoed.out).toContain("[redacted]");
    const host = await run(env, ["--market", "GdwHjnBtvm8HhTae9aGJWsJoXADUQzPvfcythZNMuWTh", "--side", "no"]);
    expect(host.code).toBe(1);
    expect(host.out).toContain("PANTA_BASE_URL must be");
    expect(host.out).not.toContain(key);
  }, 60_000);

  it("E-12: a key too short to redact safely makes the script refuse to run (never printed)", async () => {
    for (const short of ["Zq", "Zq9x7"]) {
      const r = await run({ MOCK_PANTA: "true", PANTA_API_KEY: short });
      expect(r.code).toBe(1);
      expect(r.out).toContain("too short");
      expect(r.out).not.toContain(short);
    }
  }, 60_000);

  it("E-12: documents that one quote may be up to 5 HTTP requests (429 retries)", () => {
    expect(readFileSync(script, "utf8")).toContain("up to 5 HTTP requests");
  });

  it("is quote-only: it never imports build, sign or send paths", () => {
    const src = readFileSync(script, "utf8");
    for (const banned of ["buildPrimaryOrder", "buildClaim", "reportTrade", "sendTransaction", "writeFile", "appendFile"])
      expect(src).not.toContain(banned);
  });
});
