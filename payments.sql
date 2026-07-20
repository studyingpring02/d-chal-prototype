-- D-CHAL Plus payments and subscriptions
-- Run after coupon-subscriptions.sql in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.dchal_payment_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  customer_key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.dchal_billing_methods (
  user_id uuid primary key references auth.users(id) on delete cascade,
  customer_key text not null unique,
  encrypted_billing_key text not null,
  billing_key_iv text not null,
  card_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dchal_payment_orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('monthly', 'annual')),
  amount integer not null check (amount > 0),
  status text not null default 'READY'
    check (status in ('READY', 'CONFIRMING', 'DONE', 'FAILED', 'CANCELED')),
  payment_key text unique,
  receipt_url text,
  error_code text,
  error_message text,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create index if not exists dchal_payment_orders_user_created_idx
on public.dchal_payment_orders (user_id, created_at desc);

create table if not exists public.dchal_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null check (plan in ('monthly', 'annual')),
  status text not null default 'active'
    check (status in ('active', 'past_due', 'canceled')),
  amount integer not null check (amount > 0),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  next_billing_at timestamptz,
  cancel_at_period_end boolean not null default false,
  billing_claimed_at timestamptz,
  last_payment_key text,
  last_billing_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dchal_payment_customers enable row level security;
alter table public.dchal_billing_methods enable row level security;
alter table public.dchal_payment_orders enable row level security;
alter table public.dchal_subscriptions enable row level security;

drop policy if exists "Users read their own payment orders" on public.dchal_payment_orders;
create policy "Users read their own payment orders"
on public.dchal_payment_orders
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users read their own subscription" on public.dchal_subscriptions;
create policy "Users read their own subscription"
on public.dchal_subscriptions
for select
to authenticated
using (auth.uid() = user_id);

revoke all on table public.dchal_payment_customers from public, anon, authenticated;
revoke all on table public.dchal_billing_methods from public, anon, authenticated;
revoke all on table public.dchal_payment_orders from public, anon, authenticated;
revoke all on table public.dchal_subscriptions from public, anon, authenticated;

grant select (
  id, order_id, user_id, plan, amount, status,
  receipt_url, error_code, error_message, created_at, approved_at
) on public.dchal_payment_orders to authenticated;

grant select (
  user_id, plan, status, amount, current_period_start, current_period_end,
  next_billing_at, cancel_at_period_end, last_billing_error,
  created_at, updated_at
) on public.dchal_subscriptions to authenticated;

-- Called only by Edge Functions with the service-role key. It atomically records
-- a completed payment and extends the paid subscription period.
create or replace function public.finalize_dchal_payment(
  p_user_id uuid,
  p_order_id text,
  p_payment_key text,
  p_plan text,
  p_amount integer,
  p_receipt_url text default null,
  p_provider_payload jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.dchal_payment_orders%rowtype;
  v_existing_end timestamptz;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_expected_amount integer;
begin
  v_expected_amount := case p_plan
    when 'monthly' then 5900
    when 'annual' then 49000
    else null
  end;

  if v_expected_amount is null or p_amount <> v_expected_amount then
    raise exception 'INVALID_PLAN_OR_AMOUNT';
  end if;

  select *
  into v_order
  from public.dchal_payment_orders
  where order_id = p_order_id
    and user_id = p_user_id
  for update;

  if not found then
    raise exception 'PAYMENT_ORDER_NOT_FOUND';
  end if;

  if v_order.plan <> p_plan or v_order.amount <> p_amount then
    raise exception 'PAYMENT_ORDER_MISMATCH';
  end if;

  if v_order.status = 'DONE' then
    return jsonb_build_object(
      'ok', true,
      'already_finalized', true,
      'benefit_ends_at', (
        select current_period_end
        from public.dchal_subscriptions
        where user_id = p_user_id
      )
    );
  end if;

  select current_period_end
  into v_existing_end
  from public.dchal_subscriptions
  where user_id = p_user_id
  for update;

  v_period_start := greatest(now(), coalesce(v_existing_end, now()));
  v_period_end := case p_plan
    when 'monthly' then v_period_start + interval '1 month'
    else v_period_start + interval '1 year'
  end;

  update public.dchal_payment_orders
  set status = 'DONE',
      payment_key = p_payment_key,
      receipt_url = p_receipt_url,
      provider_payload = p_provider_payload,
      error_code = null,
      error_message = null,
      approved_at = now()
  where id = v_order.id;

  insert into public.dchal_subscriptions (
    user_id,
    plan,
    status,
    amount,
    current_period_start,
    current_period_end,
    next_billing_at,
    cancel_at_period_end,
    billing_claimed_at,
    last_payment_key,
    last_billing_error,
    updated_at
  )
  values (
    p_user_id,
    p_plan,
    'active',
    p_amount,
    v_period_start,
    v_period_end,
    case when p_plan = 'monthly' then v_period_end else null end,
    false,
    null,
    p_payment_key,
    null,
    now()
  )
  on conflict (user_id) do update
  set plan = excluded.plan,
      status = 'active',
      amount = excluded.amount,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      next_billing_at = excluded.next_billing_at,
      cancel_at_period_end = false,
      billing_claimed_at = null,
      last_payment_key = excluded.last_payment_key,
      last_billing_error = null,
      updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'plan', p_plan,
    'benefit_ends_at', v_period_end,
    'next_billing_at', case when p_plan = 'monthly' then v_period_end else null end
  );
