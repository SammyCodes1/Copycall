/**
 * In-memory AuthStore for MOCK MODE ONLY (lets the login flow be demoed
 * without Supabase). Not shared across server instances, so it must never run
 * in production: the factory in lib/auth.ts only uses it when isMockMode(),
 * and this module refuses to construct on a Vercel production deployment.
 */
import { randomUUID } from "node:crypto";
import type { AuthStore } from "../auth-store";
import { assertBootSafe, isVercelProduction } from "../boot";

type State = {
  nonces: Map<string, { wallet: string; expiresAt: Date }>;
  limits: Map<string, number>;
  users: Map<string, string>; // wallet -> id
};

export function createMemoryAuthStore(state?: State): AuthStore {
  assertBootSafe(process.env);
  if (isVercelProduction(process.env)) throw new Error("Memory auth store is not allowed in production");

  const s: State = state ?? { nonces: new Map(), limits: new Map(), users: new Map() };
  return {
    async createNonce(nonce, wallet, expiresAt) {
      s.nonces.set(nonce, { wallet, expiresAt });
    },
    async consumeNonce(nonce, wallet) {
      const row = s.nonces.get(nonce);
      if (!row || row.wallet !== wallet) return null;
      s.nonces.delete(nonce); // single-threaded JS: get+delete is atomic here
      return row.expiresAt;
    },
    async hitRateLimit(bucket, limit, windowSec) {
      const windowStart = Math.floor(Date.now() / 1000 / windowSec);
      const key = `${bucket}|${windowStart}`;
      const count = (s.limits.get(key) ?? 0) + 1;
      s.limits.set(key, count);
      return count <= limit;
    },
    async upsertUser(wallet) {
      let id = s.users.get(wallet);
      if (!id) {
        id = randomUUID();
        s.users.set(wallet, id);
      }
      return id;
    },
  };
}

/** One shared instance per server process (survives Next dev module reloads). */
export function getSharedMemoryAuthStore(): AuthStore {
  const g = globalThis as unknown as { __copycallMemoryAuth?: AuthStore };
  return (g.__copycallMemoryAuth ??= createMemoryAuthStore());
}
