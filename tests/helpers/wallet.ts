import bs58 from "bs58";
import nacl from "tweetnacl";

/** A throwaway ed25519 keypair acting as a Solana wallet in tests. */
export function testWallet() {
  const kp = nacl.sign.keyPair();
  return {
    address: bs58.encode(kp.publicKey),
    secretKey: kp.secretKey,
    sign(message: string) {
      return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
    },
  };
}

export const APP_ORIGIN = "http://localhost:3000";

export function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, "x-forwarded-for": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });
}
