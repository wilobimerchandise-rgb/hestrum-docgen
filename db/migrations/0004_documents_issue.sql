-- 0004_documents_issue.sql: Hestrum DocGen Playbook v6.0, sections 7.2, 7.3 and 7.7 (documents, numbering, atomic issue).
-- Run after 0000 to 0003. Covers quotations and invoices. Credit notes, receipts and waybills extend this in later migrations.
-- Drafts are written by later RPCs (save, submit, return, void). This file owns the part that must never go wrong:
-- allocate a gapless number, freeze the snapshot, chain its hash, audit it and queue the PDF, all in ONE transaction.

-- 1. Business settings: one row. Everything the snapshot copies at issue (letterhead, bank details, VAT, prefixes). ------
create table business_settings (
  id boolean primary key default true check (id),
  business_name text not null check (btrim(business_name) <> ''),
  address text not null check (btrim(address) <> ''),
  phone text,
  email text,
  registration_number text,
  tin text,
  vat_enabled boolean not null default false,
  vat_rate_bp int not null default 750 check (vat_rate_bp between 0 and 10000),
  bank_name text,
  account_name text,
  account_number text,
  prefix_quotation text not null default 'QTN' check (prefix_quotation ~ '^[A-Z]{2,6}$'),
  prefix_invoice text not null default 'INV' check (prefix_invoice ~ '^[A-Z]{2,6}$'),
  updated_at timestamptz not null default now(),
  check (prefix_quotation <> prefix_invoice)
);

-- 2. Customers ----------------------------------------------------------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  billing_address text not null check (btrim(billing_address) <> ''),
  contact_person text,
  phone text,
  email text,
  notes text,
  created_by uuid not null references profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Documents ----------------------------------------------------------------------------------------------------
create sequence document_chain_seq;

create table documents (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null check (doc_type in ('quotation', 'invoice')),
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'issued', 'accepted', 'declined', 'void')),
  customer_id uuid not null references customers (id),
  created_by uuid not null references profiles (user_id),
  discount_kind text not null default 'none' check (discount_kind in ('none', 'percent', 'fixed')),
  discount_value bigint check (discount_value is null or discount_value >= 0),
  vat_enabled boolean not null default false,
  payment_terms_days int check (payment_terms_days is null or payment_terms_days >= 0),
  valid_until date,
  po_reference text,
  notes text,
  source_document_id uuid references documents (id),
  -- set only by the issue transaction
  number text unique,
  number_year int,
  issue_date date,
  due_date date,
  issued_at timestamptz,
  issued_by uuid references profiles (user_id),
  snapshot jsonb,
  snapshot_hash text,
  prev_hash text,
  chain_seq bigint unique,
  subtotal_kobo bigint,
  discount_kobo bigint,
  base_kobo bigint,
  vat_kobo bigint,
  total_kobo bigint,
  calc_version int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((snapshot is null) = (status in ('draft', 'pending_approval'))),
  check (status not in ('accepted', 'declined') or doc_type = 'quotation'),
  check ((snapshot is null) = (number is null)),
  check (discount_kind = 'none' or discount_value is not null)
);
create index documents_customer_idx on documents (customer_id);
create index documents_created_by_idx on documents (created_by);

create table document_lines (
  document_id uuid not null references documents (id) on delete cascade,
  position int not null check (position >= 1),
  description text not null check (btrim(description) <> ''),
  qty_milli bigint not null check (qty_milli > 0),
  unit_kobo bigint not null check (unit_kobo >= 0),
  primary key (document_id, position)
);

-- Numbering: one counter per type and Lagos year. The row lock serialises allocation, the transaction makes it gapless.
create table document_counters (
  doc_type text not null,
  year int not null,
  last_value bigint not null check (last_value >= 0),
  primary key (doc_type, year)
);

-- Outbox: the worker reads this, builds the PDF from the snapshot and records the render.
create table render_jobs (
  id bigint generated always as identity primary key,
  document_id uuid not null references documents (id),
  reason text not null check (reason in ('issue')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, reason)
);

-- 4. Immutability: an issued document keeps its snapshot, number and money forever. -------------------------------
create function documents_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.snapshot is not null then raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.snapshot is not null then
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0001';
    end if;
    if new.status is distinct from old.status
       and not (old.status = 'issued' and new.status in ('void', 'accepted', 'declined')) then
      raise exception 'STATUS_TRANSITION_INVALID' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger documents_guard_row before update or delete on documents
  for each row execute function documents_guard();

create function document_lines_guard() returns trigger language plpgsql as $$
declare v_id uuid := coalesce(new.document_id, old.document_id);
begin
  if exists (select 1 from documents where id = v_id and snapshot is not null) then
    raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

create trigger document_lines_guard_row before insert or update or delete on document_lines
  for each row execute function document_lines_guard();

