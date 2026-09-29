/**
 * Well-known Solana program ids and the USDC mint (mainnet). No secrets, no RPC.
 * Shared by the transaction guard, the mock chain and tests.
 */
import { PublicKey } from "@solana/web3.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";

/** Circle USDC on Solana mainnet (6 decimals). */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** Associated token account address (same derivation as @solana/spl-token, without the dependency). */
export function associatedTokenAddress(
  owner: string,
  mint: string = USDC_MINT,
  tokenProgram: string = TOKEN_PROGRAM_ID,
): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM_ID),
  );
  return ata.toBase58();
}

/** "5.00" -> 5_000_000n (USDC base units). Rejects anything that isn't a plain non-negative decimal. */
export function usdcToBase(amount: string | number): bigint {
  const s = typeof amount === "number" ? amount.toFixed(USDC_DECIMALS) : amount.trim();
  const m = /^(\d{1,12})(?:\.(\d{1,6})\d*)?$/.exec(s);
  if (!m) throw new Error(`Invalid USDC amount: ${s}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
}

/** 5_000_000n -> "5.00" (2 dp, rounded down) for display. */
export function baseToUsdc(base: bigint): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const whole = v / 1_000_000n;
  const cents = (v % 1_000_000n) / 10_000n;
  return `${neg ? "-" : ""}${whole}.${cents.toString().padStart(2, "0")}`;
}
