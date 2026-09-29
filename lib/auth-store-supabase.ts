import "server-only";
import type { AuthStore } from "./auth-store";
import { getDb } from "./db";

/** Supabase-backed AuthStore (service role; tables have no anon/authenticated access). */
export const supabaseAuthStore: AuthStore = {
  async createNonce(nonce, wallet, expiresAt) {
    const { error } = await getDb()
      .from("auth_nonces")
      .insert({ nonce, wallet, expires_at: expiresAt.toISOString() });
    if (error) throw new Error("Failed to store nonce");
  },

  async consumeNonce(nonce, wallet) {
    // DELETE ... RETURNING inside a Postgres function => single atomic use.
    const { data, error } = await getDb().rpc("consume_auth_nonce", { p_nonce: nonce, p_wallet: wallet });
    if (error) throw new Error("Failed to consume nonce");
    return typeof data === "string" ? new Date(data) : null;
  },

  async hitRateLimit(bucket, limit, windowSec) {
    const { data, error } = await getDb().rpc("rate_limit_hit", {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSec,
    });
    if (error) throw new Error("Rate limiter unavailable");
    return data === true;
  },

  async upsertUser(wallet) {
    const { data, error } = await getDb()
      .from("users")
      .upsert({ wallet }, { onConflict: "wallet" })
      .select("id")
      .single();
    if (error || !data) throw new Error("Failed to upsert user");
    return data.id as string;
  },
};