-- 5. Helpers --------------------------------------------------------------------------------------------------------
-- Totals for a stored document, always from the database money engine (0003).
create function doc_compute(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d documents%rowtype; s business_settings%rowtype; v_lines jsonb;
begin
  select * into d from documents where id = p_id;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  select * into s from business_settings;
  if not found then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;
  if d.vat_enabled and not s.vat_enabled then raise exception 'VAT_DISABLED' using errcode = 'P0001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('qty_milli', l.qty_milli::text, 'unit_kobo', l.unit_kobo::text) order by l.position),
                  '[]'::jsonb)
    into v_lines from document_lines l where l.document_id = d.id;
  return compute_totals(v_lines, d.discount_kind, d.discount_value, d.vat_enabled, s.vat_rate_bp);
end $$;

-- Next number for a type and year: PREFIX-YYYY-0001. Digits grow past 9999 instead of wrapping. Never reused.
create function next_document_number(p_type text, p_year int) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint; v_prefix text;
begin
  select case p_type when 'quotation' then prefix_quotation when 'invoice' then prefix_invoice end into v_prefix from business_settings;
  if v_prefix is null then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;
  insert into document_counters (doc_type, year, last_value) values (p_type, p_year, 1)
    on conflict (doc_type, year) do update set last_value = document_counters.last_value + 1
    returning last_value into v;
  return v_prefix || '-' || p_year::text || '-' || case when v < 10000 then lpad(v::text, 4, '0') else v::text end;
end $$;

-- 6. The atomic issue transaction (playbook 7.3). No authority checks here: it is called only by approve_and_issue
--    (and by tests with a fixed clock). p_now is the issue instant; the public RPC always passes now().
create function issue_core(p_id uuid, p_now timestamptz) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d documents%rowtype; s business_settings%rowtype; c customers%rowtype;
  v_calc jsonb; v_total bigint; v_year int; v_number text; v_issue date; v_due date;
  v_prev text; v_snap jsonb; v_hash text; v_seq bigint; v_creator text; v_issuer text; v_lines jsonb;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  select * into d from documents where id = p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if d.snapshot is not null then return d.number; end if;
  if d.status not in ('draft', 'pending_approval') then raise exception 'STATUS_NOT_ISSUABLE' using errcode = 'P0001'; end if;

  select * into s from business_settings;
  if not found then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;
  select * into c from customers where id = d.customer_id;
  if not found then raise exception 'CUSTOMER_MISSING' using errcode = 'P0001'; end if;
  if d.doc_type = 'quotation' and d.valid_until is null then raise exception 'VALID_UNTIL_REQUIRED' using errcode = 'P0001'; end if;
  if d.doc_type = 'invoice' and d.payment_terms_days is null then raise exception 'TERMS_REQUIRED' using errcode = 'P0001'; end if;
  if d.vat_enabled and (btrim(coalesce(s.tin, '')) = '' or btrim(coalesce(s.registration_number, '')) = '') then
    raise exception 'VAT_COMPLIANCE_MISSING' using errcode = 'P0001';
  end if;
  if btrim(coalesce(s.bank_name, '')) = '' or btrim(coalesce(s.account_name, '')) = '' or btrim(coalesce(s.account_number, '')) = '' then
    raise exception 'BANK_DETAILS_MISSING' using errcode = 'P0001';
  end if;

  v_calc := doc_compute(d.id);                      -- revalidates the lines, discount and VAT with the money engine
  v_total := (v_calc ->> 'total')::bigint;
  if not can_issue(v_total) then raise exception 'TOTAL_NOT_ABOVE_ZERO' using errcode = 'P0001'; end if;

  v_year := extract(year from (p_now at time zone 'Africa/Lagos'))::int;
  v_issue := (p_now at time zone 'Africa/Lagos')::date;
  v_due := case when d.doc_type = 'invoice' then v_issue + d.payment_terms_days else null end;
  v_number := next_document_number(d.doc_type, v_year);

  select p.full_name into v_creator from profiles p where p.user_id = d.created_by;
  select p.full_name into v_issuer from profiles p where p.user_id = auth.uid();

  select jsonb_agg(jsonb_build_object('sn', t.ord, 'description', l.description, 'qty_milli', l.qty_milli::text,
                                      'unit_kobo', l.unit_kobo::text, 'line_total', t.val) order by t.ord)
    into v_lines
  from jsonb_array_elements_text(v_calc -> 'line_totals') with ordinality as t(val, ord)
  join (select dl.description, dl.qty_milli, dl.unit_kobo, row_number() over (order by dl.position) as rn
        from document_lines dl where dl.document_id = d.id) l on l.rn = t.ord;

  v_snap := jsonb_build_object(
    'version', 1,
    'document', jsonb_build_object('type', d.doc_type, 'number', v_number, 'issue_date', v_issue, 'due_date', v_due,
      'valid_until', d.valid_until, 'payment_terms_days', d.payment_terms_days, 'po_reference', d.po_reference,
      'notes', d.notes, 'source_document_id', d.source_document_id),
    'business', jsonb_build_object('name', s.business_name, 'address', s.address, 'phone', s.phone, 'email', s.email,
      'registration_number', s.registration_number, 'tin', s.tin),
    'bank', jsonb_build_object('bank_name', s.bank_name, 'account_name', s.account_name, 'account_number', s.account_number),
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'billing_address', c.billing_address,
      'contact_person', c.contact_person, 'phone', c.phone, 'email', c.email),
    'creator_name', v_creator,
    'approved_by_name', v_issuer,
    'vat', jsonb_build_object('enabled', d.vat_enabled, 'rate_bp', case when d.vat_enabled then s.vat_rate_bp else null end,
      'amount', v_calc ->> 'vat'),
    'lines', v_lines,
    'totals', jsonb_build_object('subtotal', v_calc ->> 'subtotal', 'discount', v_calc ->> 'discount',
      'base', v_calc ->> 'base', 'vat', v_calc ->> 'vat', 'total', v_calc ->> 'total'),
    'calc_version', 1);

  -- Chain: hash of the previous snapshot hash plus this snapshot. One writer at a time keeps the chain linear.
  perform pg_advisory_xact_lock(7002);
  select x.snapshot_hash into v_prev from documents x where x.chain_seq is not null order by x.chain_seq desc limit 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  v_seq := nextval('document_chain_seq');
  v_hash := encode(sha256(convert_to(v_prev || '|' || v_snap::text, 'UTF8')), 'hex');

  update documents set
    status = 'issued', number = v_number, number_year = v_year, issue_date = v_issue, due_date = v_due,
    issued_at = p_now, issued_by = auth.uid(), snapshot = v_snap, snapshot_hash = v_hash, prev_hash = v_prev, chain_seq = v_seq,
    subtotal_kobo = (v_calc ->> 'subtotal')::bigint, discount_kobo = (v_calc ->> 'discount')::bigint,
    base_kobo = (v_calc ->> 'base')::bigint, vat_kobo = (v_calc ->> 'vat')::bigint, total_kobo = v_total,
    calc_version = 1, updated_at = now()
  where id = d.id;

  perform write_audit('ISSUE_DOCUMENT', d.id::text, null,
    jsonb_build_object('number', v_number, 'doc_type', d.doc_type, 'total_kobo', v_total::text, 'snapshot_hash', v_hash));
  insert into render_jobs (document_id, reason) values (d.id, 'issue');
  return v_number;
