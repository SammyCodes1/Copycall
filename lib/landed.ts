/**
 * E-03: USDC the fee payer lost in a landed transaction, from the chain's own
 * meta.preTokenBalances / postTokenBalances. Pure (no RPC), fail closed:
 * anything we can't attribute returns null (confirm answers a retryable
 * VERIFY_UNAVAILABLE), never 0.
 *
 * null when:
 *  - meta, preTokenBalances or postTokenBalances is missing;
 *  - there are no USDC rows at all (every copy debits and every claim pays USDC);
 *  - a USDC row has no `owner`, or an accountIndex outside the message's keys;
 *  - the user's USDC ATA is among the transaction's accounts but has no row
 *    (pre or post), or a row says someone else owns it.
 */
import { USDC_MINT, associatedTokenAddress } from "./solana-constants";

export type TokenBalanceRow = {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string };
};
export type TokenMeta = {
  preTokenBalances?: TokenBalanceRow[] | null;
  postTokenBalances?: TokenBalanceRow[] | null;
} | null | undefined;

export function payerUsdcOutFromMeta(meta: TokenMeta, accountKeys: readonly string[], payer: string): bigint | null {
  const pre = meta?.preTokenBalances;
  const post = meta?.postTokenBalances;
  if (!Array.isArray(pre) || !Array.isArray(post)) return null;
  const userAta = associatedTokenAddress(payer, USDC_MINT);
  let seen = 0;
  let ataSeen = false;
  const sum = (rows: TokenBalanceRow[]): bigint | null => {
    let n = 0n;
    for (const r of rows) {
      if (r?.mint !== USDC_MINT) continue;
      seen++;
      const key = Number.isInteger(r.accountIndex) ? accountKeys[r.accountIndex] : undefined;
      if (!key || typeof r.owner !== "string" || r.owner.length === 0) return null;
      if (!/^\d{1,20}$/.test(r.uiTokenAmount?.amount ?? "")) return null;
      if (key === userAta) {
        if (r.owner !== payer) return null;
        ataSeen = true;
      }
      if (r.owner === payer) n += BigInt(r.uiTokenAmount.amount);
    }
    return n;
  };
  const before = sum(pre);
  const after = sum(post);
  if (before === null || after === null || seen === 0) return null;
  if (accountKeys.includes(userAta) && !ataSeen) return null;
  return before - after;
}
