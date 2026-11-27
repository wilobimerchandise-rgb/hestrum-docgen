-- 0007_credit_notes.sql: Hestrum DocGen Playbook v6.0, sections 7.2, 8.4 and vector G10 (credit notes).
-- Run after 0000 to 0006.
--
-- A credit note is issued against an ISSUED invoice and is created already issued, in one transaction, with:
--   * its own sequence CRN-YYYY-0001 (Lagos year, gapless, never reused) and the same hash chain as every other document;
--   * VAT computed at the INVOICE's snapshot rate, never today's rate;
--   * credit total <= invoice total - earlier credits (G10), and the net invoice may not fall below what was already settled;
--   * authority creditnotes.issue: per-credit cap, never against one's own invoice (non-Owner), fresh MFA.
-- Refunding cash is out of scope: reverse the payment first (0006).

-- 1. Settings and document type ------------------------------------------------------------------------------------
alter table business_settings
  add column prefix_credit_note text not null default 'CRN' check (prefix_credit_note ~ '^[A-Z]{2,6}$');
alter table business_settings add constraint business_settings_credit_prefix_distinct
  check (prefix_credit_note <> prefix_quotation and prefix_credit_note <> prefix_invoice and prefix_credit_note <> prefix_receipt);

alter table documents drop constraint documents_doc_type_check;
alter table documents add constraint documents_doc_type_check
  check (doc_type in ('quotation', 'invoice', 'receipt', 'credit_note'));

create or replace function next_document_number(p_type text, p_year int) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v bigint; v_prefix text;
begin
  select case p_type when 'quotation' then prefix_quotation when 'invoice' then prefix_invoice
                     when 'receipt' then prefix_receipt when 'credit_note' then prefix_credit_note end
    into v_prefix from business_settings;
  if v_prefix is null then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;
  insert into document_counters (doc_type, year, last_value) values (p_type, p_year, 1)
    on conflict (doc_type, year) do update set last_value = document_counters.last_value + 1
    returning last_value into v;
  return v_prefix || '-' || p_year::text || '-' || case when v < 10000 then lpad(v::text, 4, '0') else v::text end;
end $$;

-- 2. Idempotency: a double-click or a retry must never issue two credit notes. -------------------------------------
create table credit_note_requests (
  created_by uuid not null references profiles (user_id),
  idempotency_key text not null check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 100),
  invoice_id uuid not null references documents (id),
  reason text not null,
  document_id uuid not null unique references documents (id),
  created_at timestamptz not null default now(),
  primary key (created_by, idempotency_key)
);
create trigger credit_note_requests_insert_only before update or delete on credit_note_requests
  for each row execute function forbid_change();
create trigger credit_note_requests_no_truncate before truncate on credit_note_requests
  for each statement execute function forbid_change();

-- 3. Credits now count in the derived balance (replaces the zero placeholder from 0006). ---------------------------
create or replace function invoice_credited_kobo(p_id uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(c.total_kobo), 0)::bigint
  from documents c where c.doc_type = 'credit_note' and c.source_document_id = p_id and c.status = 'issued'
$$;

-- An invoice cleared only by credit notes is 'credited', not 'paid'.
create or replace function invoice_state_at(p_id uuid, p_today date) returns jsonb
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
  v_state := case when d.status = 'void' then 'void'
                  when v_bal = 0 and v_settled = 0 and v_adj = 0 and v_cred > 0 then 'credited'
                  when v_bal = 0 then 'paid'
                  when v_settled > 0 then 'partially_paid'
                  else 'unpaid' end;
  return jsonb_build_object('invoice_id', d.id, 'number', d.number, 'document_status', d.status, 'state', v_state,
    'overdue', (d.status = 'issued' and v_bal > 0 and d.due_date is not null and p_today > d.due_date),
    'total', d.total_kobo::text, 'credited', v_cred::text, 'settled', v_settled::text, 'wht', v_wht::text,
    'wht_credit_note_pending', v_pending::text, 'adjusted', v_adj::text, 'balance', v_bal::text);
end $$;

