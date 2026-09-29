/**
 * Sign-In With Solana (SIWS-style) message + signature verification (addendum F).
 * Pure functions, no secrets, safe to unit-test.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const NONCE_TTL_MS = 5 * 60 * 1000;

export type SignInFields = {
  domain: string; // host of APP_URL, e.g. "copycall.app" or "localhost:3000"
  uri: string; // origin of APP_URL
  wallet: string; // base58 pubkey the nonce was issued to
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
};

/**
 * Builds the exact text the wallet signs. The server rebuilds it from stored
 * values at verify time, so the client never gets to choose any of the fields.
 */
export function buildSignInMessage(f: SignInFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.wallet,
    "",
    "Sign in to Copycall. This only proves you own this wallet. It does not send a transaction or cost any fees.",
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt.toISOString()}`,
    `Expiration Time: ${f.expiresAt.toISOString()}`,
  ].join("\n");
}

/**
 * Well-known keyless addresses (programs, sysvars, native mints). Nobody holds
 * a private key for these, so they must never be accepted as a sign-in wallet.
 * Most are off-curve or small-order anyway; this list is belt and braces.
 */
export const DENYLISTED_WALLETS: ReadonlySet<string> = new Set([
  // native / core programs
  "11111111111111111111111111111111", // System Program (all-zero key)
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token Account
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Memo v2
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", // Memo v1
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "NativeLoader1111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  // sysvars
  "Sysvar1111111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarEpochSchedu1e111111111111111111111111",
  "SysvarFees111111111111111111111111111111111",
  "SysvarRecentB1ockHashes11111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
  "SysvarS1otHistory11111111111111111111111111",
  "SysvarStakeHistory1111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarEpochRewards1111111111111111111111111",
  "SysvarLastRestartS1ot1111111111111111111111",
  // native mints
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP", // wrapped SOL (Token-2022)
]);

/**
 * Explicit small-order ed25519 encodings (the 8-torsion points plus common
 * non-canonical variants). With one of these as the "public key", a signature
 * can be forged for any message without a private key, so they are rejected
 * before signature verification even though tweetnacl would accept them.
 */
const SMALL_ORDER_HEX: ReadonlySet<string> = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000080",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
]);

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/**
 * True if `wallet` can be a real, key-holding sign-in wallet:
 * base58 of exactly 32 bytes, a canonical point on the ed25519 curve
 * (rejects PDAs and other off-curve addresses), not a small-order point, and
 * not a known program / sysvar / native-mint address.
 */
export function isAllowedSignInWallet(wallet: string): boolean {
  if (DENYLISTED_WALLETS.has(wallet)) return false;
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(wallet);
  } catch {
    return false;
  }
  if (bytes.length !== 32) return false;
  if (SMALL_ORDER_HEX.has(toHex(bytes))) return false;
  try {
    // fromBytes enforces a canonical encoding of a point on the curve
    // (same test as PublicKey.isOnCurve from @solana/web3.js).
    const point = ed25519.Point.fromBytes(bytes);
    if (point.isSmallOrder()) return false;
  } catch {
    return false; // off-curve (e.g. a PDA) or non-canonical
  }
  return true;
}

/**
 * True only if `signatureB58` is a valid ed25519 signature of `message` by the
 * key `wallet`. Because we verify against the wallet's own public key, a
 * signature from any other key (a different signer) fails.
 */
export function verifyWalletSignature(message: string, signatureB58: string, wallet: string): boolean {
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = bs58.decode(signatureB58);
    pub = bs58.decode(wallet);
  } catch {
    return false;
  }
  if (sig.length !== nacl.sign.signatureLength || pub.length !== nacl.sign.publicKeyLength) return false;
  // Keyless / small-order keys make forgeable "signatures"; never verify them.
  if (!isAllowedSignInWallet(wallet)) return false;
  return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
}
