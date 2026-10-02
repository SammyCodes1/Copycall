-- Fee model detected at quote time (lib/copy-math.ts classifyFeeModel) and the
-- guard limit each pending order was built under. The limit is the user's max
-- stake (fee included, in every model). Confirm re-checks the landed outflow
-- against it. Service-role only, like the rest of the table.
alter table public.pending_orders
  add column fee_model    text check (fee_model in ('inclusive', 'on_top', 'no_fee')),
  add column max_usdc_out numeric(18, 6) check (max_usdc_out >= 0);

-- E-05: backfill rows from before this migration FIRST, so the constraints below
-- never block an UPDATE (complete_order, failOrder) of an in-flight legacy order.
-- Pre-fee-model copy orders were built with limit = stake = amount, inclusive.
update public.pending_orders
   set fee_model = 'inclusive', max_usdc_out = amount_usdc
 where kind = 'copy' and (fee_model is null or max_usdc_out is null);

-- New copy orders must carry both; claims carry max_usdc_out = 0 and no model.
-- NOT VALID only skips the scan; every row satisfies them after the backfill
-- (migration 0012 validates them).
alter table public.pending_orders
  add constraint pending_orders_copy_fee_model
  check (kind <> 'copy' or (fee_model is not null and max_usdc_out is not null)) not valid;
alter table public.pending_orders
  add constraint pending_orders_claim_no_outflow
  check (kind <> 'claim' or max_usdc_out is null or max_usdc_out = 0) not valid;
