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
| `npm test` | Vitest: auth, boot guard, Panta schemas/client, stats, SQL migrations (in-process Postgres via PGlite) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:bundle` | After a build, scans `.next/static` for secret names, `pk_` prefixes and secret values |
| `node scripts/gen-fixtures.mjs` | Regenerates the deterministic mock fixtures |

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
| `PANTA_PROGRAM_IDS`, `TELEGRAM_*`, `CRON_SECRET` | Used from batch 2 |

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
  [server-only](https://www.npmjs.com/package/server-only),
  [Vitest](https://vitest.dev),
  [PGlite](https://github.com/electric-sql/pglite) (tests),
  [ESLint](https://eslint.org), [TypeScript](https://www.typescriptlang.org),
  [gitleaks](https://github.com/gitleaks/gitleaks) (CI + hook).
- Fonts: Instrument Serif, Schibsted Grotesk, JetBrains Mono (SIL Open Font License 1.1), self-hosted via `next/font`.
- `AGENTS.md` / `CLAUDE.md` are generated by Next.js.

## License

MIT. See [LICENSE](./LICENSE). Copyright (c) 2026 Sammy (SammyCodes1).
