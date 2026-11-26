-- 0006_payments_receipts.sql: Hestrum DocGen Playbook v6.0, sections 7.2 and 8.4 (payments, allocation, WHT, receipts, short-pay, reversal).
-- Run after 0000 to 0005. Credit notes (G10) extend invoice_credited_kobo() in a later migration.
--
-- Rules this file enforces in the database:
--   * a payment is recorded as pending_verification (never settles anything), then CONFIRMED by an authorised person;
--   * confirmation allocates the payment to invoices; cash parts sum EXACTLY to the payment amount; each allocation
--     (cash + WHT) is within the invoice's open balance; invoices must be issued and not void; overpayment is impossible;
--   * the receipt is created already issued, in the same transaction, from the same number sequence and hash chain;
--   * invoice balance is DERIVED: total - credit notes - confirmed allocations (cash + WHT) - short-pay adjustments;
--   * reversal is Owner-only with a reason, writes a compensating record, never edits the original amounts;
--   * every money table is insert-only except the three guarded payment status fields.

-- 1. Settings and document type additions -------------------------------------------------------------------------
alter table business_settings
  add column prefix_receipt text not null default 'RCP' check (prefix_receipt ~ '^[A-Z]{2,6}$'),
  add column short_pay_cap_kobo bigint not null default 0 check (short_pay_cap_kobo >= 0),
  add column receipt_stamp_always_paid boolean not null default false;
alter table business_settings add constraint business_settings_receipt_prefix_distinct
  check (prefix_receipt <> prefix_quotation and prefix_receipt <> prefix_invoice);

alter table documents drop constraint documents_doc_type_check;
alter table documents add constraint documents_doc_type_check check (doc_type in ('quotation', 'invoice', 'receipt'));

create or replace function next_document_number(p_type text, p_year int) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint; v_prefix text;
begin
  select case p_type when 'quotation' then prefix_quotation when 'invoice' then prefix_invoice when 'receipt' then prefix_receipt end
    into v_prefix from business_settings;
  if v_prefix is null then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;
  insert into document_counters (doc_type, year, last_value) values (p_type, p_year, 1)
    on conflict (doc_type, year) do update set last_value = document_counters.last_value + 1
    returning last_value into v;
  return v_prefix || '-' || p_year::text || '-' || case when v < 10000 then lpad(v::text, 4, '0') else v::text end;
end $$;

-- 2. Tables ----------------------------------------------------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id),
  amount_kobo bigint not null check (amount_kobo > 0 and amount_kobo <= 1000000000000),   -- cash received, whole kobo
  method text not null check (method in ('transfer', 'cash', 'pos', 'cheque')),
  paid_on date not null,
  reference text check (reference is null or btrim(reference) <> ''),
  evidence_path text check (evidence_path is null or btrim(evidence_path) <> ''),          -- private storage path
  idempotency_key text not null check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 100),
  status text not null default 'pending_verification' check (status in ('pending_verification', 'confirmed', 'reversed')),
  recorded_by uuid not null references profiles (user_id),
  recorded_at timestamptz not null default now(),
  confirmed_by uuid references profiles (user_id),
  confirmed_at timestamptz,
  verification_note text,
  unique (recorded_by, idempotency_key),
  check ((status = 'pending_verification') = (confirmed_at is null)),
  check ((confirmed_at is null) = (confirmed_by is null)),
  check (confirmed_at is null or btrim(coalesce(verification_note, '')) <> '')
);
-- The same bank reference can never be recorded twice while its payment is live (duplicate proof).
create unique index payments_live_reference_uq on payments (method, lower(btrim(reference)))
  where reference is not null and status <> 'reversed';
create index payments_customer_idx on payments (customer_id);

alter table documents add column payment_id uuid unique references payments (id);

create table payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments (id),
  invoice_id uuid not null references documents (id),
  cash_kobo bigint not null check (cash_kobo >= 0),
  wht_kobo bigint not null default 0 check (wht_kobo >= 0),
  check (cash_kobo + wht_kobo > 0),
  unique (payment_id, invoice_id)
);
create index payment_allocations_invoice_idx on payment_allocations (invoice_id);

-- WHT credit note received from the customer. An allocation with WHT and no row here is "credit note pending".
create table wht_credit_notes (
  allocation_id uuid primary key references payment_allocations (id),
  reference text not null check (btrim(reference) <> ''),
  received_on date not null,
  recorded_by uuid not null references profiles (user_id),
  recorded_at timestamptz not null default now()
);

