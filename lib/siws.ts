/**
 * Sign-In With Solana (SIWS-style) message + signature verification (addendum F).
 * Pure functions, no secrets, safe to unit-test.
 */
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
  return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
}
