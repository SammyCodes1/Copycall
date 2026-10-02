-- Fee model detected at quote time (lib/copy-math.ts classifyFeeModel) and the
-- guard limit each pending order was built under. The limit is the expected USDC
-- outflow, fee included, and never above the user's max stake. Confirm re-checks
-- the landed outflow against it. Service-role only, like the rest of the table.
alter table public.pending_orders
  add column fee_model    text check (fee_model in ('inclusive', 'on_top', 'no_fee')),
  add column max_usdc_out numeric(18, 6) check (max_usdc_out >= 0);

-- New copy orders must carry both; claims carry max_usdc_out = 0 and no model.
-- NOT VALID: rows from before this migration (short-lived) are not re-checked.
alter table public.pending_orders
  add constraint pending_orders_copy_fee_model
  check (kind <> 'copy' or (fee_model is not null and max_usdc_out is not null)) not valid;
alter table public.pending_orders
  add constraint pending_orders_claim_no_outflow
  check (kind <> 'claim' or max_usdc_out is null or max_usdc_out = 0) not valid;
