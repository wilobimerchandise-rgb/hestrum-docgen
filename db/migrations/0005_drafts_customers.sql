-- 0005_drafts_customers.sql: Hestrum DocGen Playbook v6.0, sections 7.1, 7.2 (transitions) and 7.8 (customers).
-- The draft lifecycle written as RPCs: save_draft, submit_document, return_document, void_document,
-- plus create_customer, update_customer and search_customers. Run after 0004.
-- Every mutating RPC calls require_full_access() first. Identity comes from the session (auth.uid()), never from the client.

-- 1. Columns for the lifecycle ------------------------------------------------------------------------------------
alter table documents
  add column submitted_at timestamptz,
  add column return_reason text,
  add column returned_at timestamptz,
  add column returned_by uuid references profiles (user_id),
  add column void_reason text,
  add column voided_at timestamptz,
  add column voided_by uuid references profiles (user_id);

-- An issued document may still change its status (issued to void, accepted, declined). Voiding records who, when and why,
-- and only at the moment of voiding. Everything else stays frozen.
create or replace function documents_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.snapshot is not null then raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.snapshot is not null then
    if (to_jsonb(new) - 'status' - 'updated_at' - 'void_reason' - 'voided_at' - 'voided_by')
       is distinct from (to_jsonb(old) - 'status' - 'updated_at' - 'void_reason' - 'voided_at' - 'voided_by') then
      raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0001';
    end if;
    if new.status is distinct from old.status then
      if not (old.status = 'issued' and new.status in ('void', 'accepted', 'declined')) then
        raise exception 'STATUS_TRANSITION_INVALID' using errcode = 'P0001';
      end if;
      if new.status <> 'void' and (new.void_reason is not null or new.voided_at is not null or new.voided_by is not null) then
        raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0001';
      end if;
    elsif (new.void_reason, new.voided_at, new.voided_by) is distinct from (old.void_reason, old.voided_at, old.voided_by) then
      raise exception 'DOCUMENT_IMMUTABLE' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- 2. Customer helpers (playbook 7.8) -----------------------------------------------------------------------------
-- Nigerian phone to +234 form for WhatsApp. Accepts +234XXXXXXXXXX, 234XXXXXXXXXX and 0XXXXXXXXXX (spaces, dots, dashes
-- and brackets ignored). Blank is NULL. Anything else is refused, never guessed.
create function normalize_ng_phone(p text) returns text
language plpgsql immutable as $$
declare s text;
begin
  if p is null or btrim(p) = '' then return null; end if;
  s := regexp_replace(p, '[ \t\-\.\(\)]', '', 'g');
  if s ~ '^\+234[0-9]{10}$' then return s;
  elsif s ~ '^234[0-9]{10}$' then return '+' || s;
  elsif s ~ '^0[0-9]{10}$' then return '+234' || substr(s, 2);
  end if;
  raise exception 'PHONE_INVALID' using errcode = 'P0001';
end $$;

-- Syntax only. A valid-looking address is never assumed to be deliverable.
create function normalize_email(p text) returns text
language plpgsql immutable as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  if btrim(p) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'EMAIL_INVALID' using errcode = 'P0001';
  end if;
  return lower(btrim(p));
end $$;

create function create_customer(p_name text, p_billing_address text, p_contact_person text default null,
                                p_phone text default null, p_email text default null, p_notes text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform require_full_access();
  perform require_capability('customers.manage');
  if btrim(coalesce(p_name, '')) = '' then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_billing_address, '')) = '' then raise exception 'ADDRESS_REQUIRED' using errcode = 'P0001'; end if;
  insert into customers (name, billing_address, contact_person, phone, email, notes, created_by)
  values (btrim(p_name), btrim(p_billing_address), nullif(btrim(coalesce(p_contact_person, '')), ''),
          normalize_ng_phone(p_phone), normalize_email(p_email), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create function update_customer(p_id uuid, p_name text, p_billing_address text, p_contact_person text default null,
                                p_phone text default null, p_email text default null, p_notes text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_full_access();
  perform require_capability('customers.manage');
  if btrim(coalesce(p_name, '')) = '' then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_billing_address, '')) = '' then raise exception 'ADDRESS_REQUIRED' using errcode = 'P0001'; end if;
  update customers set name = btrim(p_name), billing_address = btrim(p_billing_address),
    contact_person = nullif(btrim(coalesce(p_contact_person, '')), ''), phone = normalize_ng_phone(p_phone),
    email = normalize_email(p_email), notes = nullif(btrim(coalesce(p_notes, '')), ''), updated_at = now()
  where id = p_id;
  if not found then raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0001'; end if;
