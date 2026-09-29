/**
 * Storage interface for the wallet-login flow. Two implementations:
 *  - lib/auth-store-supabase.ts (real; shared store, atomic Postgres functions)
 *  - lib/mock/auth-store-memory.ts (MOCK_PANTA=true only; demo without Supabase)
 */
export interface AuthStore {
  /** Persist a nonce bound to `wallet`. */
  createNonce(nonce: string, wallet: string, expiresAt: Date): Promise<void>;
  /**
   * Atomically delete the nonce for this wallet and return its expiry.
   * Returns null if it doesn't exist, was already used, or belongs to another wallet.
   */
  consumeNonce(nonce: string, wallet: string): Promise<Date | null>;
  /** Count one hit in a fixed window. Returns true if still within `limit`. */
  hitRateLimit(bucket: string, limit: number, windowSec: number): Promise<boolean>;
  /** Find or create the users row for a wallet; returns users.id. */
  upsertUser(wallet: string): Promise<string>;
}
