-- G-02 / G-03: the broadcast sweep can't be starved and re-sends are bounded.
--  sweep_attempts / last_swept_at: the sweep claims the least recently checked
--    orders first (never-checked first), bumps the counter in the same statement
--    (SKIP LOCKED: concurrent crons never share a row), and gives up after a cap.
--  send_attempts: how many times we broadcast the same signed bytes (bounded).
alter table public.pending_orders
  add column if not exists sweep_attempts integer not null default 0 check (sweep_attempts >= 0),
  add column if not exists last_swept_at  timestamptz,
  add column if not exists send_attempts  integer not null default 0 check (send_attempts >= 0);

drop index if exists public.pending_orders_broadcast_idx;
create index if not exists pending_orders_sweep_idx on public.pending_orders (last_swept_at nulls first, created_at)
  where status = 'pending' and broadcast_signature is not null;

create or replace function public.claim_broadcast_sweep(
  p_limit integer,
  p_created_before timestamptz,
  p_created_after timestamptz,
  p_max_attempts integer
)
returns table (order_id uuid, attempts integer)
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
  with due as (
    select o.id from public.pending_orders o
     where o.status = 'pending' and o.broadcast_signature is not null
       and o.created_at < p_created_before and o.created_at > p_created_after
       and o.sweep_attempts < coalesce(p_max_attempts, 0)
     order by o.last_swept_at asc nulls first, o.created_at asc
     limit lim
     for update skip locked
  )
  update public.pending_orders o
     set sweep_attempts = o.sweep_attempts + 1, last_swept_at = now()
    from due
   where o.id = due.id
  returning o.id, o.sweep_attempts;
end;
$$;

-- One more broadcast of the same signed bytes, if the order is still pending and under the cap.
create or replace function public.note_send_attempt(p_order_id uuid, p_max integer)
returns boolean
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  with u as (
    update public.pending_orders
       set send_attempts = send_attempts + 1
     where id = p_order_id and status = 'pending' and send_attempts < coalesce(p_max, 0)
    returning 1
  )
  select exists (select 1 from u);
$$;

revoke all on function public.claim_broadcast_sweep(integer, timestamptz, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.note_send_attempt(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_broadcast_sweep(integer, timestamptz, timestamptz, integer) to service_role;
grant execute on function public.note_send_attempt(uuid, integer) to service_role;