end $$;

-- Pick a customer while drafting. Staff must type at least 2 characters and get at most 20 rows, with no paging, so they
-- cannot walk the whole list. A role that also holds reports.view (or the Owner) may list and page (up to 200 per page).
create function search_customers(p_query text default '', p_limit int default 20, p_offset int default 0)
returns table (id uuid, name text, billing_address text, contact_person text, phone text, email text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_wide boolean; v_q text := btrim(coalesce(p_query, '')); v_lim int; v_off int; v_like text; v_digits text;
begin
  perform require_capability('customers.manage');
  v_wide := is_owner() or has_capability('reports.view');
  if v_wide then
    v_lim := least(greatest(coalesce(p_limit, 20), 1), 200);
    v_off := greatest(coalesce(p_offset, 0), 0);
  else
    if length(v_q) < 2 then raise exception 'QUERY_TOO_SHORT' using errcode = 'P0001'; end if;
    v_lim := least(greatest(coalesce(p_limit, 20), 1), 20);
    v_off := 0;
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');
  return query
    select c.id, c.name, c.billing_address, c.contact_person, c.phone, c.email
    from customers c
    where v_q = '' or c.name ilike v_like
       or (length(v_digits) >= 3 and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%')
    order by c.name, c.id
    limit v_lim offset v_off;
end $$;

-- 3. Save draft (playbook 7.2: valid shape, money recomputed on the server, no number allocated) ------------------
-- p_id null creates. Only the creator edits, and only while the document is a draft.
-- p_doc: {doc_type, customer_id, discount_kind, discount_value, vat_enabled, payment_terms_days, valid_until,
--         po_reference, notes, lines: [{description, qty_milli, unit_kobo}]} with money and quantity as strings.
-- Returns {id, totals} where totals is the server calculation (null while there are no lines).
create function save_draft(p_id uuid, p_doc jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d documents%rowtype; s business_settings%rowtype; v_id uuid; v_type text; v_cust uuid;
  v_kind text; v_value bigint; v_vat boolean; v_vat_base boolean; v_terms int; v_valid date;
  v_lines jsonb; v_calc jsonb := null; v_n int; l jsonb; i int; v_desc text; v_txt text;
begin
  perform require_full_access();
  perform require_capability('draft.create_own');
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' then raise exception 'DOC_INVALID' using errcode = 'P0001'; end if;
  select * into s from business_settings;
  if not found then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;

  if p_id is null then
    v_type := p_doc ->> 'doc_type';
    if v_type is null or v_type not in ('quotation', 'invoice') then raise exception 'DOC_TYPE_INVALID' using errcode = 'P0001'; end if;
  else
    select * into d from documents where id = p_id for update;
    if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
    if d.created_by <> auth.uid() then raise exception 'NOT_YOUR_DRAFT' using errcode = '42501'; end if;
    if d.status <> 'draft' then raise exception 'DRAFT_LOCKED' using errcode = 'P0001'; end if;
    v_type := d.doc_type;
    if p_doc ? 'doc_type' and p_doc ->> 'doc_type' is distinct from d.doc_type then
      raise exception 'DOC_TYPE_IMMUTABLE' using errcode = 'P0001';
    end if;
  end if;

  v_txt := p_doc ->> 'customer_id';
  if v_txt is null or v_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'CUSTOMER_MISSING' using errcode = 'P0001';
  end if;
  v_cust := v_txt::uuid;
  if not exists (select 1 from customers where id = v_cust) then raise exception 'CUSTOMER_MISSING' using errcode = 'P0001'; end if;

  v_kind := coalesce(p_doc ->> 'discount_kind', 'none');
  if v_kind not in ('none', 'percent', 'fixed') then raise exception 'DISCOUNT_KIND_INVALID' using errcode = 'P0001'; end if;
  if v_kind = 'none' then
    v_value := null;
  else
    v_value := money_parse(p_doc ->> 'discount_value');
    if v_value is null then raise exception 'DISCOUNT_VALUE_REQUIRED' using errcode = 'P0001'; end if;
  end if;

  -- VAT: off at the master switch means never on. With the master on a new document defaults to on; only the Owner or a role
  -- holding vat.change_per_document may change it away from the stored (or default) value.
  v_vat_base := case when not s.vat_enabled then false when p_id is null then true else d.vat_enabled end;
  v_vat := v_vat_base;
  if p_doc ? 'vat_enabled' then
    if jsonb_typeof(p_doc -> 'vat_enabled') <> 'boolean' then raise exception 'VAT_FLAG_INVALID' using errcode = 'P0001'; end if;
    v_vat := (p_doc ->> 'vat_enabled')::boolean;
  end if;
  if v_vat and not s.vat_enabled then raise exception 'VAT_DISABLED' using errcode = 'P0001'; end if;
  if v_vat is distinct from v_vat_base and not (is_owner() or has_capability('vat.change_per_document')) then
    raise exception 'CAPABILITY_DENIED vat.change_per_document' using errcode = '42501';
  end if;

  if p_doc ? 'payment_terms_days' and jsonb_typeof(p_doc -> 'payment_terms_days') <> 'null' then
    if jsonb_typeof(p_doc -> 'payment_terms_days') <> 'number' or (p_doc ->> 'payment_terms_days') !~ '^[0-9]{1,4}$' then
      raise exception 'TERMS_INVALID' using errcode = 'P0001';
    end if;
    v_terms := (p_doc ->> 'payment_terms_days')::int;
  end if;
  v_txt := p_doc ->> 'valid_until';
  if v_txt is not null then
    if v_txt !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'VALID_UNTIL_INVALID' using errcode = 'P0001'; end if;
    begin
      v_valid := v_txt::date;
    exception when others then
      raise exception 'VALID_UNTIL_INVALID' using errcode = 'P0001';
    end;
  end if;

  -- Lines: validate shape, then let the money engine validate and compute everything.
  if p_doc ? 'lines' and jsonb_typeof(p_doc -> 'lines') <> 'null' then
    if jsonb_typeof(p_doc -> 'lines') <> 'array' then raise exception 'LINES_INVALID' using errcode = 'P0001'; end if;
    v_lines := p_doc -> 'lines';
  else
    v_lines := '[]'::jsonb;
  end if;
  v_n := jsonb_array_length(v_lines);
  for i in 0 .. v_n - 1 loop
    l := v_lines -> i;
    if jsonb_typeof(l) <> 'object' then raise exception 'LINES_INVALID' using errcode = 'P0001'; end if;
    v_desc := btrim(coalesce(l ->> 'description', ''));
    if v_desc = '' then raise exception 'DESCRIPTION_REQUIRED' using errcode = 'P0001'; end if;
  end loop;
  if v_n > 0 then
    v_calc := compute_totals(v_lines, v_kind, v_value, v_vat, s.vat_rate_bp);
  end if;

  if p_id is null then
    insert into documents (doc_type, customer_id, created_by, discount_kind, discount_value, vat_enabled, payment_terms_days,
                           valid_until, po_reference, notes)
    values (v_type, v_cust, auth.uid(), v_kind, v_value, v_vat, v_terms, v_valid,
            nullif(btrim(coalesce(p_doc ->> 'po_reference', '')), ''), nullif(btrim(coalesce(p_doc ->> 'notes', '')), ''))
    returning id into v_id;
  else
    v_id := p_id;
    update documents set customer_id = v_cust, discount_kind = v_kind, discount_value = v_value, vat_enabled = v_vat,
      payment_terms_days = v_terms, valid_until = v_valid,
      po_reference = nullif(btrim(coalesce(p_doc ->> 'po_reference', '')), ''),
      notes = nullif(btrim(coalesce(p_doc ->> 'notes', '')), ''), updated_at = now()
    where id = v_id;
    delete from document_lines where document_id = v_id;
  end if;

  insert into document_lines (document_id, position, description, qty_milli, unit_kobo)
  select v_id, x.ord::int, btrim(x.e ->> 'description'), (x.e ->> 'qty_milli')::bigint, (x.e ->> 'unit_kobo')::bigint
  from jsonb_array_elements(v_lines) with ordinality as x(e, ord);

  return jsonb_build_object('id', v_id, 'totals', v_calc);
end $$;

-- 4. Submit for approval: the creator only. Locks staff editing. -----------------------------------------------------
create function submit_document(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d documents%rowtype; v_calc jsonb;
begin
  perform require_full_access();
  perform require_capability('draft.create_own');
  select * into d from documents where id = p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if d.created_by <> auth.uid() then raise exception 'NOT_YOUR_DRAFT' using errcode = '42501'; end if;
  if d.status <> 'draft' then raise exception 'STATUS_NOT_SUBMITTABLE' using errcode = 'P0001'; end if;
  if not exists (select 1 from customers where id = d.customer_id) then raise exception 'CUSTOMER_MISSING' using errcode = 'P0001'; end if;
  if d.doc_type = 'quotation' and d.valid_until is null then raise exception 'VALID_UNTIL_REQUIRED' using errcode = 'P0001'; end if;
  if d.doc_type = 'invoice' and d.payment_terms_days is null then raise exception 'TERMS_REQUIRED' using errcode = 'P0001'; end if;
  v_calc := doc_compute(d.id);                      -- at least one line, every limit, VAT still allowed
  update documents set status = 'pending_approval', submitted_at = now(), updated_at = now() where id = d.id;
  perform write_audit('SUBMIT_DOCUMENT', d.id::text, jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'pending_approval', 'doc_type', d.doc_type, 'total_kobo', v_calc ->> 'total'));
end $$;

-- 5. Return to the creator with a reason: Owner only. The document goes back to draft and can be edited and resubmitted.
create function return_document(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d documents%rowtype;
begin
  perform require_full_access();
  if not is_owner() then raise exception 'CAPABILITY_DENIED return_document' using errcode = '42501'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into d from documents where id = p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if d.status <> 'pending_approval' then raise exception 'STATUS_NOT_RETURNABLE' using errcode = 'P0001'; end if;
  update documents set status = 'draft', return_reason = btrim(p_reason), returned_at = now(), returned_by = auth.uid(),
    updated_at = now() where id = d.id;
  perform write_audit('RETURN_DOCUMENT', d.id::text, jsonb_build_object('status', 'pending_approval'),
    jsonb_build_object('status', 'draft', 'reason', btrim(p_reason), 'created_by', d.created_by));
end $$;

-- 6. Void an issued document: Owner only, reason required. The number is retired, never reused (the counter never moves back).
-- NOTE: playbook 7.2 also blocks voiding while confirmed payments or credit notes exist. Those tables arrive with the
-- payments batch, which replaces this function with the same rule added. Until then no payment can exist.
create function void_document(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d documents%rowtype;
begin
  perform require_full_access();
  perform require_capability('documents.void');
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into d from documents where id = p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0001'; end if;
  if d.status <> 'issued' then raise exception 'STATUS_NOT_VOIDABLE' using errcode = 'P0001'; end if;
  update documents set status = 'void', void_reason = btrim(p_reason), voided_at = now(), voided_by = auth.uid(), updated_at = now()
  where id = d.id;
  perform write_audit('VOID_DOCUMENT', d.id::text, jsonb_build_object('status', 'issued', 'number', d.number),
    jsonb_build_object('status', 'void', 'number', d.number, 'reason', btrim(p_reason)));
end $$;

-- 7. Privileges -----------------------------------------------------------------------------------------------------
revoke execute on function
  normalize_ng_phone(text), normalize_email(text),
  create_customer(text, text, text, text, text, text), update_customer(uuid, text, text, text, text, text, text),
  search_customers(text, int, int), save_draft(uuid, jsonb), submit_document(uuid), return_document(uuid, text),
  void_document(uuid, text)
  from public, anon;
grant execute on function
  create_customer(text, text, text, text, text, text), update_customer(uuid, text, text, text, text, text, text),
  search_customers(text, int, int), save_draft(uuid, jsonb), submit_document(uuid), return_document(uuid, text),
  void_document(uuid, text)
  to authenticated;
revoke execute on function normalize_ng_phone(text), normalize_email(text) from authenticated;
