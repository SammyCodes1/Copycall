-- Batch 2, step 8: Telegram linking and copy alerts. Service-role only (addendum B).

-- One Telegram chat belongs to at most one Copycall user.
create unique index users_telegram_chat_id_key on public.users (telegram_chat_id) where telegram_chat_id is not null;
create index telegram_link_codes_user_idx on public.telegram_link_codes (user_id);
create index alerts_status_idx on public.alerts (status) where status = 'pending';

-- /start <code>: consume a one-time link code and attach the chat to its user,
-- atomically. telegram_link_codes.code holds sha256(code) in hex, never the
-- code itself. Expired codes are deleted too. Any other user previously linked
-- to this chat is unlinked. Returns the user id, or NULL if the code is
-- unknown, used or expired.
create or replace function public.link_telegram_chat(p_code_hash text, p_chat_id bigint)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user    uuid;
  v_expires timestamptz;
begin
  delete from public.telegram_link_codes
   where code = p_code_hash
  returning user_id, expires_at into v_user, v_expires;
  if v_user is null or v_expires <= now() then
    return null;
  end if;
  update public.users set telegram_chat_id = null where telegram_chat_id = p_chat_id and id <> v_user;
  update public.users set telegram_chat_id = p_chat_id, alerts_enabled = true where id = v_user;
  return v_user;
end;
$$;

-- Everyone the alerts job should notify: follows of users with alerts on.
create or replace function public.alert_subscriptions()
returns table (user_id uuid, leader_wallet text, followed_at timestamptz, telegram_chat_id bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select f.user_id, f.leader_wallet, f.created_at, u.telegram_chat_id
    from public.follows f
    join public.users u on u.id = f.user_id
   where u.alerts_enabled;
$$;

revoke all on function public.link_telegram_chat(text, bigint) from public, anon, authenticated;
revoke all on function public.alert_subscriptions() from public, anon, authenticated;
grant execute on function public.link_telegram_chat(text, bigint) to service_role;
grant execute on function public.alert_subscriptions() to service_role;
