-- Atomic helpers used by lib/auth-store (batch 1). Callable by service_role only.

-- Consume a sign-in nonce exactly once (addendum F).
-- DELETE ... RETURNING is atomic: two concurrent verifies of the same nonce
-- cannot both get a row back. The nonce is bound to the wallet it was issued
-- for, so a nonce can only be consumed together with that wallet.
-- Returns the expiry (the caller rejects if it is in the past), or NULL if the
-- nonce does not exist / belongs to another wallet / was already used.
create or replace function public.consume_auth_nonce(p_nonce text, p_wallet text)
returns timestamptz
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  delete from public.auth_nonces
   where nonce = p_nonce
     and wallet = p_wallet
  returning expires_at;
$$;

-- Fixed-window rate limiter (addendum H). Increments the counter for the
-- current window and returns true if the request is allowed.
create or replace function public.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count  integer;
begin
  insert into public.rate_limits as r (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set count = r.count + 1
  returning r.count into v_count;

  -- Opportunistic cleanup of old windows and expired nonces (~1% of calls).
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
    delete from public.auth_nonces where expires_at < now() - interval '1 hour';
  end if;

  return v_count <= p_limit;
end;
$$;

-- Functions in the public schema are exposed over PostgREST RPC and are
-- executable by PUBLIC by default. Lock them to the service role.
revoke all on function public.consume_auth_nonce(text, text) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_auth_nonce(text, text) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
