import { describe, expect, it } from "vitest";
import { AuthError, NONCE_RATE_LIMIT, issueNonce, verifyLogin, type AuthDeps } from "@/lib/auth-core";
import { createMemoryAuthStore } from "@/lib/mock/auth-store-memory";
import { SESSION_TTL_SEC, verifySession } from "@/lib/session";
import { NONCE_TTL_MS } from "@/lib/siws";
import { APP_ORIGIN, jsonRequest, testWallet } from "./helpers/wallet";

const SECRET = process.env.SESSION_SECRET!;

function deps(now = () => Date.now()): AuthDeps {
  return { store: createMemoryAuthStore(), appOrigin: APP_ORIGIN, sessionSecret: SECRET, now };
}

async function getNonce(d: AuthDeps, wallet: string, headers?: Record<string, string>) {
  return issueNonce(d, jsonRequest("/api/auth/nonce", { wallet }, headers));
}

async function expectAuthError(p: Promise<unknown>, code: string, status: number) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthError);
  expect((err as AuthError).code).toBe(code);
  expect((err as AuthError).status).toBe(status);
}

describe("wallet login (SIWS nonce flow)", () => {
  it("issues a SIWS-style message with domain, wallet, nonce, issued-at and expiry", async () => {
    const d = deps();
    const w = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    expect(message).toContain("localhost:3000 wants you to sign in with your Solana account:");
    expect(message).toContain(w.address);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toMatch(/Issued At: \d{4}-\d\d-\d\dT/);
    expect(message).toMatch(/Expiration Time: \d{4}-\d\d-\d\dT/);
  });

  it("accepts a valid signature and returns a signed 7-day session", async () => {
    const d = deps();
    const w = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    const res = await verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) }));
    const session = verifySession(res.token, SECRET);
    expect(session?.w).toBe(w.address);
    expect(session!.exp - session!.iat).toBe(SESSION_TTL_SEC);
  });

  it("rejects nonce reuse", async () => {
    const d = deps();
    const w = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    const body = { wallet: w.address, nonce, signature: w.sign(message) };
    await verifyLogin(d, jsonRequest("/api/auth/verify", body));
    await expectAuthError(verifyLogin(d, jsonRequest("/api/auth/verify", body)), "INVALID_NONCE", 401);
  });

  it("burns the nonce even when the first attempt has a bad signature", async () => {
    const d = deps();
    const w = testWallet();
    const attacker = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    await expectAuthError(
      verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: attacker.sign(message) })),
      "BAD_SIGNATURE",
      401,
    );
    await expectAuthError(
      verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) })),
      "INVALID_NONCE",
      401,
    );
  });

  it("rejects a signature from a different signer than the wallet", async () => {
    const d = deps();
    const w = testWallet();
    const other = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    await expectAuthError(
      verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: other.sign(message) })),
      "BAD_SIGNATURE",
      401,
    );
  });

  it("rejects a nonce presented with a different wallet (nonce is bound to its wallet)", async () => {
    const d = deps();
    const w = testWallet();
    const other = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    const forged = message.replace(w.address, other.address);
    await expectAuthError(
      verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: other.address, nonce, signature: other.sign(forged) })),
      "INVALID_NONCE",
      401,
    );
  });

  it("rejects a signature over a tampered message", async () => {
    const d = deps();
    const w = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    const tampered = message.replace("localhost:3000", "evil.example");
    await expectAuthError(
      verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(tampered) })),
      "BAD_SIGNATURE",
      401,
    );
  });

  it("rejects an expired nonce (after 5 minutes)", async () => {
    let now = Date.now();
    const d = deps(() => now);
    const w = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    now += NONCE_TTL_MS + 1;
    await expectAuthError(
      verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) })),
      "NONCE_EXPIRED",
      401,
    );
  });

  it("rejects a bad Origin on nonce and verify", async () => {
    const d = deps();
    const w = testWallet();
    await expectAuthError(getNonce(d, w.address, { origin: "https://evil.example" }), "BAD_ORIGIN", 403);
    const { nonce, message } = await getNonce(d, w.address);
    await expectAuthError(
      verifyLogin(
        d,
        jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) }, { origin: "http://localhost:3001" }),
      ),
      "BAD_ORIGIN",
      403,
    );
  });

  it("rejects a missing Origin header", async () => {
    const d = deps();
    const req = new Request(`${APP_ORIGIN}/api/auth/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: testWallet().address }),
    });
    await expectAuthError(issueNonce(d, req), "BAD_ORIGIN", 403);
  });

  it(`rate-limits /api/auth/nonce to ${NONCE_RATE_LIMIT}/min per IP`, async () => {
    const d = deps();
    const w = testWallet();
    for (let i = 0; i < NONCE_RATE_LIMIT; i++) await getNonce(d, w.address);
    await expectAuthError(getNonce(d, w.address), "RATE_LIMITED", 429);
    // a different IP is unaffected
    await expect(getNonce(d, w.address, { "x-forwarded-for": "198.51.100.9" })).resolves.toHaveProperty("nonce");
  });

  it("rejects malformed wallets and unknown body fields", async () => {
    const d = deps();
    await expectAuthError(getNonce(d, "not-a-wallet"), "INVALID_WALLET", 400);
    await expectAuthError(
      issueNonce(d, jsonRequest("/api/auth/nonce", { wallet: testWallet().address, extra: 1 })),
      "INVALID_WALLET",
      400,
    );
  });
});

describe("session tokens", () => {
  it("rejects tampered, foreign-secret and expired tokens", async () => {
    const d = deps();
    const w = testWallet();
    const { nonce, message } = await getNonce(d, w.address);
    const { token } = await verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) }));
    const [body, sig] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), w: testWallet().address })).toString("base64url");
    expect(verifySession(`${forgedBody}.${sig}`, SECRET)).toBeNull();
    expect(verifySession(token, "x".repeat(40))).toBeNull();
    expect(verifySession(token, SECRET, Date.now() + (SESSION_TTL_SEC + 1) * 1000)).toBeNull();
  });
});