create table payment_reversals (
  payment_id uuid primary key references payments (id),
  reason text not null check (btrim(reason) <> ''),
  reversed_by uuid not null references profiles (user_id),
  reversed_at timestamptz not null default now()
);

-- Short-pay adjustment: closes a small remaining balance. Never counted as cash received.
create table payment_adjustments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references documents (id),
  amount_kobo bigint not null check (amount_kobo > 0),
  reason text not null check (btrim(reason) <> ''),
  cap_kobo bigint not null,                       -- the Owner's cap in force when it was made
  created_by uuid not null references profiles (user_id),
  created_at timestamptz not null default now()
);
create index payment_adjustments_invoice_idx on payment_adjustments (invoice_id);

-- 3. Immutability -------------------------------------------------------------------------------------------------------
-- payments: amounts, customer, method, date, reference, evidence and key are frozen. Only the status steps
-- pending_verification -> confirmed -> reversed may happen, and the confirmation fields are set once.
create function payments_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'INSERT_ONLY_TABLE payments' using errcode = 'P0001'; end if;
  if (to_jsonb(new) - 'status' - 'confirmed_by' - 'confirmed_at' - 'verification_note')
     is distinct from (to_jsonb(old) - 'status' - 'confirmed_by' - 'confirmed_at' - 'verification_note') then
    raise exception 'PAYMENT_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pending_verification' and new.status = 'confirmed')
         or (old.status = 'confirmed' and new.status = 'reversed')) then
      raise exception 'STATUS_TRANSITION_INVALID' using errcode = 'P0001';
    end if;
    if old.status = 'confirmed'
       and (new.confirmed_by, new.confirmed_at, new.verification_note) is distinct from (old.confirmed_by, old.confirmed_at, old.verification_note) then
      raise exception 'PAYMENT_IMMUTABLE' using errcode = 'P0001';
    end if;
  elsif (new.confirmed_by, new.confirmed_at, new.verification_note) is distinct from (old.confirmed_by, old.confirmed_at, old.verification_note) then
    raise exception 'PAYMENT_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger payments_guard_row before update or delete on payments for each row execute function payments_guard();
create trigger payments_no_truncate before truncate on payments for each statement execute function forbid_change();

create trigger payment_allocations_insert_only before update or delete on payment_allocations for each row execute function forbid_change();
create trigger payment_allocations_no_truncate before truncate on payment_allocations for each statement execute function forbid_change();
create trigger wht_credit_notes_insert_only before update or delete on wht_credit_notes for each row execute function forbid_change();
create trigger wht_credit_notes_no_truncate before truncate on wht_credit_notes for each statement execute function forbid_change();
create trigger payment_reversals_insert_only before update or delete on payment_reversals for each row execute function forbid_change();
create trigger payment_reversals_no_truncate before truncate on payment_reversals for each statement execute function forbid_change();
create trigger payment_adjustments_insert_only before update or delete on payment_adjustments for each row execute function forbid_change();
create trigger payment_adjustments_no_truncate before truncate on payment_adjustments for each statement execute function forbid_change();

