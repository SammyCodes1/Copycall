-- H-06: users.max_stake_usdc had no DB ceiling (only the API schema's 1..1000).
-- A saved stake above 1000 could never be used (the launch cap is <= 1000), so
-- it is clamped to 1000 first, then the ceiling is added and validated. Clamping
-- (not NOT VALID) matters here: a NOT VALID check would make every later UPDATE
-- of such a user row fail, including session_version bumps at sign-in.
-- Defence in depth: anon/authenticated have no privilege on this column.
-- Re-runnable.
update public.users set max_stake_usdc = 1000 where max_stake_usdc > 1000;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_max_stake_usdc_ceiling'
                   and conrelid = 'public.users'::regclass) then
    alter table public.users
      add constraint users_max_stake_usdc_ceiling check (max_stake_usdc <= 1000);
  end if;
end;
$$;
