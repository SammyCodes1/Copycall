-- Copycall initial schema (batch 1).
-- Security addendum B: RLS is enabled on EVERY table. Only markets, trades and
-- trader_stats get a public SELECT policy. users, follows, alerts, copies,
-- auth_nonces, telegram_link_codes and rate_limits have NO anon/authenticated
-- policies at all: all access goes through our server routes using the
-- service-role key after a session check. Writes to every table are
-- service-role only (service_role bypasses RLS).


-- ---------------------------------------------------------------- users
create table public.users (
  id               uuid primary key default gen_random_uuid(),
  wallet           text not null unique,
  telegram_chat_id bigint,
  max_stake_usdc   numeric(12, 2) not null default 5 check (max_stake_usdc > 0),
  slippage_bps     integer not null default 200 check (slippage_bps >= 0 and slippage_bps <= 500),
  alerts_enabled   boolean not null default true,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- markets
-- id = Panta marketId, which is also the on-chain event/market address.
create table public.markets (
  id               text primary key,
  address          text not null,
  title            text not null,
  status           text not null,           -- Panta `phase`: primary|secondary|resolved|cancelled
  outcome          text check (outcome in ('yes', 'no')), -- from resolved positions (market rows have no outcome field)
  creator_wallet   text,                     -- resolved on-chain via getMarketCreator(), cached
  creator_verified boolean not null default false,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- trades
create table public.trades (
  id               uuid primary key default gen_random_uuid(),
  signature        text not null unique,     -- dedupe key for the capped (200-row) tape
  market_id        text not null references public.markets (id) on delete cascade,
  wallet           text not null,
  side             text not null check (side in ('YES', 'NO')),
  shares           numeric(24, 6) not null check (shares >= 0),
  fee              numeric(24, 6) not null default 0 check (fee >= 0),
  block_time       timestamptz,              -- Panta blockTime can be null
  is_creator_trade boolean not null default false
);
create index trades_wallet_time_idx on public.trades (wallet, block_time desc);
create index trades_market_idx on public.trades (market_id);

-- ---------------------------------------------------------------- trader_stats
create table public.trader_stats (
  wallet              text primary key,
  resolved_calls      integer not null default 0 check (resolved_calls >= 0),
  correct_calls       integer not null default 0 check (correct_calls >= 0),
  hit_rate            numeric(6, 5) not null default 0 check (hit_rate >= 0 and hit_rate <= 1),
  open_positions      integer not null default 0 check (open_positions >= 0),
  last_active         timestamptz,
  creator_trade_count integer not null default 0 check (creator_trade_count >= 0),
  updated_at          timestamptz not null default now(),
  check (correct_calls <= resolved_calls)
);
create index trader_stats_rank_idx on public.trader_stats (hit_rate desc, resolved_calls desc);

-- ---------------------------------------------------------------- follows
create table public.follows (
  user_id       uuid not null references public.users (id) on delete cascade,
  leader_wallet text not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, leader_wallet)
);
create index follows_leader_idx on public.follows (leader_wallet);

-- ---------------------------------------------------------------- alerts
create table public.alerts (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references public.users (id) on delete cascade,
  trade_id uuid not null references public.trades (id) on delete cascade,
  sent_at  timestamptz,
  status   text not null default 'pending' check (status in ('pending', 'sent', 'logged', 'failed', 'skipped')),
  unique (user_id, trade_id)                  -- one alert per follower per leader trade
);

-- ---------------------------------------------------------------- copies
create table public.copies (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  leader_trade_id uuid not null references public.trades (id),
  market_id       text not null references public.markets (id),
  side            text not null check (side in ('YES', 'NO')),
  amount_usdc     numeric(12, 2) not null check (amount_usdc > 0),
  signature       text unique,                -- addendum C: a signature can be recorded once
  status          text not null default 'built' check (status in ('built', 'submitted', 'confirmed', 'reported', 'failed')),
  created_at      timestamptz not null default now()
);
create index copies_user_idx on public.copies (user_id, created_at desc);

-- ---------------------------------------------------------------- auth_nonces
create table public.auth_nonces (
  nonce      text primary key,
  wallet     text not null,
  expires_at timestamptz not null
);
create index auth_nonces_expiry_idx on public.auth_nonces (expires_at);

-- ---------------------------------------------------------------- telegram_link_codes
create table public.telegram_link_codes (
  code       text primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  expires_at timestamptz not null
);

-- ---------------------------------------------------------------- rate_limits (addendum H)
-- Shared fixed-window counters for our own routes. bucket is e.g.
-- 'nonce:ip:<sha256(ip)>' so raw IPs are never stored.
create table public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);

-- ---------------------------------------------------------------- RLS
alter table public.users               enable row level security;
alter table public.markets             enable row level security;
alter table public.trades              enable row level security;
alter table public.trader_stats        enable row level security;
alter table public.follows             enable row level security;
alter table public.alerts              enable row level security;
alter table public.copies              enable row level security;
alter table public.auth_nonces         enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.rate_limits         enable row level security;

-- Belt and braces: also force RLS for the table owner role.
alter table public.users               force row level security;
alter table public.follows             force row level security;
alter table public.alerts              force row level security;
alter table public.copies              force row level security;
alter table public.auth_nonces         force row level security;
alter table public.telegram_link_codes force row level security;
alter table public.rate_limits         force row level security;

-- Public, read-only leaderboard data.
create policy "public read markets"      on public.markets      for select to anon, authenticated using (true);
create policy "public read trades"       on public.trades       for select to anon, authenticated using (true);
create policy "public read trader_stats" on public.trader_stats for select to anon, authenticated using (true);

-- Private tables: no policies, and no table privileges for the API roles either.
revoke all on table public.users, public.follows, public.alerts, public.copies,
  public.auth_nonces, public.telegram_link_codes, public.rate_limits
  from anon, authenticated;
-- Public tables: read only for API roles.
revoke insert, update, delete, truncate, references, trigger
  on table public.markets, public.trades, public.trader_stats
  from anon, authenticated;