end;
$$;

revoke all on function public.finalize_dchal_payment(uuid, text, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_dchal_payment(uuid, text, text, text, integer, text, jsonb) to service_role;

-- Atomically claims subscriptions that are due. A stale claim can be retried
-- after 20 minutes if a scheduler run is interrupted.
create or replace function public.claim_due_dchal_subscriptions(p_limit integer default 20)
returns setof public.dchal_subscriptions
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select user_id
    from public.dchal_subscriptions
    where plan = 'monthly'
      and status in ('active', 'past_due')
      and cancel_at_period_end = false
      and next_billing_at is not null
      and next_billing_at <= now()
      and (billing_claimed_at is null or billing_claimed_at < now() - interval '20 minutes')
    order by next_billing_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  )
  update public.dchal_subscriptions as subscription
  set billing_claimed_at = now(),
      updated_at = now()
  from due
  where subscription.user_id = due.user_id
  returning subscription.*;
end;
$$;

revoke all on function public.claim_due_dchal_subscriptions(integer) from public, anon, authenticated;
grant execute on function public.claim_due_dchal_subscriptions(integer) to service_role;

-- Paid subscriptions and launch coupons both grant Plus access.
create or replace function public.get_my_dchal_plus_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_paid public.dchal_subscriptions%rowtype;
  v_coupon public.coupon_redemptions%rowtype;
begin
  if v_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'active', false,
      'reason', 'authentication_required'
    );
  end if;

  select *
  into v_paid
  from public.dchal_subscriptions
  where user_id = v_user_id
    and status = 'active'
    and current_period_end > now()
  limit 1;

  select *
  into v_coupon
  from public.coupon_redemptions
  where user_id = v_user_id
    and benefit_ends_at > now()
  order by benefit_ends_at desc
  limit 1;

  if v_paid.user_id is not null
    and (v_coupon.user_id is null or v_paid.current_period_end >= v_coupon.benefit_ends_at)
  then
    return jsonb_build_object(
      'ok', true,
      'active', true,
      'source', 'paid',
      'plan', v_paid.plan,
      'benefit_ends_at', v_paid.current_period_end,
      'next_billing_at', v_paid.next_billing_at,
      'cancel_at_period_end', v_paid.cancel_at_period_end,
      'paid_plan', v_paid.plan,
      'paid_benefit_ends_at', v_paid.current_period_end,
      'paid_next_billing_at', v_paid.next_billing_at,
      'paid_cancel_at_period_end', v_paid.cancel_at_period_end
    );
  end if;

  if v_coupon.user_id is not null then
    return jsonb_build_object(
      'ok', true,
      'active', true,
      'source', 'coupon',
      'coupon_code', v_coupon.coupon_code,
      'benefit_ends_at', v_coupon.benefit_ends_at,
      'paid_plan', v_paid.plan,
      'paid_benefit_ends_at', v_paid.current_period_end,
      'paid_next_billing_at', v_paid.next_billing_at,
      'paid_cancel_at_period_end', v_paid.cancel_at_period_end
    );
  end if;

  return jsonb_build_object('ok', true, 'active', false);
end;
$$;

revoke all on function public.get_my_dchal_plus_status() from public;
grant execute on function public.get_my_dchal_plus_status() to authenticated;
