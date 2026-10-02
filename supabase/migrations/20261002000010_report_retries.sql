-- B3-07: Panta trade reports are retried. The copy/claim is always recorded
-- first (user state never depends on Panta); attribution is then retried by
-- the alerts cron with exponential backoff and a hard attempt cap.
alter table public.copies
  add column reported_at            timestamptz,
  add column report_attempts        integer not null default 0 check (report_attempts >= 0),
  add column report_last_attempt_at timestamptz,
  add column report_error           text check (report_error is null or report_error ~ '^[A-Z_]{1,40}$');
update public.copies set reported_at = created_at where status = 'reported' and reported_at is null;

alter table public.claims
  add column report_attempts        integer not null default 0 check (report_attempts >= 0),
  add column report_last_attempt_at timestamptz,
  add column report_error           text check (report_error is null or report_error ~ '^[A-Z_]{1,40}$');

create index copies_report_retry_idx on public.copies (created_at) where reported_at is null;
create index claims_report_retry_idx on public.claims (created_at) where reported_at is null;

-- Claim up to p_limit unreported rows that are due: fewer than p_max_attempts
-- attempts, younger than p_max_age_sec, and last tried at least
-- p_base_gap_sec * 2^(attempts - 1) ago. Each claimed row's attempt counter is
-- bumped in the same statement (SKIP LOCKED: concurrent crons never share a row).
create or replace function public.claim_report_retries(
  p_limit integer,
  p_max_attempts integer,
  p_base_gap_sec integer,
  p_max_age_sec integer
)
returns table (kind text, order_id uuid, signature text, wallet text, market_id text, quote_id text, attempts integer)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  lim integer := least(greatest(coalesce(p_limit, 0), 0), 100);
begin
  return query
  with due_copies as (
    select c.id from public.copies c
    where c.reported_at is null and c.status = 'confirmed' and c.order_id is not null and c.signature is not null
      and c.report_attempts < p_max_attempts
      and c.created_at > now() - make_interval(secs => p_max_age_sec)
      and (c.report_last_attempt_at is null
           or c.report_last_attempt_at <= now() - make_interval(secs => p_base_gap_sec * power(2, greatest(c.report_attempts - 1, 0))))
    order by c.created_at
    limit lim
    for update skip locked
  ), cu as (
    update public.copies c
       set report_attempts = c.report_attempts + 1, report_last_attempt_at = now()
      from due_copies d, public.pending_orders o
     where c.id = d.id and o.id = c.order_id
    returning 'copy'::text, c.order_id, c.signature, o.wallet, c.market_id, o.quote_id, c.report_attempts
  ), due_claims as (
    select c.id from public.claims c
    where c.reported_at is null
      and c.report_attempts < p_max_attempts
      and c.created_at > now() - make_interval(secs => p_max_age_sec)
      and (c.report_last_attempt_at is null
           or c.report_last_attempt_at <= now() - make_interval(secs => p_base_gap_sec * power(2, greatest(c.report_attempts - 1, 0))))
    order by c.created_at
    limit lim
    for update skip locked
  ), cl as (
    update public.claims c
       set report_attempts = c.report_attempts + 1, report_last_attempt_at = now()
      from due_claims d, public.pending_orders o
     where c.id = d.id and o.id = c.order_id
    returning 'claim'::text, c.order_id, c.signature, o.wallet, c.market_id, o.quote_id, c.report_attempts
  )
  select * from cu union all select * from cl;
end;
$$;

-- A failed report attempt: remember the code; p_stop ends retries (e.g. TX_FEE_MISMATCH).
create or replace function public.record_report_failure(p_order_id uuid, p_code text, p_stop boolean, p_max_attempts integer)
returns void
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  update public.copies
     set report_error = p_code,
         report_attempts = case when p_stop then greatest(report_attempts, p_max_attempts) else greatest(report_attempts, 1) end,
         report_last_attempt_at = now()
   where order_id = p_order_id and reported_at is null;
  update public.claims
     set report_error = p_code,
         report_attempts = case when p_stop then greatest(report_attempts, p_max_attempts) else greatest(report_attempts, 1) end,
         report_last_attempt_at = now()
   where order_id = p_order_id and reported_at is null;
$$;

revoke all on function public.claim_report_retries(integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.record_report_failure(uuid, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.claim_report_retries(integer, integer, integer, integer) to service_role;
grant execute on function public.record_report_failure(uuid, text, boolean, integer) to service_role;
