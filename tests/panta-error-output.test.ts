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

describe("describeError: the envelope's `fields` (names only)", () => {
  const fakeKey = "pk_live_" + "Q".repeat(24);
  const rpc = ["https://mainnet.helius-rpc.com/?api", "key="].join("-") + "deadbeef".repeat(4);
  const hostile = JSON.parse(
    JSON.stringify({
      amountUsdc: [`bad ${fakeKey}`],
      [fakeKey]: ["x"],
      [rpc]: [rpc],
      "line\nbreak": ["a\nINJECTED"],
      "\u001b[31mred": ["\u001b[0m"],
      side: ["must be yes or no " + rpc],
    }).replace("{", '{"__proto__":["polluted"],'),
  );
  const d = (fields: unknown) => describeError(new PantaError(400, "INVALID_MARKET_PARAMS", "Panta request failed (400)", undefined, fields));
  const base = "PantaError: Panta request failed (400) code=INVALID_MARKET_PARAMS";

  it("prints only safe names; never values, keys, URLs, newlines, ANSI or __proto__", () => {
    expect(Object.keys(hostile)).toContain("__proto__"); // JSON.parse makes it an own key
    const out = d(hostile);
    expect(out).toBe(`${base} fields=[amountUsdc,side]`);
    for (const bad of [fakeKey, "pk_live", "helius", "api-key", "deadbeef", "\n", "INJECTED", "\u001b", "[31m", "red", "__proto__", "polluted", "must be", "bad "])
      expect(out).not.toContain(bad);
  });

  it("an array of strings is a list of names (same filters)", () => {
    expect(d(["amountUsdc", fakeKey, "side", "constructor", "a b"])).toBe(`${base} fields=[amountUsdc,side]`);
    expect(d([])).toBe(`${base} fields=[]`);
  });

  it("anything else prints exactly fields=unparsed", () => {
    for (const bad of ["amountUsdc", 42, null, true, [1, 2], ["ok", 3], new Map([["a", 1]]), Object.assign(Object.create({ evil: 1 }), { x: 1 })])
      expect(d(bad)).toBe(`${base} fields=unparsed`);
    expect(d(undefined)).toBe(base); // no fields: no segment (unchanged output)
  });

  it("at most 10 names and at most 200 chars", () => {
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`f${i}`, ["x"]]));
    expect(d(many)).toBe(`${base} fields=[${Array.from({ length: 10 }, (_, i) => `f${i}`).join(",")}]`);
    const long = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${String.fromCharCode(97 + i)}${"n".repeat(40)}`, ["x"]]));
    const seg = d(long).slice(base.length);
    expect(seg.length).toBeLessThanOrEqual(200);
    expect(seg).toMatch(/^ fields=\[[a-z]n{40}(,[a-z]n{40})*\]$/);
  });

  it("P-01: a name sharing 6+ characters with the configured key (any case, any position) is dropped", () => {
    const prev = process.env.PANTA_API_KEY;
    process.env.PANTA_API_KEY = ["abcdefgh", "12345678", "QrStUvWx"].join("");
    try {
      const names = {
        abcdefgh12345678: ["x"], // the key's start
        abcdefZZ: ["x"], // first 6 only
        zz345678Qr: ["x"], // a later chunk, not the first 8
        xxStUvWxyy: ["x"], // the key's tail
        ABCDEFGH: ["x"], // different case of the start
        qrstuv: ["x"], // different case of a later chunk
        H12345: ["x"], // mixed case across the boundary
        abcdeZ: ["x"], // only 5 shared: kept
        side: ["x"],
      };
      expect(d(names)).toBe(`${base} fields=[abcdeZ,side]`);
      process.env.PANTA_API_KEY = process.env.PANTA_API_KEY.toUpperCase();
      expect(d({ efgh12: ["x"], qrstuvwx: ["x"], side: ["x"] })).toBe(`${base} fields=[side]`);
    } finally {
      if (prev === undefined) delete process.env.PANTA_API_KEY;
      else process.env.PANTA_API_KEY = prev;
    }
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
      name: "hostile `fields` (fake key, RPC URL with api-key, newline, ANSI, __proto__): names only",
      body:
        '{"code":"INVALID_MARKET_PARAMS","fields":{"__proto__":["polluted"],"amountUsdc":["FAKE_LINE ' +
        pantaKey +
        '"],"' +
        pantaKey +
        '":["x"],"' +
        ["https://mainnet.helius-rpc.com/?api", "key=deadbeefdeadbeef"].join("-") +
        '":["' +
        rpc +
        '"],"a\\nFAKE_LINE":["\\u001b[31mFAKE_LINE"],"\\u001b[31mansi":["x"],"side":["x"]}}',
      expectLine: "PantaError: Panta request failed (400) code=INVALID_MARKET_PARAMS fields=[amountUsdc,side]",
    },
    {
      name: "a `fields` that isn't an object or a string array: fields=unparsed",
      body: JSON.stringify({ code: "INVALID_MARKET_PARAMS", fields: [{ amountUsdc: pantaKey }] }),
      expectLine: "PantaError: Panta request failed (400) code=INVALID_MARKET_PARAMS fields=unparsed",
    },
    {
      name: "a message carrying the RPC URL and its pieces (K-03: redacted in both scripts)",
      body: JSON.stringify({
        code: "UPSTREAM",
        message: `upstream ${rpc} user pw0rd123 path ${rpcPathKey} ${rpc.split("?")[1]} ${["tok", "en=abc123def"].join("")}`,
      }),
      expectLine:
        "PantaError: upstream [redacted] [redacted] [redacted] path [redacted] api-key=[redacted] token=[redacted] code=UPSTREAM",
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
      for (const s of ["helius", "deadbeef", "polluted", "__proto__", "\u001b"]) expect(r.out).not.toContain(s);
      noSecrets(r.out);
    }, 60_000);

    it(`panta-build-check: ${c.name}`, async () => {
      const r = await run("panta-build-check.mjs", ["--market", market, "--side", "yes", "--amount", "1.00", "--wallet", wallet], env(c.body));
      expect(r.code).toBe(3); // unchanged: a failed check after config
      expect(r.out).toContain(`  FAIL error: ${c.expectLine}`);
      expect(r.out).toContain(`result: FAIL at error: ${c.expectLine}`);
      expect(r.out).not.toContain("FAKE_LINE");
      expect(r.out).not.toContain("gateway says no");
      for (const s of ["helius", "deadbeef", "polluted", "__proto__", "\u001b"]) expect(r.out).not.toContain(s);
      noSecrets(r.out);
    }, 60_000);
  }
});