-- 4. Issue a credit note. Internal core holds the authority checks (four-eyes needs the locked invoice); p_now pins the clock.
-- p_lines: [{"description": "...", "qty_milli": "1000", "unit_kobo": "2000000"}]  (the credited base, line by line)
create function issue_credit_core(p_key text, p_invoice_id uuid, p_lines jsonb, p_reason text, p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  inv documents%rowtype; s business_settings%rowtype; ex credit_note_requests%rowtype;
  v_key text; v_reason text; v_vat_on boolean; v_rate bigint; v_calc jsonb; v_total bigint; v_vat bigint; v_base bigint;
  v_earlier bigint; v_settled bigint; v_adjusted bigint; v_balance bigint; v_remaining bigint;
  v_lines jsonb := '[]'::jsonb; l jsonb; i int; n int; v_desc text; v_lt text;
  v_year int; v_issue date; v_number text; v_snap jsonb; v_prev text; v_hash text; v_seq bigint; v_name text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  if not has_capability('creditnotes.issue') then raise exception 'CAPABILITY_DENIED creditnotes.issue' using errcode = '42501'; end if;
  v_key := btrim(coalesce(p_key, ''));
  if v_key = '' or length(v_key) > 100 then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'P0001'; end if;
  v_reason := btrim(coalesce(p_reason, ''));

  select * into inv from documents where id = p_invoice_id for update;
  if not found or inv.doc_type <> 'invoice' or inv.snapshot is null then raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0001'; end if;

  select * into ex from credit_note_requests where created_by = auth.uid() and idempotency_key = v_key;
  if found then                                              -- a retry: the original result, nothing new written
    if ex.invoice_id = inv.id and ex.reason = v_reason then
      return jsonb_build_object('credit_note_id', ex.document_id, 'number', (select number from documents where id = ex.document_id),
        'already_issued', true);
    end if;
    raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'P0001';
  end if;

  if v_reason = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if inv.status = 'void' then raise exception 'INVOICE_VOID' using errcode = 'P0001'; end if;
  if inv.status <> 'issued' then raise exception 'INVOICE_NOT_PAYABLE' using errcode = 'P0001'; end if;
  select * into s from business_settings;
  if not found then raise exception 'SETTINGS_MISSING' using errcode = 'P0001'; end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'LINES_INVALID' using errcode = 'P0001'; end if;
  n := jsonb_array_length(p_lines);
  for i in 0 .. n - 1 loop
    l := p_lines -> i;
    if jsonb_typeof(l) <> 'object' then raise exception 'LINES_INVALID' using errcode = 'P0001'; end if;
    if btrim(coalesce(l ->> 'description', '')) = '' then raise exception 'DESCRIPTION_REQUIRED' using errcode = 'P0001'; end if;
  end loop;

  -- VAT comes from the INVOICE snapshot: its on/off state and its rate at the time it was issued.
  v_vat_on := coalesce((inv.snapshot -> 'vat' ->> 'enabled')::boolean, false);
  v_rate := case when v_vat_on then (inv.snapshot -> 'vat' ->> 'rate_bp')::bigint else 0 end;
  v_calc := compute_totals(p_lines, 'none', null, v_vat_on, v_rate);
  v_base := (v_calc ->> 'base')::bigint; v_vat := (v_calc ->> 'vat')::bigint; v_total := (v_calc ->> 'total')::bigint;
  if not can_issue(v_total) then raise exception 'TOTAL_NOT_ABOVE_ZERO' using errcode = 'P0001'; end if;

  -- Cap, never against one's own invoice (non-Owner), fresh MFA.
  perform require_capability('creditnotes.issue', v_total, inv.created_by);

  v_earlier := invoice_credited_kobo(inv.id); v_settled := invoice_settled_kobo(inv.id); v_adjusted := invoice_adjusted_kobo(inv.id);
  v_remaining := inv.total_kobo - v_earlier;
  if v_total > v_remaining then raise exception 'CREDIT_EXCEEDS_INVOICE' using errcode = 'P0001'; end if;
  v_balance := inv.total_kobo - v_earlier - v_settled - v_adjusted;
  if v_total > v_balance then raise exception 'CREDIT_BELOW_PAYMENTS' using errcode = 'P0001'; end if;

  for i in 0 .. n - 1 loop
    l := p_lines -> i;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('sn', i + 1, 'description', btrim(l ->> 'description'),
      'qty_milli', l ->> 'qty_milli', 'unit_kobo', l ->> 'unit_kobo', 'line_total', v_calc -> 'line_totals' ->> i));
  end loop;

  v_year := extract(year from (p_now at time zone 'Africa/Lagos'))::int;
  v_issue := (p_now at time zone 'Africa/Lagos')::date;
  v_number := next_document_number('credit_note', v_year);
  select p.full_name into v_name from profiles p where p.user_id = auth.uid();

  v_snap := jsonb_build_object(
    'version', 1,
    'document', jsonb_build_object('type', 'credit_note', 'number', v_number, 'issue_date', v_issue,
      'invoice_id', inv.id, 'invoice_number', inv.number, 'reason', v_reason),
    'business', jsonb_build_object('name', s.business_name, 'address', s.address, 'phone', s.phone, 'email', s.email,
      'registration_number', s.registration_number, 'tin', s.tin),
    'customer', inv.snapshot -> 'customer',
    'creator_name', v_name,
    'vat', jsonb_build_object('enabled', v_vat_on, 'rate_bp', case when v_vat_on then v_rate else null end, 'amount', v_vat::text),
    'lines', v_lines,
    'totals', jsonb_build_object('subtotal', v_calc ->> 'subtotal', 'vat', v_vat::text, 'total', v_total::text),
    'effect_on_invoice', jsonb_build_object('invoice_total', inv.total_kobo::text, 'earlier_credits', v_earlier::text,
      'this_credit', v_total::text, 'net_invoice', (inv.total_kobo - v_earlier - v_total)::text,
      'paid_to_date', (v_settled + v_adjusted)::text, 'balance_due', (v_balance - v_total)::text),
    'calc_version', 1);

  select z.o_prev, z.o_hash, z.o_seq into v_prev, v_hash, v_seq from chain_stamp(v_snap) z;

  insert into documents (doc_type, status, customer_id, created_by, vat_enabled, number, number_year, issue_date, issued_at, issued_by,
                         snapshot, snapshot_hash, prev_hash, chain_seq, subtotal_kobo, discount_kobo, base_kobo, vat_kobo, total_kobo,
                         calc_version, source_document_id, notes)
  values ('credit_note', 'issued', inv.customer_id, auth.uid(), v_vat_on, v_number, v_year, v_issue, p_now, auth.uid(),
          v_snap, v_hash, v_prev, v_seq, (v_calc ->> 'subtotal')::bigint, 0, v_base, v_vat, v_total, 1, inv.id, v_reason)
  returning id into v_id;
  insert into credit_note_requests (created_by, idempotency_key, invoice_id, reason, document_id)
  values (auth.uid(), v_key, inv.id, v_reason, v_id);
  insert into render_jobs (document_id, reason) values (v_id, 'issue');
  perform write_audit('ISSUE_CREDIT_NOTE', v_id::text, null,
    jsonb_build_object('number', v_number, 'invoice_number', inv.number, 'total_kobo', v_total::text, 'vat_kobo', v_vat::text,
      'reason', v_reason, 'snapshot_hash', v_hash));
  return jsonb_build_object('credit_note_id', v_id, 'number', v_number, 'total', v_total::text, 'vat', v_vat::text,
    'net_invoice', (inv.total_kobo - v_earlier - v_total)::text, 'balance_after', (v_balance - v_total)::text, 'already_issued', false);
