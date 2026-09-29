-- Batch 2, step 5: leaderboard sync bookkeeping.
-- All new objects are service-role only (addendum B): no anon/authenticated
-- policies, no API-role privileges. Only markets, trades and trader_stats keep
-- their public SELECT policy from 0001.

-- ---------------------------------------------------------------- markets
alter table public.markets
  -- when we last pulled this market's trade tape (/markets/{id}/trades/)
  add column trades_synced_at   timestamptz,
  -- true once the tape was pulled after the market resolved or was cancelled:
  -- no new trades can appear, so it is never pulled again
  add column trades_final       boolean not null default false,
  -- when getMarketCreator() last ran for this market (success or not found)
  add column creator_checked_at timestamptz;
create index markets_trades_sync_idx on public.markets (trades_final, trades_synced_at nulls first);

-- ---------------------------------------------------------------- trades
alter table public.trades
  -- Panta `isPrimary`. Only primary-phase rows are treated as buys for alerts.
  add column is_primary boolean not null default true,
  -- Panta catalog trade id (string | number in the docs), kept for reference
  add column panta_id   text;

-- ---------------------------------------------------------------- trader_stats
alter table public.trader_stats
  -- last resolved calls, oldest -> newest, as W/L letters (max 12) for the streak ticks
  add column recent_results text not null default '' check (recent_results ~ '^[WL]{0,12}$');

-- ---------------------------------------------------------------- positions
-- Latest GET /positions/?wallet= snapshot per tracked wallet, so pages never
-- call Panta on a page load (hard requirement 9). Private (no policies).
create table public.positions (
  wallet     text not null,
  market_id  text not null,
  side       text not null check (side in ('YES', 'NO')),
  shares     numeric(24, 6) not null check (shares >= 0),
  phase      text not null check (phase in ('primary', 'secondary', 'resolved', 'cancelled')),
  outcome    text check (outcome in ('yes', 'no')),
  claimable  boolean not null default false,
  claimed    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (wallet, market_id, side)
);
alter table public.positions enable row level security;
alter table public.positions force row level security;
revoke all on table public.positions from anon, authenticated;

-- Atomically replace one wallet's positions snapshot.
-- p_rows: [{ "market_id", "side" ("YES"|"NO"), "shares", "phase", "outcome", "claimable", "claimed" }]
create or replace function public.replace_positions(p_wallet text, p_rows jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
begin
  delete from public.positions where wallet = p_wallet;
  insert into public.positions (wallet, market_id, side, shares, phase, outcome, claimable, claimed)
  select p_wallet, r.market_id, r.side, r.shares, r.phase, r.outcome, coalesce(r.claimable, false), coalesce(r.claimed, false)
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      as r(market_id text, side text, shares numeric, phase text, outcome text, claimable boolean, claimed boolean);
end;
$$;

-- Tracked wallets (anyone seen in a stored trade), stalest stats first.
create or replace function public.wallets_to_refresh(p_limit integer)
returns setof text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select w.wallet
    from (select distinct wallet from public.trades) w
    left join public.trader_stats s on s.wallet = w.wallet
   order by s.updated_at asc nulls first, w.wallet
   limit greatest(p_limit, 0);
$$;

revoke all on function public.replace_positions(text, jsonb) from public, anon, authenticated;
revoke all on function public.wallets_to_refresh(integer) from public, anon, authenticated;
grant execute on function public.replace_positions(text, jsonb) to service_role;
grant execute on function public.wallets_to_refresh(integer) to service_role;
