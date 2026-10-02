-- E-05: a database that ran the first version of 0008 (constraints added NOT
-- VALID without a backfill) can't UPDATE copy orders created before it: the
-- copy-fee-model check fires on complete_order and failOrder. Backfill them
-- (idempotent; a no-op where 0008 already did) and validate the constraints.
update public.pending_orders
   set fee_model = 'inclusive', max_usdc_out = amount_usdc
 where kind = 'copy' and (fee_model is null or max_usdc_out is null);

alter table public.pending_orders validate constraint pending_orders_copy_fee_model;
alter table public.pending_orders validate constraint pending_orders_claim_no_outflow;

-- E-10: max_usdc_out is the guard's cap (the stake). A copy's recorded amount
-- (the simulated debit) never exceeds it.
-- G-08: guarded so the whole file can be re-run safely (the UPDATE and VALIDATEs already are).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pending_orders_copy_within_cap' and conrelid = 'public.pending_orders'::regclass
  ) then
    alter table public.pending_orders
      add constraint pending_orders_copy_within_cap
      check (kind <> 'copy' or max_usdc_out is null or amount_usdc <= max_usdc_out);
  end if;
end;
$$;