-- 4. Derived balance (playbook 7.2: invoice balance = total - credit notes - confirmed non-reversed allocations - adjustments)
-- Credit notes arrive in a later migration, which replaces this function.
create function invoice_credited_kobo(p_id uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$ select 0::bigint $$;

create function invoice_settled_kobo(p_id uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(a.cash_kobo + a.wht_kobo), 0)::bigint
  from payment_allocations a join payments p on p.id = a.payment_id
  where a.invoice_id = p_id and p.status = 'confirmed'
$$;

create function invoice_adjusted_kobo(p_id uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(x.amount_kobo), 0)::bigint from payment_adjustments x where x.invoice_id = p_id
$$;

-- NULL when the id is not an issued invoice.
create function invoice_balance(p_id uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select d.total_kobo - invoice_credited_kobo(d.id) - invoice_settled_kobo(d.id) - invoice_adjusted_kobo(d.id)
  from documents d where d.id = p_id and d.doc_type = 'invoice' and d.snapshot is not null
$$;

-- Derived state with an explicit "today" so tests can pin the clock. Strings for money, as everywhere else.
create function invoice_state_at(p_id uuid, p_today date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d documents%rowtype; v_settled bigint; v_adj bigint; v_cred bigint; v_bal bigint; v_wht bigint; v_pending bigint; v_state text;
begin
  select * into d from documents where id = p_id and doc_type = 'invoice' and snapshot is not null;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  v_settled := invoice_settled_kobo(d.id); v_adj := invoice_adjusted_kobo(d.id); v_cred := invoice_credited_kobo(d.id);
  v_bal := d.total_kobo - v_cred - v_settled - v_adj;
  select coalesce(sum(a.wht_kobo), 0)::bigint,
         coalesce(sum(a.wht_kobo) filter (where not exists (select 1 from wht_credit_notes w where w.allocation_id = a.id)), 0)::bigint
    into v_wht, v_pending
  from payment_allocations a join payments p on p.id = a.payment_id
  where a.invoice_id = d.id and p.status = 'confirmed';
  v_state := case when d.status = 'void' then 'void' when v_bal = 0 then 'paid' when v_settled > 0 then 'partially_paid' else 'unpaid' end;
  return jsonb_build_object('invoice_id', d.id, 'number', d.number, 'document_status', d.status, 'state', v_state,
    'overdue', (d.status = 'issued' and v_bal > 0 and d.due_date is not null and p_today > d.due_date),
    'total', d.total_kobo::text, 'credited', v_cred::text, 'settled', v_settled::text, 'wht', v_wht::text,
    'wht_credit_note_pending', v_pending::text, 'adjusted', v_adj::text, 'balance', v_bal::text);
end $$;

create function invoice_payment_status(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d documents%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  select * into d from documents where id = p_id and doc_type = 'invoice' and snapshot is not null;
  if not found then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if not (is_owner() or d.created_by = auth.uid() or has_capability('draft.view_all') or has_capability('reports.view')
          or has_capability('payments.record_evidence') or has_capability('payments.confirm')) then
    raise exception 'CAPABILITY_DENIED payments.view' using errcode = '42501';
  end if;
  return invoice_state_at(p_id, (now() at time zone 'Africa/Lagos')::date);
end $$;

-- 5. Hash-chain stamp shared by every document type that is created already issued (receipts now, credit notes later).
create function chain_stamp(p_snapshot jsonb) returns table (o_prev text, o_hash text, o_seq bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(7002);
  select x.snapshot_hash into v_prev from documents x where x.chain_seq is not null order by x.chain_seq desc limit 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  return query select v_prev, encode(sha256(convert_to(v_prev || '|' || p_snapshot::text, 'UTF8')), 'hex'), nextval('document_chain_seq');
end $$;

-- 6. Record evidence: a pending payment. It settles nothing. A repeated key returns the original payment. ------------
create function record_payment(
  p_key text, p_customer_id uuid, p_amount_kobo text, p_method text, p_paid_on date,
  p_reference text default null, p_evidence_path text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text; v_amt numeric; v_ref text; v_ev text; ex payments%rowtype; v_id uuid;
begin
  perform require_full_access();
  perform require_capability('payments.record_evidence');
  v_key := btrim(coalesce(p_key, ''));
  if v_key = '' or length(v_key) > 100 then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'P0001'; end if;
  v_amt := money_parse(p_amount_kobo);
  if v_amt is null or v_amt <= 0 or v_amt > money_max_doc_kobo() then raise exception 'AMOUNT_INVALID' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('transfer', 'cash', 'pos', 'cheque') then raise exception 'METHOD_INVALID' using errcode = 'P0001'; end if;
  if p_paid_on is null then raise exception 'PAID_ON_REQUIRED' using errcode = 'P0001'; end if;
  if p_paid_on > (now() at time zone 'Africa/Lagos')::date then raise exception 'PAID_ON_FUTURE' using errcode = 'P0001'; end if;
  v_ref := nullif(btrim(coalesce(p_reference, '')), '');
  v_ev := nullif(btrim(coalesce(p_evidence_path, '')), '');
  if p_customer_id is null or not exists (select 1 from customers where id = p_customer_id) then
    raise exception 'CUSTOMER_MISSING' using errcode = 'P0001';
  end if;

  select * into ex from payments where recorded_by = auth.uid() and idempotency_key = v_key;
  if found then
    if ex.customer_id = p_customer_id and ex.amount_kobo = v_amt::bigint and ex.method = p_method
       and ex.paid_on = p_paid_on and ex.reference is not distinct from v_ref then
      return ex.id;
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
  end if;
  if v_ref is not null and exists (select 1 from payments x where x.method = p_method and lower(btrim(x.reference)) = lower(v_ref) and x.status <> 'reversed') then
    raise exception 'PAYMENT_REFERENCE_DUPLICATE' using errcode = 'P0001';
  end if;

  insert into payments (customer_id, amount_kobo, method, paid_on, reference, evidence_path, idempotency_key, recorded_by)
  values (p_customer_id, v_amt::bigint, p_method, p_paid_on, v_ref, v_ev, v_key, auth.uid())
  returning id into v_id;
  perform write_audit('RECORD_PAYMENT', v_id::text, null,
    jsonb_build_object('amount_kobo', v_amt::bigint::text, 'method', p_method, 'customer_id', p_customer_id, 'reference', v_ref));
  return v_id;
end $$;

-- 7. Confirm: allocate, settle, and issue the receipt, all in ONE transaction. ---------------------------------------
-- p_allocations: [{"invoice_id": uuid, "cash_kobo": "30000000", "wht_kobo": "0"}]. Money as strings of whole kobo.
-- Internal: authority and locking live here (the four-eyes rule depends on the locked invoices); p_now pins the clock in tests.
create function confirm_core(p_payment_id uuid, p_allocations jsonb, p_note text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  pay payments%rowtype; s business_settings%rowtype; c customers%rowtype; inv documents%rowtype; r record; e jsonb;
  n int; i int; v_cash numeric; v_wht numeric; v_sum numeric := 0; v_bal bigint; v_earlier bigint; v_after bigint;
  v_applied jsonb := '[]'::jsonb; v_all_paid boolean := true; v_wht_total bigint := 0; v_stamp text;
  v_year int; v_issue date; v_number text; v_snap jsonb; v_prev text; v_hash text; v_seq bigint; v_name text; v_receipt uuid;
  v_alloc_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  select * into pay from payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001'; end if;

  -- Capability, cap on the payment amount, fresh MFA, and never a payment one recorded oneself (non-Owner).
  perform require_capability('payments.confirm', pay.amount_kobo, pay.recorded_by);

  if pay.status = 'confirmed' then                         -- retry of a confirmed payment: the original result
    select id into v_receipt from documents where payment_id = pay.id;
    return jsonb_build_object('payment_id', pay.id, 'receipt_id', v_receipt,
      'receipt_number', (select number from documents where id = v_receipt), 'already_confirmed', true);
  end if;
  if pay.status <> 'pending_verification' then raise exception 'PAYMENT_NOT_CONFIRMABLE' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_note, '')) = '' then raise exception 'VERIFICATION_NOTE_REQUIRED' using errcode = 'P0001'; end if;

  -- Pass 1: shape and exact sum.
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then raise exception 'ALLOCATION_REQUIRED' using errcode = 'P0001'; end if;
  n := jsonb_array_length(p_allocations);
  if n < 1 or n > money_max_lines() then raise exception 'ALLOCATION_REQUIRED' using errcode = 'P0001'; end if;
  for i in 0 .. n - 1 loop
    e := p_allocations -> i;
    if jsonb_typeof(e) <> 'object' or coalesce(e ->> 'invoice_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'ALLOCATION_INVALID' using errcode = 'P0001';
    end if;
    v_cash := money_parse(e ->> 'cash_kobo');
    v_wht := money_parse(coalesce(e ->> 'wht_kobo', '0'));
    if v_cash is null or v_wht is null or v_cash > money_max_doc_kobo() or v_wht > money_max_doc_kobo() or v_cash + v_wht = 0 then
      raise exception 'ALLOCATION_INVALID' using errcode = 'P0001';
    end if;
    v_sum := v_sum + v_cash;
  end loop;
  if (select count(distinct lower(x ->> 'invoice_id')) from jsonb_array_elements(p_allocations) x) <> n then
    raise exception 'ALLOCATION_DUPLICATE' using errcode = 'P0001';
  end if;
  if v_sum <> pay.amount_kobo then raise exception 'ALLOCATION_SUM_MISMATCH' using errcode = 'P0001'; end if;

  select * into s from business_settings;
  if not found then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;
  select * into c from customers where id = pay.customer_id;

  -- Pass 2: lock invoices in id order (no deadlocks between two confirmations), then check each one.
  for r in
    select (x ->> 'invoice_id')::uuid as inv_id, money_parse(x ->> 'cash_kobo')::bigint as cash, money_parse(coalesce(x ->> 'wht_kobo', '0'))::bigint as wht
    from jsonb_array_elements(p_allocations) x order by 1
  loop
    select * into inv from documents where id = r.inv_id for update;
    if not found then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
    if inv.doc_type <> 'invoice' or inv.snapshot is null then raise exception 'INVOICE_NOT_PAYABLE' using errcode = 'P0001'; end if;
    if inv.status = 'void' then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;
    if inv.status <> 'issued' then raise exception 'INVOICE_NOT_PAYABLE' using errcode = 'P0001'; end if;
    if inv.customer_id <> pay.customer_id then raise exception 'ALLOCATION_CUSTOMER_MISMATCH' using errcode = 'P0001'; end if;
    perform require_capability('payments.confirm', pay.amount_kobo, inv.created_by);   -- four-eyes on each invoice
    v_bal := invoice_balance(inv.id);
    if r.cash + r.wht > v_bal then raise exception 'ALLOCATION_EXCEEDS_BALANCE' using errcode = 'P0001'; end if;
    v_earlier := invoice_settled_kobo(inv.id);
    v_after := v_bal - r.cash - r.wht;
    if v_after > 0 then v_all_paid := false; end if;
    v_wht_total := v_wht_total + r.wht;
    insert into payment_allocations (payment_id, invoice_id, cash_kobo, wht_kobo) values (pay.id, inv.id, r.cash, r.wht);
    v_applied := v_applied || jsonb_build_array(jsonb_build_object('invoice_id', inv.id, 'invoice_number', inv.number,
      'invoice_total', inv.total_kobo::text, 'earlier_paid', v_earlier::text, 'cash', r.cash::text, 'wht', r.wht::text,
      'balance_after', v_after::text));
  end loop;

  -- Receipt: the same number sequence and hash chain as every other issued document.
  v_year := extract(year from (p_now at time zone 'Africa/Lagos'))::int;
  v_issue := (p_now at time zone 'Africa/Lagos')::date;
  v_number := next_document_number('receipt', v_year);
  v_stamp := case when v_all_paid or s.receipt_stamp_always_paid then 'PAID' else 'PART PAID' end;
  select p.full_name into v_name from profiles p where p.user_id = auth.uid();
  select jsonb_agg(a.e || jsonb_build_object('sn', a.rn) order by a.rn) into v_applied
  from (select z as e, row_number() over (order by z ->> 'invoice_number') as rn from jsonb_array_elements(v_applied) z) a;

  v_snap := jsonb_build_object(
    'version', 1,
    'document', jsonb_build_object('type', 'receipt', 'number', v_number, 'issue_date', v_issue),
    'business', jsonb_build_object('name', s.business_name, 'address', s.address, 'phone', s.phone, 'email', s.email,
      'registration_number', s.registration_number, 'tin', s.tin),
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'billing_address', c.billing_address,
      'contact_person', c.contact_person, 'phone', c.phone, 'email', c.email),
    'payment', jsonb_build_object('id', pay.id, 'method', pay.method, 'paid_on', pay.paid_on, 'reference', pay.reference,
      'amount', pay.amount_kobo::text),
    'applied', v_applied,
    'totals', jsonb_build_object('paid_on_this_receipt', pay.amount_kobo::text, 'wht', v_wht_total::text,
      'settled', (pay.amount_kobo + v_wht_total)::text),
    'stamp', v_stamp,
    'confirmed_by_name', v_name,
    'calc_version', 1);

  select z.o_prev, z.o_hash, z.o_seq into v_prev, v_hash, v_seq from chain_stamp(v_snap) z;

  insert into documents (doc_type, status, customer_id, created_by, number, number_year, issue_date, issued_at, issued_by,
                         snapshot, snapshot_hash, prev_hash, chain_seq, total_kobo, calc_version, payment_id)
  values ('receipt', 'issued', pay.customer_id, auth.uid(), v_number, v_year, v_issue, p_now, auth.uid(),
          v_snap, v_hash, v_prev, v_seq, pay.amount_kobo, 1, pay.id)
  returning id into v_receipt;
  insert into render_jobs (document_id, reason) values (v_receipt, 'issue');

  update payments set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = p_now, verification_note = btrim(p_note)
  where id = pay.id;

  perform write_audit('CONFIRM_PAYMENT', pay.id::text, jsonb_build_object('status', 'pending_verification'),
    jsonb_build_object('status', 'confirmed', 'receipt_number', v_number, 'amount_kobo', pay.amount_kobo::text,
      'wht_kobo', v_wht_total::text, 'note', btrim(p_note), 'allocations', v_applied));
  return jsonb_build_object('payment_id', pay.id, 'receipt_id', v_receipt, 'receipt_number', v_number, 'stamp', v_stamp,
    'applied', v_applied, 'already_confirmed', false);
end $$;

create function confirm_payment(p_payment_id uuid, p_allocations jsonb, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_full_access();
  return confirm_core(p_payment_id, p_allocations, p_note, now());
end $$;

-- 8. Record the customer's WHT credit note (Owner). Clears "credit note pending" on that allocation. ---------------
create function record_wht_credit_note(p_allocation_id uuid, p_reference text, p_received_on date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a payment_allocations%rowtype; p payments%rowtype;
begin
  perform require_full_access();
  if not is_owner() then raise exception 'CAPABILITY_DENIED owner_only' using errcode = '42501'; end if;
  if btrim(coalesce(p_reference, '')) = '' then raise exception 'REFERENCE_REQUIRED' using errcode = 'P0001'; end if;
  if p_received_on is null or p_received_on > (now() at time zone 'Africa/Lagos')::date then
    raise exception 'RECEIVED_ON_INVALID' using errcode = 'P0001';
  end if;
  select * into a from payment_allocations where id = p_allocation_id;
  if not found then raise exception 'ALLOCATION_NOT_FOUND' using errcode = 'P0001'; end if;
  select * into p from payments where id = a.payment_id for update;
  if p.status <> 'confirmed' then raise exception 'PAYMENT_NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if a.wht_kobo = 0 then raise exception 'NO_WHT_ON_ALLOCATION' using errcode = 'P0001'; end if;
  if exists (select 1 from wht_credit_notes where allocation_id = a.id) then raise exception 'WHT_CREDIT_NOTE_ALREADY_RECORDED' using errcode = 'P0001'; end if;
  insert into wht_credit_notes (allocation_id, reference, received_on, recorded_by)
  values (a.id, btrim(p_reference), p_received_on, auth.uid());
  perform write_audit('RECORD_WHT_CREDIT_NOTE', a.id::text, null,
    jsonb_build_object('reference', btrim(p_reference), 'wht_kobo', a.wht_kobo::text, 'invoice_id', a.invoice_id));
end $$;

-- 9. Short-pay adjustment (Owner): closes the whole remaining balance when it is within the Owner-set cap. ----------
create function adjust_short_pay(p_invoice_id uuid, p_reason text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv documents%rowtype; s business_settings%rowtype; v_bal bigint;
begin
  perform require_full_access();
  if not is_owner() then raise exception 'CAPABILITY_DENIED owner_only' using errcode = '42501'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into inv from documents where id = p_invoice_id for update;
  if not found or inv.doc_type <> 'invoice' or inv.snapshot is null then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;
  if inv.status <> 'issued' then raise exception 'INVOICE_NOT_PAYABLE' using errcode = 'P0001'; end if;
  select * into s from business_settings;
  if not found then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;
  if s.short_pay_cap_kobo <= 0 then raise exception 'SHORT_PAY_DISABLED' using errcode = 'P0001'; end if;
  v_bal := invoice_balance(inv.id);
  if v_bal <= 0 then raise exception 'NOTHING_TO_ADJUST' using errcode = 'P0001'; end if;
  if v_bal > s.short_pay_cap_kobo then raise exception 'ADJUSTMENT_OVER_CAP' using errcode = 'P0001'; end if;
  insert into payment_adjustments (invoice_id, amount_kobo, reason, cap_kobo, created_by)
  values (inv.id, v_bal, btrim(p_reason), s.short_pay_cap_kobo, auth.uid());
  perform write_audit('ADJUST_SHORT_PAY', inv.id::text, jsonb_build_object('balance_kobo', v_bal::text),
    jsonb_build_object('balance_kobo', '0', 'adjustment_kobo', v_bal::text, 'cap_kobo', s.short_pay_cap_kobo::text, 'reason', btrim(p_reason)));
  return v_bal;
end $$;

-- 10. Reverse a confirmed payment (Owner, reason). Compensating record; the receipt is voided; balance is restored. ---
create function reverse_payment(p_payment_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare pay payments%rowtype;
begin
  perform require_full_access();
  perform require_capability('payments.reverse');
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into pay from payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if pay.status <> 'confirmed' then raise exception 'PAYMENT_NOT_REVERSIBLE' using errcode = 'P0001'; end if;
  insert into payment_reversals (payment_id, reason, reversed_by) values (pay.id, btrim(p_reason), auth.uid());
  update payments set status = 'reversed' where id = pay.id;
  update documents set status = 'void', void_reason = 'Payment reversed: ' || btrim(p_reason), voided_at = now(), voided_by = auth.uid(), updated_at = now()
  where payment_id = pay.id and status = 'issued';
  perform write_audit('REVERSE_PAYMENT', pay.id::text, jsonb_build_object('status', 'confirmed'),
    jsonb_build_object('status', 'reversed', 'reason', btrim(p_reason), 'amount_kobo', pay.amount_kobo::text));
end $$;

-- 11. Void is blocked while confirmed payments or adjustments exist; a receipt is voided only through a reversal. ----
create or replace function void_document(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d documents%rowtype;
begin
  perform require_full_access();
  perform require_capability('documents.void');
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into d from documents where id = p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if d.doc_type = 'receipt' then raise exception 'RECEIPT_VOID_VIA_REVERSAL' using errcode = 'P0001'; end if;
  if d.status <> 'issued' then raise exception 'STATUS_NOT_VOIDABLE' using errcode = 'P0001'; end if;
  if d.doc_type = 'invoice' and (invoice_settled_kobo(d.id) > 0 or invoice_adjusted_kobo(d.id) > 0) then
    raise exception 'VOID_BLOCKED_PAYMENTS' using errcode = 'P0001';
  end if;
  update documents set status = 'void', void_reason = btrim(p_reason), voided_at = now(), voided_by = auth.uid(), updated_at = now()
  where id = d.id;
  perform write_audit('VOID_DOCUMENT', d.id::text, jsonb_build_object('status', 'issued', 'number', d.number),
    jsonb_build_object('status', 'void', 'number', d.number, 'reason', btrim(p_reason)));
end $$;

-- 12. Privileges and row-level security -----------------------------------------------------------------------------
alter table payments enable row level security;
alter table payment_allocations enable row level security;
alter table wht_credit_notes enable row level security;
alter table payment_reversals enable row level security;
alter table payment_adjustments enable row level security;

revoke all on payments, payment_allocations, wht_credit_notes, payment_reversals, payment_adjustments from public, anon, authenticated;
grant select on payments, payment_allocations, wht_credit_notes, payment_reversals, payment_adjustments to authenticated;

create policy payments_read on payments for select to authenticated
  using (is_owner() or recorded_by = auth.uid() or has_capability('payments.record_evidence')
         or has_capability('payments.confirm') or has_capability('reports.view'));
create policy payment_allocations_read on payment_allocations for select to authenticated
  using (is_owner() or has_capability('payments.record_evidence') or has_capability('payments.confirm') or has_capability('reports.view'));
create policy wht_credit_notes_read on wht_credit_notes for select to authenticated
  using (is_owner() or has_capability('payments.confirm') or has_capability('reports.view'));
create policy payment_reversals_read on payment_reversals for select to authenticated
  using (is_owner() or has_capability('reports.view'));
create policy payment_adjustments_read on payment_adjustments for select to authenticated
  using (is_owner() or has_capability('reports.view'));

revoke execute on function
  payments_guard(), invoice_credited_kobo(uuid), invoice_settled_kobo(uuid), invoice_adjusted_kobo(uuid), invoice_balance(uuid),
  invoice_state_at(uuid, date), invoice_payment_status(uuid), chain_stamp(jsonb),
  record_payment(text, uuid, text, text, date, text, text), confirm_core(uuid, jsonb, text, timestamptz),
  confirm_payment(uuid, jsonb, text), record_wht_credit_note(uuid, text, date), adjust_short_pay(uuid, text), reverse_payment(uuid, text)
  from public, anon;
revoke execute on function
  invoice_credited_kobo(uuid), invoice_settled_kobo(uuid), invoice_adjusted_kobo(uuid), invoice_balance(uuid),
  invoice_state_at(uuid, date), chain_stamp(jsonb), confirm_core(uuid, jsonb, text, timestamptz)
  from authenticated;
grant execute on function
  invoice_payment_status(uuid), record_payment(text, uuid, text, text, date, text, text), confirm_payment(uuid, jsonb, text),
  record_wht_credit_note(uuid, text, date), adjust_short_pay(uuid, text), reverse_payment(uuid, text)
  to authenticated;