end $$;

create function issue_credit_note(p_key text, p_invoice_id uuid, p_lines jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_full_access();
  return issue_credit_core(p_key, p_invoice_id, p_lines, p_reason, now());
end $$;

-- 5. Void rules: credit notes cannot be voided here, and an invoice with credit notes cannot be voided. ---------------
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
  if d.doc_type = 'credit_note' then raise exception 'CREDIT_NOTE_VOID_UNSUPPORTED' using errcode = 'P0001'; end if;
  if d.status <> 'issued' then raise exception 'STATUS_NOT_VOIDABLE' using errcode = 'P0001'; end if;
  if d.doc_type = 'invoice' and (invoice_settled_kobo(d.id) > 0 or invoice_adjusted_kobo(d.id) > 0) then
    raise exception 'VOID_BLOCKED_PAYMENTS' using errcode = 'P0001';
  end if;
  if d.doc_type = 'invoice' and invoice_credited_kobo(d.id) > 0 then
    raise exception 'VOID_BLOCKED_CREDIT_NOTES' using errcode = 'P0001';
  end if;
  update documents set status = 'void', void_reason = btrim(p_reason), voided_at = now(), voided_by = auth.uid(), updated_at = now()
  where id = d.id;
  perform write_audit('VOID_DOCUMENT', d.id::text, jsonb_build_object('status', 'issued', 'number', d.number),
    jsonb_build_object('status', 'void', 'number', d.number, 'reason', btrim(p_reason)));
end $$;

-- 6. Privileges -----------------------------------------------------------------------------------------------------
alter table credit_note_requests enable row level security;
revoke all on credit_note_requests from public, anon, authenticated;

revoke execute on function issue_credit_core(text, uuid, jsonb, text, timestamptz), issue_credit_note(text, uuid, jsonb, text)
  from public, anon;
revoke execute on function issue_credit_core(text, uuid, jsonb, text, timestamptz) from authenticated;
grant execute on function issue_credit_note(text, uuid, jsonb, text) to authenticated;
