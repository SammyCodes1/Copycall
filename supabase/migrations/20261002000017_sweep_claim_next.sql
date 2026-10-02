-- I-02: the sweep claims ONE order at a time, only while its time budget lasts, so an order the
-- run can't reach is never claimed (no lost attempt, no lost turn). Same rules as
-- claim_broadcast_sweep (0015), limit 1, minus the orders this run already handled (p_exclude).
-- 0015's function is kept unchanged for app instances that still call it. Re-runnable.
create or replace function public.claim_broadcast_sweep_next(
  p_created_before timestamptz,
  p_created_after timestamptz,
  p_max_attempts integer,
  p_exclude uuid[]
)
returns table (order_id uuid, attempts integer)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select o.id from public.pending_orders o
     where o.status = 'pending' and o.broadcast_signature is not null
       and o.created_at < p_created_before and o.created_at > p_created_after
       and o.sweep_attempts < coalesce(p_max_attempts, 0)
       and not (o.id = any (coalesce(p_exclude, '{}'::uuid[])))
     order by o.last_swept_at asc nulls first, o.created_at asc
     limit 1
     for update skip locked
  )
  update public.pending_orders o
     set sweep_attempts = o.sweep_attempts + 1, last_swept_at = now()
    from due
   where o.id = due.id
  returning o.id, o.sweep_attempts;
end;
$$;

revoke all on function public.claim_broadcast_sweep_next(timestamptz, timestamptz, integer, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_broadcast_sweep_next(timestamptz, timestamptz, integer, uuid[]) to service_role;
