-- B3-06: confirm race. A tx that lands just as we read "expired" can now be
-- re-verified on chain by signature: complete_order may confirm a failed
-- order, but only when the caller asks (p_allow_failed) after re-running every
-- landed-transaction check. Still one atomic statement under a row lock, and
-- still backed by UNIQUE (pending_orders.signature, copies.signature,
-- copies.order_id, claims.order_id, claims.signature).
drop function public.complete_order(uuid, uuid, text);

create function public.complete_order(
  p_order_id uuid,
  p_user_id uuid,
  p_signature text,
  p_allow_failed boolean default false
)
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
  if o.status = 'failed' and not coalesce(p_allow_failed, false) then
    return 'not_pending';
  end if;
  if o.status not in ('pending', 'failed') then
    return 'not_pending';
  end if;
  -- One recorded row per order, whatever its status says.
  if exists (select 1 from public.copies where order_id = o.id)
     or exists (select 1 from public.claims where order_id = o.id) then
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

revoke all on function public.complete_order(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.complete_order(uuid, uuid, text, boolean) to service_role;
