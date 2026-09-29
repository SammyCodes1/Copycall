import "server-only";
/**
 * Typed, allowlisted Panta API client (hard security requirement 1).
 *
 * - One exported function per Panta endpoint Copycall uses. There is NO generic
 *   "call any path" export and no catch-all proxy route, so the browser can never
 *   reach a Panta path that isn't listed here.
 * - The API key is read from the server env and sent only as the X-Api-Key header
 *   (docs: API keys must be sent in X-Api-Key; Bearer is for signup JWTs).
 * - Every response is validated with zod before it is returned.
 * - Panta rate-limits per endpoint FAMILY (docs /guides/errors, "Rate limits"):
 *   read 120/60s, positions 60/60s, quote 30/60s, build 20/60s, register 40/60s.
 *   A local sliding-window throttle per family keeps us at ~83% of each, and a
 *   response with X-RateLimit-Remaining: 0 pauses that family until
 *   X-RateLimit-Reset. 429s are retried with Retry-After / exponential backoff
 *   + jitter.
 * - When MOCK_PANTA=true every function returns fixture data instead
 *   (lib/mock/panta-mock.ts). Mock mode can never be on in production (lib/boot.ts).
 *
 * Docs: https://docs.panta.market/llms.txt
 */
import type { z } from "zod";
import { isMockMode, readEnv } from "./env";
import * as mock from "./mock/panta-mock";
import { PantaError } from "./panta-error";

export { PantaError };
import {
  BuildRequestSchema,
  BuildResponseSchema,
  ClaimBuildRequestSchema,
  ClaimBuildResponseSchema,
  MarketListResponseSchema,
  MarketSchema,
  MarketTradesResponseSchema,
  PantaErrorEnvelopeSchema,
  PhaseSchema,
  PositionsResponseSchema,
  PubkeySchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  ReportTradeRequestSchema,
  ReportTradeResponseSchema,
  WalletTradesResponseSchema,
  type BuildRequest,
  type BuildResponse,
  type ClaimBuildRequest,
  type ClaimBuildResponse,
  type MarketListResponse,
  type MarketTradesResponse,
  type PantaMarket,
  type Phase,
  type PositionsResponse,
  type QuoteRequest,
  type QuoteResponse,
  type ReportTradeRequest,
  type ReportTradeResponse,
  type WalletTradesResponse,
} from "./schemas";

/** The only host we will ever send the API key to. */
const ALLOWED_HOST = "live-api.panta.market";
const DEFAULT_BASE_URL = "https://live-api.panta.market/api/v1";

/** Page size caps from the docs. */
export const MARKETS_PAGE_MAX = 50; // GET /markets/ limit max 50 (default 20)
export const TRADES_LIMIT_MAX = 200; // trades endpoints capped at 200 rows (default 50)


// ---------------------------------------------------------------------------
// Low-level request plumbing (not exported)
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const raw = readEnv().PANTA_BASE_URL ?? DEFAULT_BASE_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== ALLOWED_HOST) {
    // Guard against a misconfigured env sending our key somewhere else.
    throw new Error(`PANTA_BASE_URL must be https://${ALLOWED_HOST}/...`);
  }
  return url.toString().replace(/\/+$/, "");
}

function getApiKey(): string {
  const key = readEnv().PANTA_API_KEY;
  if (!key) throw new Error("Missing required environment variable: PANTA_API_KEY");
  return key;
}

/** Panta rate-limit families (docs: /guides/errors#rate-limits). */
export type PantaFamily = "read" | "positions" | "quote" | "build" | "register";

/** Documented default max per 60 s window, per family. */
export const PANTA_FAMILY_LIMITS: Record<PantaFamily, number> = {
  read: 120,
  positions: 60,
  quote: 30,
  build: 20,
  register: 40,
};

/** Our own ceiling per family per minute: ~83% of the documented limit (read => 100/min). */
export const FAMILY_BUDGET_PER_MINUTE: Record<PantaFamily, number> = {
  read: 100,
  positions: 50,
  quote: 25,
  build: 16,
  register: 32,
};

