-- D-04: copies record the simulated USDC debit exactly (6 dp), like
-- pending_orders.amount_usdc and copies.fee_usdc. Widening keeps old values.
alter table public.copies alter column amount_usdc type numeric(18, 6);
