-- subscription.sql: Hestrum DocGen Playbook v6.0, Appendix B.
-- Annual-only subscription, single-tenant (exactly one subscription row). PostgreSQL 15+.
-- Assumes Supabase: auth.uid(), roles anon and authenticated, and profiles(user_id uuid, role text, active boolean).
-- Access mode is DERIVED from dates using the database clock. No cron job flips a status.

-- 1. Frozen commercial configuration (values come from Playbook section 1; change only by migration) ---------
create table commercial_config (
  id boolean primary key default true check (id),
  trial_days int not null check (trial_days between 0 and 90),
  grace_days int not null check (grace_days between 0 and 60),
  reminder_days int[] not null,
  price_notice_days int not null check (price_notice_days between 0 and 365),
  updated_at timestamptz not null default now()
);

-- 2. Effective-dated annual price (insert-only; a price change applies to the next renewal) -------------------
create table plan_prices (
  effective_from timestamptz primary key,
  annual_fee_kobo bigint not null check (annual_fee_kobo > 0),
  created_at timestamptz not null default now()
);

-- 3. The subscription: stored facts only. Status shown to the Owner is derived by app_access(). ----------------
create table subscription (
  id boolean primary key default true check (id),
  plan text not null default 'trial' check (plan in ('trial', 'annual')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  paused_at timestamptz,
  pause_reason text check (pause_reason in ('NON_PAYMENT', 'ABUSE', 'SECURITY_INCIDENT')),
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((plan = 'trial' and trial_ends_at is not null) or (plan = 'annual' and current_period_end is not null)),
  check ((paused_at is null) = (pause_reason is null))
);

-- 4. Insert-only records ------------------------------------------------------------------------------------
create table subscription_payments (
  id bigint generated always as identity primary key,
  payment_ref text not null unique,
  amount_kobo bigint not null check (amount_kobo > 0),
  price_snapshot_kobo bigint not null check (price_snapshot_kobo > 0),
  period_start timestamptz not null,
  period_end timestamptz not null,
  recorded_by uuid not null,
  note text,
  created_at timestamptz not null default now()
);

create table platform_admins (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);

create table maintenance_log (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null,
  reason text not null,
  ticket text not null,
  before jsonb,
  after jsonb,
  prev_hash text not null,
  row_hash text not null,
  created_at timestamptz not null default now()
);

create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'INSERT_ONLY_TABLE %', tg_table_name using errcode = 'P0001';
end $$;

create trigger maintenance_log_insert_only before update or delete on maintenance_log
  for each row execute function forbid_change();
create trigger maintenance_log_no_truncate before truncate on maintenance_log
  for each statement execute function forbid_change();
create trigger subscription_payments_insert_only before update or delete on subscription_payments
  for each row execute function forbid_change();
create trigger plan_prices_insert_only before update or delete on plan_prices
  for each row execute function forbid_change();

-- Hash chain: each log row's hash covers the previous row's hash, so an edit or deletion breaks every later row.
create function maintenance_log_chain() returns trigger language plpgsql as $$
declare prev text;
begin
  perform pg_advisory_xact_lock(7001);
  select row_hash into prev from maintenance_log order by id desc limit 1;
  new.prev_hash := coalesce(prev, repeat('0', 64));
  new.row_hash := encode(sha256(convert_to(
    new.prev_hash || '|' || new.actor::text || '|' || new.action || '|' || new.reason || '|' || new.ticket || '|' ||
    coalesce(new.before::text, '') || '|' || coalesce(new.after::text, '') || '|' || new.created_at::text,
    'UTF8')), 'hex');
  return new;
end $$;

create trigger maintenance_log_chain_row before insert on maintenance_log
  for each row execute function maintenance_log_chain();

-- Returns true when the stored chain is intact. Email the latest row_hash to the Owner weekly (anchor).
create function verify_maintenance_chain() returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record; prev text := repeat('0', 64); expected text;
begin
  for r in select * from maintenance_log order by id loop
    expected := encode(sha256(convert_to(
      prev || '|' || r.actor::text || '|' || r.action || '|' || r.reason || '|' || r.ticket || '|' ||
      coalesce(r.before::text, '') || '|' || coalesce(r.after::text, '') || '|' || r.created_at::text,
      'UTF8')), 'hex');
    if r.prev_hash <> prev or r.row_hash <> expected then return false; end if;
    prev := r.row_hash;
  end loop;
  return true;
end $$;

-- 5. Derived access mode ------------------------------------------------------------------------------------
-- mode: full | read_only | blocked. Missing row or config fails closed.
create function app_access(p_now timestamptz default now())
returns table (mode text, reason text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s subscription%rowtype; c commercial_config%rowtype; ends timestamptz; grace_end timestamptz;
begin
  select * into s from subscription;
  if s.id is null then return query select 'blocked'::text, 'NO_SUBSCRIPTION'::text; return; end if;
  select * into c from commercial_config;
  if c.id is null then return query select 'blocked'::text, 'NO_CONFIG'::text; return; end if;
  ends := case s.plan when 'trial' then s.trial_ends_at else s.current_period_end end;
  grace_end := ends + make_interval(days => c.grace_days);
  if s.paused_at is not null then
    return query select 'blocked'::text, 'PAUSED'::text;
  elsif p_now <= ends then
    return query select 'full'::text, (case s.plan when 'trial' then 'TRIAL' else 'ACTIVE' end)::text;
  elsif p_now <= grace_end then
    return query select 'read_only'::text, 'GRACE'::text;
  else
    return query select 'blocked'::text, 'EXPIRED'::text;
  end if;
end $$;

create function is_full_access() returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce((select a.mode = 'full' from app_access() a), false) $$;

-- Call first in every mutating RPC. Reading, downloading and exporting never call it.
create function require_full_access() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m text; r text;
begin
  select a.mode, a.reason into m, r from app_access() a;
  if m is distinct from 'full' then
    raise exception 'ACCESS_%', coalesce(r, 'UNKNOWN') using errcode = 'P0001';
  end if;
end $$;

-- Pattern for every business table: direct writes also need full access, so the API is not the only gate.
--   create policy documents_insert on documents for insert to authenticated
--     with check (is_full_access() and <ownership and role checks>);

-- 6. Price lookup ----------------------------------------------------------------------------------------------
create function current_annual_fee_kobo(p_at timestamptz default now()) returns bigint
language sql stable security definer set search_path = public, pg_temp as
$$ select annual_fee_kobo from plan_prices where effective_from <= p_at order by effective_from desc limit 1 $$;

-- 7. Developer-only functions. Every one needs a platform admin, a reason and a ticket, and writes the log. ------
create function require_platform_admin(p_reason text, p_ticket text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not exists (select 1 from platform_admins where user_id = auth.uid()) then
    raise exception 'NOT_PLATFORM_ADMIN' using errcode = '42501';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_ticket, '')) = '' then raise exception 'TICKET_REQUIRED' using errcode = 'P0001'; end if;
end $$;

create function log_maintenance(p_action text, p_reason text, p_ticket text, p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = public, pg_temp as
$$ insert into maintenance_log(actor, action, reason, ticket, before, after)
   values (auth.uid(), p_action, p_reason, p_ticket, p_before, p_after) $$;

-- Initialise once at go-live. included_months = playbook parameter C4 (0 means trial only).
create function start_subscription(p_included_months int, p_reason text, p_ticket text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c commercial_config%rowtype;
begin
  perform require_platform_admin(p_reason, p_ticket);
  if exists (select 1 from subscription) then raise exception 'SUBSCRIPTION_EXISTS' using errcode = 'P0001'; end if;
  select * into c from commercial_config;
  if c.id is null then raise exception 'NO_CONFIG' using errcode = 'P0001'; end if;
  if p_included_months is null or p_included_months < 0 or p_included_months > 36 then
    raise exception 'INCLUDED_MONTHS_RANGE' using errcode = 'P0001';
  end if;
  if p_included_months = 0 then
    insert into subscription(plan, trial_ends_at) values ('trial', now() + make_interval(days => c.trial_days));
  else
    insert into subscription(plan, current_period_end)
      values ('annual', now() + make_interval(days => c.trial_days) + make_interval(months => p_included_months));
  end if;
  perform log_maintenance('START_SUBSCRIPTION', p_reason, p_ticket, null, (select to_jsonb(x) from subscription x));
end $$;

-- One annual renewal. Idempotent on payment_ref. Time already paid is never lost; a lapsed plan restarts today.
create function renew_subscription(p_payment_ref text, p_amount_kobo bigint, p_reason text, p_ticket text)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare s subscription%rowtype; prior subscription_payments%rowtype; v_price bigint; v_start timestamptz; v_end timestamptz;
begin
  perform require_platform_admin(p_reason, p_ticket);
  if btrim(coalesce(p_payment_ref, '')) = '' then raise exception 'PAYMENT_REF_REQUIRED' using errcode = 'P0001'; end if;
  select * into s from subscription for update;
  if s.id is null then raise exception 'NO_SUBSCRIPTION' using errcode = 'P0001'; end if;
  select * into prior from subscription_payments where payment_ref = p_payment_ref;
  if prior.id is not null then return prior.period_end; end if;
  v_price := current_annual_fee_kobo();
  if v_price is null then raise exception 'NO_PRICE' using errcode = 'P0001'; end if;
  if p_amount_kobo is null or p_amount_kobo < v_price then raise exception 'AMOUNT_BELOW_PRICE' using errcode = 'P0001'; end if;
  v_start := case when s.plan = 'annual' then greatest(s.current_period_end, now())
                  else greatest(s.trial_ends_at, now()) end;
  v_end := v_start + interval '12 months';
  update subscription set
    plan = 'annual', current_period_end = v_end, cancel_at_period_end = false,
    paused_at = case when pause_reason = 'NON_PAYMENT' then null else paused_at end,
    pause_reason = case when pause_reason = 'NON_PAYMENT' then null else pause_reason end,
    updated_at = now();
  insert into subscription_payments(payment_ref, amount_kobo, price_snapshot_kobo, period_start, period_end, recorded_by, note)
    values (p_payment_ref, p_amount_kobo, v_price, v_start, v_end, auth.uid(), p_reason);
  perform log_maintenance('RENEW_SUBSCRIPTION', p_reason, p_ticket, to_jsonb(s), (select to_jsonb(x) from subscription x));
  return v_end;
end $$;

-- Pause for a contractual reason only. Export and the Renew/Paused page keep working. Renewal lifts NON_PAYMENT only.
create function pause_access(p_code text, p_reason text, p_ticket text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s subscription%rowtype;
begin
  perform require_platform_admin(p_reason, p_ticket);
  if p_code not in ('NON_PAYMENT', 'ABUSE', 'SECURITY_INCIDENT') then raise exception 'PAUSE_CODE_INVALID' using errcode = 'P0001'; end if;
  select * into s from subscription for update;
  if s.id is null then raise exception 'NO_SUBSCRIPTION' using errcode = 'P0001'; end if;
  update subscription set paused_at = now(), pause_reason = p_code, updated_at = now();
  perform log_maintenance('PAUSE_ACCESS', p_reason, p_ticket, to_jsonb(s), (select to_jsonb(x) from subscription x));
end $$;

create function unpause_access(p_reason text, p_ticket text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s subscription%rowtype;
begin
  perform require_platform_admin(p_reason, p_ticket);
  select * into s from subscription for update;
  if s.id is null then raise exception 'NO_SUBSCRIPTION' using errcode = 'P0001'; end if;
  update subscription set paused_at = null, pause_reason = null, updated_at = now();
  perform log_maintenance('UNPAUSE_ACCESS', p_reason, p_ticket, to_jsonb(s), (select to_jsonb(x) from subscription x));
end $$;

create function cancel_at_period_end(p_reason text, p_ticket text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s subscription%rowtype;
begin
  perform require_platform_admin(p_reason, p_ticket);
  select * into s from subscription for update;
  if s.id is null then raise exception 'NO_SUBSCRIPTION' using errcode = 'P0001'; end if;
  update subscription set cancel_at_period_end = true, updated_at = now();
  perform log_maintenance('CANCEL_AT_PERIOD_END', p_reason, p_ticket, to_jsonb(s), (select to_jsonb(x) from subscription x));
end $$;

-- A new price must take effect after the contractual notice period (C8). No function exists to shorten a paid period.
create function set_annual_price(p_effective_from timestamptz, p_fee_kobo bigint, p_reason text, p_ticket text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c commercial_config%rowtype;
begin
  perform require_platform_admin(p_reason, p_ticket);
  select * into c from commercial_config;
  if c.id is null then raise exception 'NO_CONFIG' using errcode = 'P0001'; end if;
  if p_effective_from < now() + make_interval(days => c.price_notice_days) then
    raise exception 'PRICE_NOTICE_TOO_SHORT' using errcode = 'P0001';
  end if;
  insert into plan_prices(effective_from, annual_fee_kobo) values (p_effective_from, p_fee_kobo);
  perform log_maintenance('SET_ANNUAL_PRICE', p_reason, p_ticket, null,
    jsonb_build_object('effective_from', p_effective_from, 'annual_fee_kobo', p_fee_kobo));
end $$;

-- 8. Owner-facing read model: no actor, generic label ----------------------------------------------------------
create view maintenance_summary as
  select m.created_at, 'Platform maintenance'::text as label, m.action, m.reason, m.ticket
  from maintenance_log m
  where exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'owner' and p.active)
  order by m.created_at desc;

-- 9. Privileges and row-level security --------------------------------------------------------------------------
alter table commercial_config enable row level security;
alter table plan_prices enable row level security;
alter table subscription enable row level security;
alter table subscription_payments enable row level security;
alter table platform_admins enable row level security;
alter table maintenance_log enable row level security;

revoke all on commercial_config, plan_prices, subscription, subscription_payments, platform_admins, maintenance_log
  from public, anon, authenticated;

grant select on subscription, subscription_payments, plan_prices, maintenance_summary to authenticated;

create policy subscription_owner_read on subscription for select to authenticated
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'owner' and p.active));
create policy subscription_payments_owner_read on subscription_payments for select to authenticated
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'owner' and p.active));
create policy plan_prices_owner_read on plan_prices for select to authenticated
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'owner' and p.active));

revoke execute on function
  require_platform_admin(text, text), log_maintenance(text, text, text, jsonb, jsonb),
  start_subscription(int, text, text), renew_subscription(text, bigint, text, text),
  pause_access(text, text, text), unpause_access(text, text), cancel_at_period_end(text, text),
  set_annual_price(timestamptz, bigint, text, text), verify_maintenance_chain()
  from public, anon;
grant execute on function
  start_subscription(int, text, text), renew_subscription(text, bigint, text, text),
  pause_access(text, text, text), unpause_access(text, text), cancel_at_period_end(text, text),
  set_annual_price(timestamptz, bigint, text, text), verify_maintenance_chain()
  to authenticated;
grant execute on function app_access(timestamptz), is_full_access(), require_full_access() to authenticated;
