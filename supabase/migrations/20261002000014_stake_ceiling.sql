-- Launch cap (E-10's missing absolute bound). The app enforces MAX_STAKE_USDC
-- (<= 1000, set per deployment) at quote, build, simulation and confirm. The
-- database can't read the env, so it enforces the hard ceiling that any valid
-- MAX_STAKE_USDC is under: no copy order's limit or amount above 1000 USDC.
-- user_settings.max_stake_usdc is already limited to 1..1000 by the API schema.
alter table public.pending_orders
  add constraint pending_orders_max_usdc_out_ceiling
  check (max_usdc_out is null or max_usdc_out <= 1000);
alter table public.pending_orders
  add constraint pending_orders_copy_amount_ceiling
  check (kind <> 'copy' or amount_usdc <= 1000);
