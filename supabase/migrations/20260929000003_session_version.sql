-- Server-side session revocation (security audit follow-up to batch 1).
-- Session cookies are stateless HMAC tokens that carry the user's
-- session_version at sign-in (`sv`). Every request re-checks it against this
-- column, so bumping it (on logout) revokes all outstanding tokens for the
-- user, including copies of a stolen cookie.

alter table public.users
  add column session_version integer not null default 1 check (session_version >= 1);

-- Atomically increment and return the new version. NULL if the user is gone.
create or replace function public.bump_session_version(p_user_id uuid)
returns integer
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  update public.users
     set session_version = session_version + 1
   where id = p_user_id
  returning session_version;
$$;

revoke all on function public.bump_session_version(uuid) from public, anon, authenticated;
grant execute on function public.bump_session_version(uuid) to service_role;
