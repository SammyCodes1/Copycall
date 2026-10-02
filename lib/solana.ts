import "server-only";
/**
 * Solana RPC helpers (server only). SOLANA_RPC_URL is a dedicated mainnet RPC
 * (Helius); its URL usually embeds an API key, so it never reaches the client.
 *
 * getMarketCreator() for the creator flag, and `rpcChain` (simulate, broadcast,
 * confirm, fetch) for the copy and claim flows. Validation rules live in
 * lib/tx-guard.ts; this file only talks to the RPC.
 */
import { Connection, PublicKey, type ConfirmedSignatureInfo, type VersionedTransaction } from "@solana/web3.js";
import { SendError, type Chain, type ConfirmationState } from "./chain";
import { payerUsdcOutFromMeta } from "./landed";
import { innerProgramIds, innerSystemOps, type InnerSystemOp } from "./tx-guard";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./solana-constants";
import creatorsJson from "@/fixtures/creators.json";
import { isMockMode, requireEnv } from "./env";

let connection: Connection | null = null;

/** Mainnet connection. The network is explicit: the RPC must be a mainnet endpoint. */
export function getConnection(): Connection {
  if (connection) return connection;
  const url = requireEnv("SOLANA_RPC_URL");
  if (!/^https:\/\//.test(url)) throw new Error("SOLANA_RPC_URL must be an https URL");
  connection = new Connection(url, {
    commitment: "confirmed",
    disableRetryOnRateLimit: false,
    // Every RPC call gives up after 15 s, well under the crons' 120 s (audit B2-11).
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
  });
  return connection;
}

export const RPC_TIMEOUT_MS = 15_000;

/**
 * I-01: web3.js 1.99's sendRawTransaction turns every JSON-RPC error into a SendTransactionError
 * "Simulation failed" and drops the JSON-RPC code. So the send is one plain JSON-RPC call here, and
 * the structured error decides refused vs unclear (see SendError). Same params as before:
 * preflight on at `confirmed`, maxRetries 3.
 */
export async function sendRawClassified(raw: Uint8Array): Promise<string> {
  const url = requireEnv("SOLANA_RPC_URL");
  if (!/^https:\/\//.test(url)) throw new Error("SOLANA_RPC_URL must be an https URL");
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [Buffer.from(raw).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }],
  });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SendError("unclear", null, `send: ${err instanceof Error ? err.name : "network error"}`);
  }
  if (!res.ok) throw new SendError("unclear", null, `send: HTTP ${res.status}`);
  let json: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new SendError("unclear", null, "send: unreadable response");
  }
  if (typeof json.result === "string") return json.result;
  return classifySendRpcError(json.error);
}

/** Pure, for tests: a JSON-RPC sendTransaction error -> SendError (or a success for AlreadyProcessed). */
export function classifySendRpcError(error: unknown): never {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  const code = typeof e.code === "number" ? e.code : null;
  const msg = typeof e.message === "string" ? e.message.slice(0, 160) : "";
  const txErr = e.data && typeof e.data === "object" ? (e.data as { err?: unknown }).err : undefined;
  if (code === -32002 && txErr === "AlreadyProcessed") throw new SendError("unclear", code, "already processed");
  if (code === -32002 && txErr !== undefined && txErr !== null)
    throw new SendError("refused", code, `preflight: ${typeof txErr === "string" ? txErr : JSON.stringify(txErr).slice(0, 120)}`);
  if (code === -32003) throw new SendError("refused", code, "signature verification failed");
  throw new SendError("unclear", code, `rpc ${code ?? "?"}: ${msg}`);
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

  const tx = await conn.getTransaction(oldest.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx || tx.meta?.err) return null;
  const feePayer = tx.transaction.message.staticAccountKeys[0];
  return feePayer ? { creator: feePayer.toBase58(), verified: false } : null;
}

