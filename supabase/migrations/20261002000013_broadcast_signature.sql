-- E-02: the signature we broadcast is stored BEFORE sending, so a landed copy
-- whose confirm response was lost (or hit VERIFY_UNAVAILABLE) can still be
-- verified and recorded later, by the client or by the cron sweep. It is not
-- unique and is not the recorded signature (`signature` is set on confirm).
alter table public.pending_orders
  add column broadcast_signature text check (broadcast_signature is null or broadcast_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$');
create index pending_orders_broadcast_idx on public.pending_orders (created_at)
  where status = 'pending' and broadcast_signature is not null;
