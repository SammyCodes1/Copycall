import bs58 from "bs58";

/** The ed25519 group order L = 2^252 + 27742317777372353535851937790883648493. */
export const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

/**
 * G-07: a signature is canonical only if its S half (little-endian bytes 32..64) is < L.
 * tweetnacl doesn't check this, so S + L would also verify and give the same transaction
 * a second signature string. We refuse anything non-canonical before verifying or storing it.
 */
export function isCanonicalSignature(sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]);
  return s < ED25519_L;
}

/** Same, for a base58 signature string (anything undecodable is non-canonical). */
export function isCanonicalSignatureB58(sig: string): boolean {
  try {
    return isCanonicalSignature(bs58.decode(sig));
  } catch {
    return false;
  }
}
