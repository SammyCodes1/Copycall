# Copycall

One-tap copy trading for [Panta](https://panta.market) prediction markets on Solana.
Copycall ranks Panta traders by hit rate, lets you follow them, pings you when they
buy, and lets you copy the call after a review screen, **signed by your own wallet**.
Copying is never automatic. Copycall never holds funds or private keys.

> Status: **batch 1** (scaffold, typed Panta client + mock fixtures, Supabase schema
> with RLS, wallet login). Leaderboard sync, follow/settings, Telegram, copy and claim
> flows come in later batches.

## Requirements

- Node.js **22 LTS** recommended (Next.js 16 needs >= 20.9; Supabase JS warns on Node 20)
- npm 10+
- [gitleaks](https://github.com/gitleaks/gitleaks#installing) (the pre-commit hook needs it)
- For real mode: a Supabase project, a Panta API key, a Solana mainnet RPC (e.g. Helius)

## Quick start (mock mode, no accounts needed)

PowerShell:

```powershell
cd copycall\app
npm install
Copy-Item .env.example .env.local
# generate a session secret and put it in .env.local as SESSION_SECRET=
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm run dev
# open http://localhost:3000
```

bash:

```bash
cd copycall/app && npm install && cp .env.example .env.local
echo "SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" >> .env.local
npm run dev
```

With `MOCK_PANTA=true` (the template default) the app uses the fixtures in `/fixtures`,
an in-memory login store, and shows a **MOCK MODE** banner. Wallet login works with a real
Phantom/Solflare extension (it only signs a text message; nothing is sent on-chain).

## Scripts

| Command | What it does |
| - | - |
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript) |
| `npm test` | Vitest: auth, boot guard, Panta schemas/client, stats, sync, leaderboard, follow/settings, Telegram/alerts, SQL migrations (in-process Postgres via PGlite) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:bundle` | After a build, scans `.next/static` for secret names, `pk_` prefixes and secret values |
| `node scripts/gen-fixtures.mjs` | Regenerates the deterministic mock fixtures |
| `node --env-file=.env.local scripts/telegram-set-webhook.mjs` | Registers the Telegram webhook with `secret_token` (`--info` shows the current one). Never prints the token |

## Environment variables

See `.env.example`. Everything is server-only except the two `NEXT_PUBLIC_SUPABASE_*`
values, which the app does not currently read (the browser never queries Supabase).

| Var | Notes |
| - | - |
| `PANTA_API_KEY` | Sent only as `X-Api-Key` from `lib/panta.ts` |
| `PANTA_BASE_URL` | Must be `https://live-api.panta.market/api/v1`; any other host is refused |
| `SOLANA_RPC_URL` | Mainnet RPC; server only |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server only (`lib/db.ts`) |
| `SESSION_SECRET` | >= 32 chars; signs the session cookie |
| `APP_URL` | Exact origin, e.g. `https://copycall.example`; used for the sign-in domain and the Origin check |
| `MOCK_PANTA` | `true` = fixtures. **The app refuses to build/boot if `MOCK_PANTA=true` and `VERCEL_ENV=production`.** |
| `MIN_RESOLVED_CALLS` | Default 5 |
| `CRON_SECRET` | >= 16 chars (use 32+). Cron routes need `Authorization: Bearer <CRON_SECRET>`; query-string secrets are refused |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Both needed for Telegram. If either is missing, alerts are written to the server log instead |
| `PANTA_PROGRAM_IDS` | Comma-separated Panta program ids for the transaction guard. Required in real mode: copy and claim fail closed (503) without it |

## Batch 2: sync, leaderboard, follow, alerts

**Routes**

| Route | Auth | What it does |
| - | - | - |
| `GET /api/cron/leaderboard` | Bearer `CRON_SECRET` | Pages markets, pulls trade tapes (upsert, deduped by signature), looks up market creators, refreshes positions and `trader_stats` |
| `GET /api/cron/alerts` | Bearer `CRON_SECRET` | Polls followed wallets' trades and creates/sends alerts for new buys |
| `GET /api/leaderboard?limit=` | public | Ranked wallets with >= `MIN_RESOLVED_CALLS` resolved calls |
| `GET /api/trader/[wallet]` | public | Stats, open positions, recent calls (400 if not a base58 pubkey) |
| `POST/DELETE /api/follow` | session + Origin | `{ "wallet": "..." }` |
| `GET/PUT /api/settings` | session (+ Origin on PUT) | Max stake (USDC), slippage (default 200 bps, hard max 500), alerts on/off |
| `POST /api/telegram/link` | session + Origin | One-time code (10 min) and `https://t.me/<bot>?start=<code>` |
| `POST /api/telegram/webhook` | `X-Telegram-Bot-Api-Secret-Token` | `/start <code>` links the chat, `/stop` pauses alerts |

**Cron schedule** (`vercel.json`): alerts every 2 minutes, leaderboard every 15 minutes.
Sub-daily crons need a Vercel Pro plan; on Hobby, call the routes from any scheduler with the
Bearer header. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when the env var is set.

**Panta rate limits.** Panta limits requests per endpoint family (docs: errors guide). `lib/panta.ts`
keeps each family under its limit per instance: read 100/min (limit 120), positions 50 (60),
quote 25 (30), build 16 (20), register 32 (40). It pauses a family when `X-RateLimit-Remaining`
hits 0 and backs off on 429. Each cron run also has its own call budget and stops a phase
early on a 429.

**Data notes.** Panta trade rows carry YES/NO amounts but no side field, so side is derived
from the amounts (rows with both or neither are skipped) and only `isPrimary` rows count as buys.
There is no market outcome field; outcomes come from resolved positions. `marketId` equals the
market address. Market creators come from Solana (`lib/solana.ts`, fee payer of the market
account's oldest transaction). This is a heuristic, so it is always shown as **unverified**.

**Telegram setup**

1. Create a bot with @BotFather and put the token in `TELEGRAM_BOT_TOKEN`.
2. Generate `TELEGRAM_WEBHOOK_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
3. Deploy, then run `node --env-file=.env.local scripts/telegram-set-webhook.mjs` (needs an https `APP_URL`).
4. In Settings, press **Connect Telegram**, open the link and press Start.

Alerts are plain text, titles are cut to 120 characters and made non-clickable, and the only
link is `APP_URL/copy/<trade id>`, so amounts and sides never go in a URL. Alerts can lag a few minutes.

**Mock demo (no accounts):** sign in, follow a trader from the leaderboard, then run
`curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/alerts` after the next
minute. Every fixture wallet makes one simulated buy per minute, and the alert shows up in the server log
(`alert (Telegram not configured)`) because Telegram isn't configured.

## Batch 3: copy and claim

Flow (all Panta calls and all checks run on the server; the browser only signs):

1. `GET /api/copy/[tradeId]/quote`: session required. Market and side come from the stored trade, the amount
   from your settings; query parameters are ignored. Returns a single-use `quoteToken` (~75 s). Cached 10 s,
   10/min per user.
2. `POST /api/copy/[tradeId]/build` `{quoteToken}`: Panta build, then `lib/tx-guard.ts` checks the instructions
   (program allowlist, you are the only signer and fee payer, one Panta instruction for this market, no
   approvals / authority changes / closes, compute-budget and priority-fee caps, USDC out ≤ max stake), assembles
   the v0 transaction, and simulates it (USDC decrease ≤ max stake, other token accounts unchanged, SOL spend ≤ 0.02).
   The fee must match the quote. The exact bytes are stored as a pending order (90 s).
   **Fee model:** the max stake is the hard total, fee included. We quote Panta with `amountUsdc` = max stake;
   the quoted `feeUsdc` comes out of it, so (stake − fee) buys shares and the estimate is
   (stake − fee) / `avgPrice` (never above Panta's `shares`). Slippage costs shares, never extra USDC: the review
   shows the minimum shares at the cap. The guard's limit is the max stake itself, with no fee or slippage
   headroom (5.00 approved = 5.00 limit). Shared math: `lib/copy-math.ts`.
3. The wallet signs those exact bytes. `POST /api/copy/confirm` `{orderId, signedTransaction}`: the message
   hash must match, the signature must verify for the session wallet and be unused. The server broadcasts,
   waits for confirmation, re-checks the landed transaction, records the copy atomically
   (`complete_order`), then reports it to Panta (`POST /trades/`).
4. `/positions` (`GET /api/positions`, 30 s cache) lists holdings from Panta's index; a resolved win shows
   Claim (`POST /api/claim/build` `{marketId}` then `/api/claim/confirm`), with no USDC allowed to leave.

Mock mode runs the same flow against a synthetic in-memory chain (`lib/mock/chain-mock.ts`); signing is
simulated server-side and labelled "Simulated signing" everywhere. Demo: sign in, follow a trader, run both
crons (see Batch 2), open the copy link from the log, Review and sign, then visit `/positions` and claim.

## Batch 2 audit fixes

- **Telegram linking (B2-01):** `/start <code>` only shows the wallet the code belongs to and asks for an
  inline-button confirmation; the chat is linked when the button is pressed. The account that loses the chat is
  told in the chat and sees "Telegram unlinked" in settings; an account moving to a new chat notifies its old
  chat. `scripts/telegram-set-webhook.mjs` now subscribes to `message` and `callback_query` (re-run it).
- **Webhook (B2-05/06):** the route itself requires `TELEGRAM_WEBHOOK_SECRET` to be 32-256 chars of
  `[A-Za-z0-9_-]` (otherwise every request is 401 and Telegram counts as not configured). After a valid secret
  it always answers 200 and drops oversized or malformed updates.
- **Follow cap (B2-03):** `follow_capped()` checks and inserts under a row lock on the user.
- **Sync (B2-04):** a non-429 error only affects its own market tape or wallet, which backs off
  (`sync_failures`, 10 min doubling to 24 h). Only 429 stops a phase. The summary reports `failed` counts.
- **Titles (B2-02/08/09):** NFKC, all `Cf` characters stripped, dot look-alikes mapped, every dot between
  alphanumerics defanged (plain decimals like 3.50 excepted), bare IPs, `/commands`, `#tags` and `@mentions`
  neutralised, then truncated to 120.
- **Public reads (B2-07):** trader rank comes from `trader_rank()` in SQL; `/api/leaderboard`, `/api/trader/*` and
  `/trader/*` are limited to 60 requests per minute per IP (429 with `Retry-After`).
- **Timeouts and retries (B2-11):** Telegram API calls time out after 10 s and RPC calls after 15 s. Failed or
  stale-pending alerts are retried up to 3 attempts, 2+ minutes apart, while under 30 minutes old.

## Real mode setup (Supabase)

1. Create a Supabase project. Apply the SQL in `supabase/migrations/` in order
   (Supabase CLI: `supabase db push`, or paste each file into the SQL editor).
2. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PANTA_API_KEY`, `SOLANA_RPC_URL`,
   `SESSION_SECRET`, `APP_URL`, and `MOCK_PANTA=false`.
3. Note: Panta docs say both `pk_test_` and `pk_live_` keys are accepted on the same
   production API. There is no documented sandbox, so treat a test key as able to touch
   real markets.

## Security model (batch 1)

- **Panta key** only in `lib/panta.ts` (`import "server-only"`), one function per endpoint,
  no proxy route, base58-validated path params, host allowlist, `redirect: "error"`,
  zod-validated responses, 429 backoff (Retry-After + jitter) and a ~100 req/min throttle.
- **Supabase**: RLS on every table. Public `SELECT` policies only on `markets`, `trades`,
  `trader_stats`. No anon/authenticated policies (and privileges revoked) on `users`,
  `follows`, `alerts`, `copies`, `auth_nonces`, `telegram_link_codes`, `rate_limits`.
  RPC functions are executable by `service_role` only.
- **Login**: SIWS-style message (domain, wallet, nonce, issued-at, expiry), nonce bound to
  the wallet, 5-minute expiry, consumed atomically with `DELETE ... RETURNING` before the
  signature check, ed25519 verify against the wallet key (tweetnacl).
- **Keyless wallets refused** (`isAllowedSignInWallet` in `lib/siws.ts`): at nonce issue, at
  verify and inside the signature check we reject off-curve keys (PDAs), small-order ed25519
  points (which allow forged signatures), and a denylist of program, sysvar and native-mint ids
  (System, Token, Token-2022, ATA, Compute Budget, Memo, Vote, Stake, loaders, sysvars, wSOL).
- **Sessions**: cookie `__Host-cc_session` (HttpOnly, Secure, SameSite=Lax, 7 days,
  HMAC-signed) carries `users.session_version` (`sv`). Every `getSession()` re-checks it
  in the database; logout bumps it (`bump_session_version`, service role only), so a
  logged-out or stolen token stops working at once. If the store is unreachable there is no session.
- **CSRF**: every POST (nonce, verify, logout) requires `Origin` to equal `APP_URL`.
- **Rate limits** (shared Postgres table): `/api/auth/nonce` 10/min per hashed IP;
  `/api/auth/verify` 10/min per hashed IP and 10/min per wallet.
- **CSP** (`proxy.ts` + `lib/csp.ts`): a fresh nonce per request,
  `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `'unsafe-inline'`; `'unsafe-eval'` in
  dev only), `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`,
  `frame-src https://connect.solflare.com`, fonts and images self-hosted only. `style-src` still
  allows `'unsafe-inline'` (inline `style` attributes can't carry nonces). API routes get
  `default-src 'none'`. Pages render per request, which nonces require.
- **Other headers** (`next.config.ts`): nosniff, strict-origin-when-cross-origin, HSTS,
  X-Frame-Options DENY, Permissions-Policy, no `X-Powered-By`.
- **Secrets hygiene**: `.env*` ignored except `.env.example`; gitleaks pre-commit hook
  (`.githooks/pre-commit`, enabled by `npm install`) and a GitHub Action with every action
  pinned to a full commit SHA (`actions/checkout` v6.1.0, `gitleaks/gitleaks-action` v3.0.0).

## Design tokens

Defined in `app/globals.css` (`@theme`). Brand hexes come from Panta's live CSS
(source noted next to each value): primary green `#23ad4e`, hover `#1d9444`, deep
green `#048620`, lime `#78d02f`, coral `#ff6b7a`, rose `#dd7785`, page `#0b0d0f` and
surface steps. Text colours are ours and meet WCAG AA on every surface used.
Type: Instrument Serif (display), Schibsted Grotesk (UI), JetBrains Mono (numbers, addresses,
labels), all SIL OFL 1.1, self-hosted at build via `next/font` (no font CDN at runtime).
Radii 4/8/12, hairline borders, 4/8 spacing. Glass is limited to the sticky header and the copy card.
No Panta logo is used; "Powered by Panta" is a plain text link in the footer, as the
Panta API Terms require.

## Credits and third-party code

- **Panta API playground** ([Kaito-HQ/panta-api-playground](https://github.com/Kaito-HQ/panta-api-playground)):
  read for request-flow patterns only. It has no license, so **no files or code were copied**;
  everything here was written from the public docs at <https://docs.panta.market>.
- **Panta API docs**: <https://docs.panta.market> (endpoint shapes, errors, rate limits).
- Libraries (all under their own licenses, mostly MIT/Apache-2.0):
  [Next.js](https://nextjs.org) & [React](https://react.dev),
  [Tailwind CSS](https://tailwindcss.com),
  [zod](https://zod.dev),
  [tweetnacl](https://github.com/dchest/tweetnacl-js),
  [bs58](https://github.com/cryptocoinjs/bs58),
  [@solana/web3.js v1](https://github.com/solana-labs/solana-web3.js),
  [@solana/wallet-adapter](https://github.com/anza-xyz/wallet-adapter) (react, base, phantom, solflare),
  [@supabase/supabase-js](https://github.com/supabase/supabase-js),
  [grammY](https://grammy.dev) (Telegram bot),
  [server-only](https://www.npmjs.com/package/server-only),
  [Vitest](https://vitest.dev),
  [PGlite](https://github.com/electric-sql/pglite) (tests),
  [ESLint](https://eslint.org), [TypeScript](https://www.typescriptlang.org),
  [gitleaks](https://github.com/gitleaks/gitleaks) (CI + hook).
- Fonts: Instrument Serif, Schibsted Grotesk, JetBrains Mono (SIL Open Font License 1.1), self-hosted via `next/font`.
- `AGENTS.md` / `CLAUDE.md` are generated by Next.js.

## License

MIT. See [LICENSE](./LICENSE). Copyright (c) 2026 Sammy (SammyCodes1).
