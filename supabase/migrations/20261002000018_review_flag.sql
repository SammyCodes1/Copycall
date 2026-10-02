-- H4-01 / L-02: a landed transaction that failed a confirm check AFTER it moved funds (it
-- changed control of the user's USDC account, reached an unexpected program, touched the
-- wallet's System state, or moved more / paid less than the order allowed) is recorded, never
-- failed, and flagged here for a human to review. The app writes the flag BEFORE completing the
-- order, so a flagged landing is never recorded unflagged. Codes only (comma-separated), no
-- free text. The service role writes it; anon/authenticated have no privilege on
-- pending_orders (RLS, no policies). Re-runnable. Apply before deploying the app that selects it.
alter table public.pending_orders add column if not exists review_flag text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pending_orders_review_flag_format'
                   and conrelid = 'public.pending_orders'::regclass) then
    alter table public.pending_orders
      add constraint pending_orders_review_flag_format
      check (review_flag is null or review_flag ~ '^[A-Z][A-Z0-9_]{0,39}(,[A-Z][A-Z0-9_]{0,39}){0,9}$');
  end if;
end;
$$;

create index if not exists pending_orders_review_flag_idx on public.pending_orders (created_at)
  where review_flag is not null;