end $$;

-- Public RPC: Approve and issue. Full access first, then the capability (cap, four-eyes, fresh MFA), then the transaction.
create function approve_and_issue(p_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare d documents%rowtype;
begin
  perform require_full_access();
  if not has_capability('documents.approve_issue') then
    raise exception 'CAPABILITY_DENIED documents.approve_issue' using errcode = '42501';
  end if;
  select * into d from documents where id = p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if d.snapshot is not null then
    perform require_capability('documents.approve_issue', d.total_kobo, d.created_by);
    return d.number;                                  -- already issued: same number, nothing new written
  end if;
  perform require_capability('documents.approve_issue', (doc_compute(d.id) ->> 'total')::bigint, d.created_by);
  if not is_owner() and d.status <> 'pending_approval' then
    raise exception 'STATUS_NOT_ISSUABLE' using errcode = 'P0001';
  end if;
  return issue_core(d.id, now());
end $$;

-- Weekly job: verifies every snapshot hash and the links between them. Returns true when the chain is intact.
create function verify_snapshot_chain() returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record; v_prev text := repeat('0', 64);
begin
  for r in select x.prev_hash, x.snapshot_hash, x.snapshot from documents x where x.chain_seq is not null order by x.chain_seq loop
    if r.prev_hash <> v_prev
       or r.snapshot_hash <> encode(sha256(convert_to(v_prev || '|' || r.snapshot::text, 'UTF8')), 'hex') then
      return false;
    end if;
    v_prev := r.snapshot_hash;
  end loop;
  return true;
end $$;

-- 7. Privileges and row-level security ---------------------------------------------------------------------------
alter table business_settings enable row level security;
alter table customers enable row level security;
alter table documents enable row level security;
alter table document_lines enable row level security;
alter table document_counters enable row level security;
alter table render_jobs enable row level security;

revoke all on business_settings, customers, documents, document_lines, document_counters, render_jobs
  from public, anon, authenticated;
revoke all on sequence document_chain_seq from public, anon, authenticated;
grant select on business_settings, customers, documents, document_lines to authenticated;

create policy business_settings_read on business_settings for select to authenticated
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));
-- Customer lists are served by a later search RPC, so a staff member cannot page through every customer.
create policy customers_read on customers for select to authenticated using (is_owner());
create policy documents_read on documents for select to authenticated
  using (is_owner() or created_by = auth.uid() or has_capability('draft.view_all'));
create policy document_lines_read on document_lines for select to authenticated
  using (exists (select 1 from documents d where d.id = document_lines.document_id
                 and (is_owner() or d.created_by = auth.uid() or has_capability('draft.view_all'))));

revoke execute on function
  documents_guard(), document_lines_guard(), doc_compute(uuid), next_document_number(text, int), issue_core(uuid, timestamptz),
  approve_and_issue(uuid), verify_snapshot_chain()
  from public, anon;
revoke execute on function doc_compute(uuid), next_document_number(text, int), issue_core(uuid, timestamptz),
  verify_snapshot_chain() from authenticated;
grant execute on function approve_and_issue(uuid) to authenticated;
