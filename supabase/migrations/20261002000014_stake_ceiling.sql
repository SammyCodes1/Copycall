-- Launch cap (E-10's missing absolute bound). The app enforces MAX_STAKE_USDC
-- (<= 1000, set per deployment) at quote, build, simulation and confirm. The
-- database can't read the env, so it enforces the hard ceiling that any valid
-- MAX_STAKE_USDC is under: no copy order's limit or amount above 1000 USDC.
-- (users.max_stake_usdc gets the same ceiling in 0016.)
--
-- H-06: the constraints are added NOT VALID (enforced for every new or updated
-- row) and validated here only when no existing row violates them, so an old
-- order above 1000 can't make this migration fail. Run the README pre-check
-- first; if it finds rows, resolve them and then run
--   alter table public.pending_orders validate constraint pending_orders_max_usdc_out_ceiling;
--   alter table public.pending_orders validate constraint pending_orders_copy_amount_ceiling;
-- Re-runnable: each constraint is added only if missing.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pending_orders_max_usdc_out_ceiling'
                   and conrelid = 'public.pending_orders'::regclass) then
    alter table public.pending_orders
      add constraint pending_orders_max_usdc_out_ceiling
      check (max_usdc_out is null or max_usdc_out <= 1000) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pending_orders_copy_amount_ceiling'
                   and conrelid = 'public.pending_orders'::regclass) then
    alter table public.pending_orders
      add constraint pending_orders_copy_amount_ceiling
      check (kind <> 'copy' or amount_usdc <= 1000) not valid;
  end if;

  if exists (select 1 from public.pending_orders
              where (max_usdc_out is not null and max_usdc_out > 1000)
                 or (kind = 'copy' and amount_usdc > 1000)) then
    raise warning 'pending_orders has rows above the 1000 USDC ceiling: the ceiling constraints stay NOT VALID until they are resolved (see README)';
  else
    alter table public.pending_orders validate constraint pending_orders_max_usdc_out_ceiling;
    alter table public.pending_orders validate constraint pending_orders_copy_amount_ceiling;
  end if;
end;
$$;
