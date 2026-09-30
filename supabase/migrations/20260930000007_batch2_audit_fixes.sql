-- Batch 2 audit fixes (B2-01, B2-03, B2-04, B2-07, B2-11/12). Service-role only (addendum B).

-- ------------------------------------------------------------ B2-01 Telegram linking
-- Set when another Copycall account takes over this user's Telegram chat, so
-- settings can say "Telegram unlinked". Cleared when the user links again.
alter table public.users add column telegram_unlinked_at timestamptz;

-- /start <code>: look a code up WITHOUT consuming it, so the bot can show the
-- wallet it would link and ask for confirmation first.
create or replace function public.peek_link_code(p_code_hash text)
returns table (user_id uuid, wallet text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select c.user_id, u.wallet
    from public.telegram_link_codes c
    join public.users u on u.id = c.user_id
   where c.code = p_code_hash and c.expires_at > now();
$$;

-- Wallet currently linked to a chat (to warn before moving it).
create or replace function public.linked_wallet_for_chat(p_chat_id bigint)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select wallet from public.users where telegram_chat_id = p_chat_id;
$$;

-- Confirmed link: consume the code (single use), move the chat, and return who
-- was affected so the bot can tell them. Also purges all expired codes (B2-12).
drop function public.link_telegram_chat(text, bigint);
create function public.link_telegram_chat(p_code_hash text, p_chat_id bigint)
returns table (user_id uuid, wallet text, previous_user_id uuid, previous_wallet text, previous_chat_id bigint)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user      uuid;
  v_expires   timestamptz;
  v_wallet    text;
  v_old_chat  bigint;
  v_prev_user uuid;
  v_prev_wal  text;
begin
  delete from public.telegram_link_codes where expires_at <= now() and code <> p_code_hash;
  delete from public.telegram_link_codes
   where code = p_code_hash
  returning telegram_link_codes.user_id, expires_at into v_user, v_expires;
  if v_user is null or v_expires <= now() then
    return;
  end if;
  select u.wallet, u.telegram_chat_id into v_wallet, v_old_chat from public.users u where u.id = v_user for update;
  select u.id, u.wallet into v_prev_user, v_prev_wal
    from public.users u where u.telegram_chat_id = p_chat_id and u.id <> v_user for update;
  if v_prev_user is not null then
    update public.users set telegram_chat_id = null, telegram_unlinked_at = now() where id = v_prev_user;
  end if;
  update public.users
     set telegram_chat_id = p_chat_id, alerts_enabled = true, telegram_unlinked_at = null
   where id = v_user;
  user_id := v_user;
  wallet := v_wallet;
  previous_user_id := v_prev_user;
  previous_wallet := v_prev_wal;
  previous_chat_id := case when v_old_chat is distinct from p_chat_id then v_old_chat end;
  return next;
end;
$$;

-- ------------------------------------------------------------ B2-03 follow cap
-- Check-and-insert in one transaction under a row lock on the user, so
-- concurrent requests cannot exceed the cap. Returns 'followed', 'already' or 'limit'.
create or replace function public.follow_capped(p_user_id uuid, p_wallet text, p_max integer)
returns text
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then
    raise exception 'unknown user';
  end if;
  if exists (select 1 from public.follows where user_id = p_user_id and leader_wallet = p_wallet) then
    return 'already';
  end if;
  select count(*) into v_n from public.follows where user_id = p_user_id;
  if v_n >= p_max then
    return 'limit';
  end if;
  insert into public.follows (user_id, leader_wallet) values (p_user_id, p_wallet);
  return 'followed';
end;
$$;

-- ------------------------------------------------------------ B2-04 sync backoff
-- One row per market tape / wallet that failed with a non-429 error. The item
-- is skipped until next_attempt_at (exponential, 10 min .. 24 h); success clears it.
create table public.sync_failures (
  kind            text not null check (kind in ('tape', 'wallet')),
  key             text not null,
  error_count     integer not null default 0,
  next_attempt_at timestamptz not null,
  last_error_at   timestamptz not null default now(),
  primary key (kind, key)
);
alter table public.sync_failures enable row level security;
alter table public.sync_failures force row level security;
revoke all on table public.sync_failures from anon, authenticated;

create or replace function public.record_sync_failure(p_kind text, p_key text, p_now timestamptz)
returns void
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  insert into public.sync_failures (kind, key, error_count, next_attempt_at, last_error_at)
  values (p_kind, p_key, 1, p_now + interval '10 minutes', p_now)
  on conflict (kind, key) do update
     set error_count = public.sync_failures.error_count + 1,
         next_attempt_at = p_now + least(interval '10 minutes' * power(2, public.sync_failures.error_count), interval '24 hours'),
         last_error_at = p_now;
$$;

-- Markets whose tape is due: not final, not backing off, least recently synced first.
create or replace function public.markets_needing_trades(p_limit integer, p_now timestamptz)
returns table (id text, status text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select m.id, m.status
    from public.markets m
   where not m.trades_final
     and not exists (select 1 from public.sync_failures f
                      where f.kind = 'tape' and f.key = m.id and f.next_attempt_at > p_now)
   order by m.trades_synced_at asc nulls first, m.id
   limit greatest(p_limit, 0);
$$;

-- Tracked wallets, stalest stats first, skipping wallets that are backing off.
drop function public.wallets_to_refresh(integer);
create function public.wallets_to_refresh(p_limit integer, p_now timestamptz)
returns setof text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select w.wallet
    from (select distinct wallet from public.trades) w
    left join public.trader_stats s on s.wallet = w.wallet
   where not exists (select 1 from public.sync_failures f
                      where f.kind = 'wallet' and f.key = w.wallet and f.next_attempt_at > p_now)
   order by s.updated_at asc nulls first, w.wallet
   limit greatest(p_limit, 0);
$$;

-- ------------------------------------------------------------ B2-07 rank in SQL
-- Same order as the leaderboard: hit_rate desc, resolved_calls desc, wallet asc.
-- NULL when the wallet has no stats or too few resolved calls.
create or replace function public.trader_rank(p_wallet text, p_min_resolved integer)
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select (select count(*)::integer + 1
            from public.trader_stats o
           where o.resolved_calls >= p_min_resolved
             and (o.hit_rate > s.hit_rate
                  or (o.hit_rate = s.hit_rate and o.resolved_calls > s.resolved_calls)
                  or (o.hit_rate = s.hit_rate and o.resolved_calls = s.resolved_calls and o.wallet < s.wallet)))
    from public.trader_stats s
   where s.wallet = p_wallet and s.resolved_calls >= p_min_resolved;
$$;

-- ------------------------------------------------------------ B2-11 alert retries
alter table public.alerts
  add column created_at      timestamptz not null default now(),
  add column attempts        integer not null default 0,
  add column last_attempt_at timestamptz;

-- Claim failed or stale-pending alerts for another send attempt. Bounded:
-- at most p_max_attempts sends, only alerts younger than p_max_age_sec, and a
-- p_min_gap_sec gap between attempts (so overlapping runs don't double-send).
create or replace function public.claim_alert_retries(p_limit integer, p_max_attempts integer, p_max_age_sec integer, p_min_gap_sec integer)
returns table (id uuid, user_id uuid, trade_id uuid)
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  update public.alerts a
     set status = 'pending', last_attempt_at = now()
   where a.id in (
     select x.id from public.alerts x
      where x.status in ('failed', 'pending')
        and x.attempts < p_max_attempts
        and x.created_at > now() - make_interval(secs => p_max_age_sec)
        and coalesce(x.last_attempt_at, x.created_at) < now() - make_interval(secs => p_min_gap_sec)
      order by x.created_at
      limit greatest(p_limit, 0)
      for update skip locked)
  returning a.id, a.user_id, a.trade_id;
$$;

-- Status update that counts send attempts.
create or replace function public.set_alert_status(p_id uuid, p_status text, p_sent_at timestamptz)
returns void
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  update public.alerts
     set status = p_status,
         sent_at = p_sent_at,
         attempts = attempts + case when p_status in ('sent', 'failed') then 1 else 0 end,
         last_attempt_at = case when p_status in ('sent', 'failed') then now() else last_attempt_at end
   where id = p_id;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.peek_link_code(text)', 'public.linked_wallet_for_chat(bigint)', 'public.link_telegram_chat(text, bigint)',
    'public.follow_capped(uuid, text, integer)', 'public.record_sync_failure(text, text, timestamptz)',
    'public.markets_needing_trades(integer, timestamptz)', 'public.wallets_to_refresh(integer, timestamptz)', 'public.trader_rank(text, integer)',
    'public.claim_alert_retries(integer, integer, integer, integer)', 'public.set_alert_status(uuid, text, timestamptz)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