/** Sliding-window throttle per family (per server instance). */
const recentCalls: Record<PantaFamily, number[]> = { read: [], positions: [], quote: [], build: [], register: [] };
/** Set when Panta says X-RateLimit-Remaining: 0 (ms epoch until which we hold off). */
const pausedUntil: Partial<Record<PantaFamily, number>> = {};

async function throttle(family: PantaFamily): Promise<void> {
  for (;;) {
    const now = Date.now();
    const pause = pausedUntil[family] ?? 0;
    if (pause > now) {
      await sleep(Math.min(pause - now, 60_000));
      continue;
    }
    const calls = recentCalls[family];
    while (calls.length && now - calls[0] > 60_000) calls.shift();
    if (calls.length < FAMILY_BUDGET_PER_MINUTE[family]) {
      calls.push(now);
      return;
    }
    await sleep(60_000 - (now - calls[0]) + 50);
  }
}

/** Honour X-RateLimit-Remaining / X-RateLimit-Reset (ISO-8601 UTC) on any response. */
function notePantaRateHeaders(family: PantaFamily, headers: Headers): void {
  if (headers.get("x-ratelimit-remaining")?.trim() !== "0") return;
  const reset = Date.parse(headers.get("x-ratelimit-reset") ?? "");
  const now = Date.now();
  // Cap the pause at one window in case the header is odd.
  pausedUntil[family] = Number.isFinite(reset) && reset > now ? Math.min(reset, now + 60_000) : now + 5_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay before retry #attempt (0-based) after a 429. Exported for tests. */
export function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSec = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
  const base = Number.isFinite(retryAfterSec) && retryAfterSec >= 0
    ? retryAfterSec * 1000
    : 500 * 2 ** attempt;
  const jitter = Math.random() * 250;
  return Math.min(base + jitter, 30_000);
}

const MAX_429_RETRIES = 4;