// ---------------------------------------------------------------- copy / claim flows

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real chain access over SOLANA_RPC_URL. The browser never talks to the RPC. */
export const rpcChain: Chain = {
  async getTokenAccounts(owner) {
    const conn = getConnection();
    const pk = new PublicKey(owner);
    const lists = await Promise.all(
      [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
        conn.getTokenAccountsByOwner(pk, { programId: new PublicKey(programId) }, "confirmed"),
      ),
    );
    return lists.flatMap((l) =>
      l.value.map((a) => ({
        pubkey: a.pubkey.toBase58(),
        data: Buffer.from(a.account.data),
        lamports: a.account.lamports,
      })),
    );
  },

  async getLamports(owner) {
    return getConnection().getBalance(new PublicKey(owner), "confirmed");
  },

  async simulate(tx: VersionedTransaction, addresses: string[]) {
    const res = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false, // simulate the EXACT bytes we will hand to the wallet
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses },
      innerInstructions: true, // B3-04: we check every CPI target
    });
    let innerPrograms: string[] | null = null;
    try {
      innerPrograms = innerProgramIds(
        res.value.innerInstructions,
        tx.message.staticAccountKeys.map((k) => k.toBase58()),
      );
    } catch {
      innerPrograms = null; // unreadable: the guard fails closed
    }
    let systemOps: InnerSystemOp[] | null = null;
    try {
      systemOps = innerSystemOps(res.value.innerInstructions, tx.message.staticAccountKeys.map((k) => k.toBase58()));
    } catch {
      systemOps = null;
    }
    return {
      err: res.value.err ?? null,
      logs: res.value.logs ?? [],
      // F-01: owner and executable come back with every account (base64 encoding).
      accounts: (res.value.accounts ?? []).map((a) =>
        a
          ? { data: Buffer.from(a.data[0], "base64"), lamports: a.lamports, owner: String(a.owner), executable: a.executable === true }
          : null,
      ),
      innerPrograms,
      innerSystemOps: systemOps,
    };
  },

  async send(raw) {
    return sendRawClassified(raw);
  },

  async signatureSeen(signature) {
    const { value } = await getConnection().getSignatureStatuses([signature], { searchTransactionHistory: true });
    return value[0] != null;
  },

  async waitForConfirmation(signature, lastValidBlockHeight, timeoutMs, blockhash): Promise<ConfirmationState> {
    const conn = getConnection();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const read = async () => (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    const landed = (st: Awaited<ReturnType<typeof read>>): ConfirmationState | null =>
      st?.err ? "failed" : st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized" ? "confirmed" : null;
    // G-01: always at least one status read, even with a zero budget (the cron sweep passes 0).
    for (;;) {
      const now = landed(await read());
      if (now) return now;
      // G-02: expiry from the block height when we have it, else from the blockhash itself.
      const expired =
        lastValidBlockHeight !== null
          ? (await conn.getBlockHeight("confirmed")) > lastValidBlockHeight
          : blockhash
            ? !(await conn.isBlockhashValid(blockhash, { commitment: "confirmed" })).value
            : false;
      if (expired) {
        // B3-06: the tx may have landed between the two reads. Ask once more before saying expired.
        return landed(await read()) ?? "expired";
      }
      if (Date.now() + 1000 >= deadline) return "pending";
      await sleep(1000);
    }
  },

  async isBlockhashValid(blockhash) {
    return (await getConnection().isBlockhashValid(blockhash, { commitment: "confirmed" })).value === true;
  },

  async getLandedTransaction(signature) {
    const tx = await getConnection().getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return null;
    const payer = tx.transaction.message.staticAccountKeys[0]?.toBase58();
    const allKeys = [
      ...tx.transaction.message.staticAccountKeys.map((k) => k.toBase58()),
      ...(tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ];
    // E-03: attributed row by row; anything unattributable is null (fail closed), never 0.
    const payerUsdcOutBase = payer ? payerUsdcOutFromMeta(tx.meta, allKeys, payer) : null;
    let innerPrograms: string[] | null = null;
    let systemOps: InnerSystemOp[] | null = null;
    try {
      innerPrograms = innerProgramIds(tx.meta?.innerInstructions, allKeys);
      systemOps = innerSystemOps(tx.meta?.innerInstructions, allKeys);
    } catch {
      innerPrograms = null;
      systemOps = null;
    }
    return {
      err: tx.meta?.err ?? null,
      message: tx.transaction.message,
      signatures: tx.transaction.signatures,
      payerUsdcOutBase,
      innerPrograms,
      innerSystemOps: systemOps,
      payerPostLamports: typeof tx.meta?.postBalances?.[0] === "number" ? tx.meta.postBalances[0] : null,
    };
  },

  async getWalletAccount(address) {
    const info = await getConnection().getAccountInfo(new PublicKey(address), "confirmed");
    return info ? { owner: info.owner.toBase58(), executable: info.executable, dataLength: info.data.length } : null;
  },
};
