import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  AuthError,
  NONCE_RATE_LIMIT,
  VERIFY_RATE_LIMIT,
  issueNonce,
  logout,
  resolveSession,
  verifyLogin,
  type AuthDeps,
} from "@/lib/auth-core";
import { API_CSP, buildCsp, generateNonce } from "@/lib/csp";
import { createMemoryAuthStore } from "@/lib/mock/auth-store-memory";
import { SESSION_TTL_SEC, signSession, verifySession } from "@/lib/session";
import { DENYLISTED_WALLETS, NONCE_TTL_MS, buildSignInMessage, isAllowedSignInWallet, verifyWalletSignature } from "@/lib/siws";
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

async function signIn(d: AuthDeps, w = testWallet()) {
  const { nonce, message } = await getNonce(d, w.address);
  return verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) }));
}

describe("F-01: keyless and special wallets are rejected", () => {
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";

  it("rejects the System Program at nonce issue", async () => {
    await expectAuthError(getNonce(deps(), SYSTEM_PROGRAM), "UNSUPPORTED_WALLET", 400);
  });

  it("rejects every denylisted program / sysvar id", async () => {
    for (const w of DENYLISTED_WALLETS) expect(isAllowedSignInWallet(w), w).toBe(false);
    await expectAuthError(getNonce(deps(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), "UNSUPPORTED_WALLET", 400);
    await expectAuthError(getNonce(deps(), "SysvarC1ock11111111111111111111111111111111"), "UNSUPPORTED_WALLET", 400);
  });

  it("rejects an off-curve key (e.g. a PDA)", async () => {
    // Find a 32-byte value that is not a valid curve point.
    let offCurve: string | null = null;
    for (let i = 1; i < 256 && !offCurve; i++) {
      const bytes = new Uint8Array(32).fill(i);
      try {
        ed25519.Point.fromBytes(bytes);
      } catch {
        offCurve = bs58.encode(bytes);
      }
    }
    expect(offCurve).not.toBeNull();
    expect(isAllowedSignInWallet(offCurve!)).toBe(false);
    await expectAuthError(getNonce(deps(), offCurve!), "UNSUPPORTED_WALLET", 400);
  });

  it("rejects a small-order key even with a signature tweetnacl would accept", () => {
    // With the identity point as the "public key", R = s*B, S = s verifies for
    // ANY message: [S]B == R + [k]A because A contributes nothing.
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const wallet = bs58.encode(identity);
    const message = buildSignInMessage({
      domain: "localhost:3000",
      uri: APP_ORIGIN,
      wallet,
      nonce: "n",
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + NONCE_TTL_MS),
    });
    const s = BigInt(12345);
    const R = ed25519.Point.BASE.multiply(s).toBytes();
    const S = new Uint8Array(32);
    let x = s;
    for (let i = 0; i < 32; i++) {
      S[i] = Number(x & BigInt(0xff));
      x >>= BigInt(8);
    }
    const forged = new Uint8Array([...R, ...S]);
    // Prove the forgery works against raw tweetnacl...
    expect(nacl.sign.detached.verify(new TextEncoder().encode(message), forged, identity)).toBe(true);
    // ...and that our checks refuse it.
    expect(isAllowedSignInWallet(wallet)).toBe(false);
    expect(verifyWalletSignature(message, bs58.encode(forged), wallet)).toBe(false);
  });

  it("rejects all listed small-order encodings and accepts normal keys", () => {
    for (const hex of [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000080",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ]) {
      expect(isAllowedSignInWallet(bs58.encode(Buffer.from(hex, "hex"))), hex).toBe(false);
    }
    for (let i = 0; i < 20; i++) expect(isAllowedSignInWallet(testWallet().address)).toBe(true);
  });
});

describe("rate limits on /api/auth/verify", () => {
  it(`allows ${VERIFY_RATE_LIMIT}/min per IP, then 429`, async () => {
    const d = deps();
    const body = { wallet: testWallet().address, nonce: "a".repeat(32), signature: testWallet().sign("x") };
    for (let i = 0; i < VERIFY_RATE_LIMIT; i++) {
      await expectAuthError(verifyLogin(d, jsonRequest("/api/auth/verify", { ...body, wallet: testWallet().address })), "INVALID_NONCE", 401);
    }
    await expectAuthError(verifyLogin(d, jsonRequest("/api/auth/verify", body)), "RATE_LIMITED", 429);
    // another IP still works
    const w = testWallet();
    const other = { "x-forwarded-for": "198.51.100.77" };
    const { nonce, message } = await getNonce(d, w.address, other);
    await expect(
      verifyLogin(d, jsonRequest("/api/auth/verify", { wallet: w.address, nonce, signature: w.sign(message) }, other)),
    ).resolves.toHaveProperty("token");
  });

  it(`allows ${VERIFY_RATE_LIMIT}/min per wallet across IPs, then 429`, async () => {
    const d = deps();
    const w = testWallet();
    const body = { wallet: w.address, nonce: "a".repeat(32), signature: w.sign("x") };
    for (let i = 0; i < VERIFY_RATE_LIMIT; i++) {
      const ip = { "x-forwarded-for": `198.51.100.${i + 1}` };
      await expectAuthError(verifyLogin(d, jsonRequest("/api/auth/verify", body, ip)), "INVALID_NONCE", 401);
    }
    await expectAuthError(
      verifyLogin(d, jsonRequest("/api/auth/verify", body, { "x-forwarded-for": "192.0.2.200" })),
      "RATE_LIMITED",
      429,
    );
  });
});

describe("session revocation", () => {
  it("a token resolves until logout, then is rejected (server-side)", async () => {
    const d = deps();
    const { token } = await signIn(d);
    expect(await resolveSession(d, token)).not.toBeNull();
    const out = await logout(d, jsonRequest("/api/auth/logout", {}), token);
    expect(out.revoked).toBe(true);
    // Still a validly signed, unexpired token, but revoked:
    expect(verifySession(token, SECRET)).not.toBeNull();
    expect(await resolveSession(d, token)).toBeNull();
  });

  it("logout revokes every token of that user; signing in again works", async () => {
    const d = deps();
    const w = testWallet();
    const a = await signIn(d, w);
    const b = await signIn(d, w);
    await logout(d, jsonRequest("/api/auth/logout", {}), a.token);
    expect(await resolveSession(d, b.token)).toBeNull();
    const c = await signIn(d, w);
    expect(await resolveSession(d, c.token)).not.toBeNull();
  });

  it("rejects a token with a stale or unknown session version", async () => {
    const d = deps();
    const { token, userId, wallet } = await signIn(d);
    await d.store.bumpSessionVersion(userId);
    expect(await resolveSession(d, token)).toBeNull();
    const current = await d.store.getSessionVersion(userId);
    expect(await resolveSession(d, signSession({ uid: userId, wallet, sessionVersion: current! }, SECRET))).not.toBeNull();
    expect(await resolveSession(d, signSession({ uid: "no-such-user", wallet, sessionVersion: 1 }, SECRET))).toBeNull();
  });

  it("rejects legacy v1 tokens without a session version", () => {
    const iat = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ v: 1, uid: "u", w: "w", iat, exp: iat + 60 })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
    expect(verifySession(`${body}.${sig}`, SECRET)).toBeNull();
  });

  it("logout requires same origin and is a no-op without a live session", async () => {
    const d = deps();
    const { token } = await signIn(d);
    await expectAuthError(logout(d, jsonRequest("/api/auth/logout", {}, { origin: "https://evil.example" }), token), "BAD_ORIGIN", 403);
    expect(await resolveSession(d, token)).not.toBeNull();
    expect((await logout(d, jsonRequest("/api/auth/logout", {}), undefined)).revoked).toBe(false);
  });

  it("fails closed when the store errors", async () => {
    const d = deps();
    const { token } = await signIn(d);
    const broken: AuthDeps = {
      ...d,
      store: { ...d.store, getSessionVersion: async () => Promise.reject(new Error("down")) },
    };
    expect(await resolveSession(broken, token)).toBeNull();
  });
});

describe("F-02: CSP", () => {
  it("uses a nonce + strict-dynamic and no 'unsafe-inline' for scripts in production", () => {
    const n = generateNonce();
    const csp = buildCsp(n, false);
    const script = csp.split("; ").find((x) => x.startsWith("script-src"))!;
    expect(script).toBe(`script-src 'self' 'nonce-${n}' 'strict-dynamic'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(buildCsp(n, true)).toContain("'unsafe-eval'");
    expect(API_CSP).toContain("default-src 'none'");
  });

  it("generates a fresh 128-bit nonce each time", () => {
    const a = generateNonce();
    expect(Buffer.from(a, "base64")).toHaveLength(16);
    expect(generateNonce()).not.toBe(a);
  });
});