type RequestSpec = {
  method: "GET" | "POST";
  family: PantaFamily;
  /** Path relative to the base URL, with the REQUIRED trailing slash. */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

async function pantaRequest<S extends z.ZodTypeAny>(spec: RequestSpec, schema: S): Promise<z.infer<S>> {
  if (!spec.path.startsWith("/") || !spec.path.endsWith("/")) {
    throw new Error("Panta paths must start and end with '/'");
  }
  const url = new URL(getBaseUrl() + spec.path);
  for (const [k, v] of Object.entries(spec.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; ; attempt++) {
    await throttle(spec.family);
    const res = await fetch(url, {
      method: spec.method,
      headers: {
        "X-Api-Key": getApiKey(),
        Accept: "application/json",
        ...(spec.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
      cache: "no-store",
      redirect: "error", // never follow a redirect with our key attached
      signal: AbortSignal.timeout(15_000),
    });

    notePantaRateHeaders(spec.family, res.headers);
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      await sleep(backoffDelayMs(attempt, res.headers.get("retry-after")));
      continue;
    }

    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const env = PantaErrorEnvelopeSchema.safeParse(json);
      const code = env.success ? env.data.code : `HTTP_${res.status}`;
      const message = env.success && env.data.message ? env.data.message : `Panta request failed (${res.status})`;
      throw new PantaError(res.status, code, message);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new PantaError(502, "INVALID_RESPONSE", `Unexpected Panta response shape for ${spec.method} ${spec.path}`);
    }
    return parsed.data;
  }
}

/** Validate a path parameter (base58 pubkey) and URL-encode it. */
function pathPubkey(value: string): string {
  return encodeURIComponent(PubkeySchema.parse(value));
}

function clampLimit(limit: number | undefined, max: number): number {
  if (limit === undefined) return max;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

// ---------------------------------------------------------------------------
// Public API: one function per endpoint
// ---------------------------------------------------------------------------

export type ListMarketsParams = { status?: Phase; cursor?: string; limit?: number };

/** GET /markets/ - public catalog page. `status` is the market phase filter. */
export async function listMarkets(params: ListMarketsParams = {}): Promise<MarketListResponse> {
  const status = params.status ? PhaseSchema.parse(params.status) : undefined;
  const cursor = params.cursor ? PubkeySchema.parse(params.cursor) : undefined; // cursor is a marketId
  const limit = clampLimit(params.limit, MARKETS_PAGE_MAX);
  if (isMockMode()) return MarketListResponseSchema.parse(mock.listMarkets({ status, cursor, limit }));
  return pantaRequest({ method: "GET", family: "read", path: "/markets/", query: { status, cursor, limit } }, MarketListResponseSchema);
}

/** GET /markets/{marketId}/ - single market with spot prices when available. */
export async function getMarket(marketId: string): Promise<PantaMarket> {
  const id = pathPubkey(marketId);
  if (isMockMode()) return MarketSchema.parse(mock.getMarket(marketId));
  return pantaRequest({ method: "GET", family: "read", path: `/markets/${id}/` }, MarketSchema);
}

/** GET /markets/{marketId}/trades/ - public tape, max 200 rows, no cursor. */
export async function getMarketTrades(marketId: string, limit?: number): Promise<MarketTradesResponse> {
  const id = pathPubkey(marketId);
  const n = clampLimit(limit, TRADES_LIMIT_MAX);
  if (isMockMode()) return MarketTradesResponseSchema.parse(mock.getMarketTrades(marketId, n));
  return pantaRequest({ method: "GET", family: "read", path: `/markets/${id}/trades/`, query: { limit: n } }, MarketTradesResponseSchema);
}

/** GET /wallets/{wallet}/trades/ - a wallet's catalog trades, max 200 rows. */
export async function getWalletTrades(wallet: string, limit?: number): Promise<WalletTradesResponse> {
  const w = pathPubkey(wallet);
  const n = clampLimit(limit, TRADES_LIMIT_MAX);
  if (isMockMode()) return WalletTradesResponseSchema.parse(mock.getWalletTrades(wallet, n));
  return pantaRequest({ method: "GET", family: "read", path: `/wallets/${w}/trades/`, query: { limit: n } }, WalletTradesResponseSchema);
}

/** GET /positions/?wallet= - holdings; resolved rows carry `outcome`. */
export async function getPositions(wallet: string): Promise<PositionsResponse> {
  const w = PubkeySchema.parse(wallet);
  if (isMockMode()) return PositionsResponseSchema.parse(mock.getPositions(w));
  return pantaRequest({ method: "GET", family: "positions", path: "/positions/", query: { wallet: w } }, PositionsResponseSchema);
}

/** POST /primaryorderquote/ - quote a primary buy (response includes avgPrice). */
export async function quotePrimaryOrder(req: QuoteRequest): Promise<QuoteResponse> {
  const body = QuoteRequestSchema.parse(req);
  if (isMockMode()) return QuoteResponseSchema.parse(mock.quotePrimaryOrder(body));
  return pantaRequest({ method: "POST", family: "quote", path: "/primaryorderquote/", body }, QuoteResponseSchema);
}

/** POST /primaryorderbuild/ - unsigned instructions. Slippage is capped at 500 bps here too. */
export async function buildPrimaryOrder(req: BuildRequest): Promise<BuildResponse> {
  const body = BuildRequestSchema.parse(req);
  if (isMockMode()) return BuildResponseSchema.parse(mock.buildPrimaryOrder(body));
  return pantaRequest({ method: "POST", family: "build", path: "/primaryorderbuild/", body }, BuildResponseSchema);
}

/** POST /claim/build/ - unsigned win-claim instructions. */
export async function buildClaim(req: ClaimBuildRequest): Promise<ClaimBuildResponse> {
  const body = ClaimBuildRequestSchema.parse(req);
  if (isMockMode()) return ClaimBuildResponseSchema.parse(mock.buildClaim(body));
  return pantaRequest({ method: "POST", family: "build", path: "/claim/build/", body }, ClaimBuildResponseSchema);
}

/** POST /trades/ - report OUR confirmed signature for attribution (not a feed). */
export async function reportTrade(req: ReportTradeRequest): Promise<ReportTradeResponse> {
  const body = ReportTradeRequestSchema.parse(req);
  if (isMockMode()) return ReportTradeResponseSchema.parse(mock.reportTrade(body));
  return pantaRequest({ method: "POST", family: "register", path: "/trades/", body }, ReportTradeResponseSchema);
}
