-- Batch 3, steps 9 and 10: copy and claim flows.
-- Everything here is service-role only (addendum B): RLS on, forced, no
-- anon/authenticated policies and no API-role privileges.

-- ---------------------------------------------------------------- api_cache
-- Short-lived server caches shared across instances: 10-second quote cache
-- (addendum H), quote tokens handed to the review screen, 30-second positions.
create table public.api_cache (
  key        text primary key check (length(key) <= 200),
  value      jsonb not null,
  expires_at timestamptz not null
);
create index api_cache_expiry_idx on public.api_cache (expires_at);

-- ---------------------------------------------------------------- pending_orders
-- The exact transaction message we built, validated and simulated for a user.
-- Confirm routes (addendum C) only accept a landed transaction whose message
-- hashes to message_hash, for the same user, while status = 'pending'.
create table public.pending_orders (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.users (id) on delete cascade,
  wallet                  text not null,
  kind                    text not null check (kind in ('copy', 'claim')),
  leader_trade_id         uuid references public.trades (id),
  market_id               text not null,
  side                    text not null check (side in ('YES', 'NO')),
  amount_usdc             numeric(18, 6) not null check (amount_usdc > 0),
  fee_usdc                numeric(18, 6) not null default 0 check (fee_usdc >= 0),
  shares                  numeric(24, 6) not null check (shares >= 0),
  quote_id                text,
  panta_order_id          text,
  message_hash            text not null check (message_hash ~ '^[0-9a-f]{64}$'),
  message_base64          text not null check (length(message_base64) <= 2000),
  last_valid_block_height bigint,
  created_at              timestamptz not null default now(),
  expires_at              timestamptz not null,
  status                  text not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
  signature               text unique,
  check ((kind = 'copy') = (leader_trade_id is not null))
);
create index pending_orders_user_idx on public.pending_orders (user_id, created_at desc);

-- ---------------------------------------------------------------- copies
alter table public.copies
  add column order_id uuid unique references public.pending_orders (id),
  add column shares   numeric(24, 6),
  add column fee_usdc numeric(18, 6);

-- ---------------------------------------------------------------- claims
create table public.claims (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  order_id    uuid not null unique references public.pending_orders (id),
  market_id   text not null,
  side        text not null check (side in ('YES', 'NO')),
  shares      numeric(24, 6) not null,
  signature   text not null unique, -- addendum C: a signature can be recorded once
  reported_at timestamptz,
  created_at  timestamptz not null default now()
);
create index claims_user_idx on public.claims (user_id, created_at desc);

alter table public.api_cache      enable row level security;
alter table public.pending_orders enable row level security;
alter table public.claims         enable row level security;
alter table public.api_cache      force row level security;
alter table public.pending_orders force row level security;
alter table public.claims         force row level security;
revoke all on table public.api_cache, public.pending_orders, public.claims from anon, authenticated;

-- ---------------------------------------------------------------- complete_order
-- Confirm step, atomically: lock the pending order, refuse a signature that is
-- already recorded anywhere, mark the order confirmed and insert the copies /
-- claims row. UNIQUE constraints back this up under concurrency.
create or replace function public.complete_order(p_order_id uuid, p_user_id uuid, p_signature text)
returns text
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  o public.pending_orders%rowtype;
begin
  select * into o from public.pending_orders where id = p_order_id and user_id = p_user_id for update;
  if not found then
    return 'not_pending';
  end if;
  if o.status = 'confirmed' then
    return case when o.signature = p_signature then 'already_confirmed' else 'not_pending' end;
  end if;
  if o.status <> 'pending' then
    return 'not_pending';
  end if;
  if exists (select 1 from public.pending_orders where signature = p_signature)
     or exists (select 1 from public.copies where signature = p_signature)
     or exists (select 1 from public.claims where signature = p_signature) then
    return 'signature_used';
  end if;

  update public.pending_orders set status = 'confirmed', signature = p_signature where id = o.id;
  if o.kind = 'copy' then
    insert into public.copies (user_id, leader_trade_id, market_id, side, amount_usdc, signature, status, order_id, shares, fee_usdc)
    values (o.user_id, o.leader_trade_id, o.market_id, o.side, o.amount_usdc, p_signature, 'confirmed', o.id, o.shares, o.fee_usdc);
  else
    insert into public.claims (user_id, order_id, market_id, side, shares, signature)
    values (o.user_id, o.id, o.market_id, o.side, o.shares, p_signature);
  end if;
  return 'ok';
exception
  when unique_violation then
    return 'signature_used';
end;
$$;

revoke all on function public.complete_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_order(uuid, uuid, text) to service_role;
