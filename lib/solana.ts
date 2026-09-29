import "server-only";
/**
 * Solana RPC helpers (server only). SOLANA_RPC_URL is a dedicated mainnet RPC
 * (Helius); its URL usually embeds an API key, so it never reaches the client.
 *
 * Batch 2 needs only getMarketCreator(). Transaction validation, broadcast and
 * confirmation arrive with the copy flow (step 9).
 */
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import creatorsJson from "@/fixtures/creators.json";
import { isMockMode, requireEnv } from "./env";

let connection: Connection | null = null;

/** Mainnet connection. The network is explicit: the RPC must be a mainnet endpoint. */
export function getConnection(): Connection {
  if (connection) return connection;
  const url = requireEnv("SOLANA_RPC_URL");
  if (!/^https:\/\//.test(url)) throw new Error("SOLANA_RPC_URL must be an https URL");
  connection = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: false });
  return connection;
}

export type CreatorLookup = { creator: string; verified: false };

/** Signature pages to walk back (1000 each) before giving up on a very busy market. */
const MAX_SIGNATURE_PAGES = 5;

/**
 * Who created a market, found on-chain from the market's create transaction.
 *
 * TODO(creator): which account in the create transaction is the creator is NOT
 * confirmed yet. Until the account layout of Panta's create instruction is
 * confirmed, we treat the FEE PAYER (first signer, accountKeys[0]) of the
 * market address's OLDEST transaction as the creator, and return
 * verified: false so the UI labels the flag "unverified". When confirmed,
 * change only this function (e.g. read the creator account from the create
 * instruction) and set verified: true.
 *
 * Returns null when it can't be determined (too many signatures to walk,
 * transaction not available). Results are cached by the caller in
 * markets.creator_wallet so each market is looked up once.
 */
export async function getMarketCreator(marketAddress: string): Promise<CreatorLookup | null> {
  const address = new PublicKey(marketAddress); // throws on invalid input

  if (isMockMode()) {
    const creator = (creatorsJson as Record<string, string>)[address.toBase58()];
    return creator ? { creator, verified: false } : null;
  }

  const conn = getConnection();
  // Walk back to the oldest signature that touched the market address.
  let before: string | undefined;
  let oldest: ConfirmedSignatureInfo | undefined;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const sigs = await conn.getSignaturesForAddress(address, { before, limit: 1000 });
    if (sigs.length === 0) break;
    oldest = sigs[sigs.length - 1];
    if (sigs.length < 1000) {
      before = undefined;
      break;
    }
    before = oldest.signature;
  }
  if (!oldest || before !== undefined) return null; // nothing found, or history too long to walk

  const tx = await conn.getTransaction(oldest.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx || tx.meta?.err) return null;
  const feePayer = tx.transaction.message.staticAccountKeys[0];
  return feePayer ? { creator: feePayer.toBase58(), verified: false } : null;
}
