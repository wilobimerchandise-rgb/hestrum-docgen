-- 0002_roles_audit.sql: Hestrum DocGen Playbook v6.0, section 10.1 (roles and capabilities) and the audit log (10.3, Prevent).
-- Run after 0000_profiles.sql and 0001_subscription.sql (it reuses forbid_change() and require_full_access()).
-- The Owner assigns roles to staff, but only from this fixed catalogue. Owner-only capabilities can never be delegated.
-- Writes to roles and assignments exist only as the RPCs save_role, assign_role and deactivate_user.

-- 1. Capability catalogue (fixed; changed only by a later migration) --------------------------------------------
create table capabilities (
  code text primary key,
  delegation text not null check (delegation in ('delegable', 'safeguarded', 'owner_only')),
  description text not null
);

insert into capabilities (code, delegation, description) values
  ('draft.create_own',            'delegable',   'Create, edit and submit own drafts; Draft PDF preview'),
  ('draft.view_all',              'delegable',   'See all drafts and submissions, not only one''s own'),
  ('customers.manage',            'delegable',   'Pick, add and edit customers'),
  ('reports.view',                'delegable',   'Dashboard and receivables ageing'),
  ('payments.record_evidence',    'delegable',   'Record a payment as pending verification'),
  ('documents.share',             'delegable',   'Share issued documents by WhatsApp, email or link'),
  ('vat.change_per_document',     'delegable',   'Switch VAT on or off for one document'),
  ('waybill.issue',               'delegable',   'Issue a waybill (no money involved, audited)'),
  ('waybill.deliver',             'delegable',   'Mark a waybill delivered (no money involved, audited)'),
  ('documents.approve_issue',     'safeguarded', 'Approve and issue; per-document kobo cap, never own drafts, fresh MFA'),
  ('payments.confirm',            'safeguarded', 'Confirm a payment and create the receipt; per-payment cap, never own invoice, fresh MFA'),
  ('creditnotes.issue',           'safeguarded', 'Issue credit notes; cap, never against own invoice, fresh MFA'),
  ('roles.manage',                'owner_only',  'Create roles, assign roles, add and deactivate staff'),
  ('settings.manage',             'owner_only',  'Branding, bank details, VAT, numbering prefixes, short-pay cap, signature and stamp'),
  ('documents.void',              'owner_only',  'Void a document'),
  ('payments.reverse',            'owner_only',  'Reverse a payment'),
  ('data.export',                 'owner_only',  'Full exports'),
  ('audit.view',                  'owner_only',  'Read the audit log'),
  ('subscription.view',           'owner_only',  'Subscription and maintenance summaries'),
  ('waybill.cancel',              'owner_only',  'Cancel a waybill; reason required');

create trigger capabilities_insert_only before update or delete on capabilities
  for each row execute function forbid_change();

-- 2. Roles and their capabilities ---------------------------------------------------------------------------------
create table roles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index roles_name_unique on roles (lower(btrim(name)));
create unique index roles_one_owner on roles (is_owner) where is_owner;

-- The Owner role carries every capability implicitly and has no rows here.
-- cap_kobo exists only for safeguarded capabilities. A NULL cap means "no authority yet" (treated as zero).
create table role_capabilities (
  role_id uuid not null references roles (id) on delete cascade,
  capability text not null references capabilities (code),
  cap_kobo bigint check (cap_kobo is null or cap_kobo > 0),
  primary key (role_id, capability)
);

create function roles_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.is_owner then raise exception 'OWNER_ROLE_LOCKED' using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.is_owner then raise exception 'OWNER_ROLE_LOCKED' using errcode = 'P0001'; end if;
  if new.is_owner then raise exception 'OWNER_ROLE_LOCKED' using errcode = 'P0001'; end if;
  return new;
end $$;

create trigger roles_guard_row before update or delete on roles
  for each row execute function roles_guard();

-- A trigger refuses to attach an Owner-only capability to any role other than Owner, even for a superuser insert.
create function role_capabilities_guard() returns trigger language plpgsql as $$
declare d text; owner_role boolean;
begin
  select delegation into d from capabilities where code = new.capability;
  select is_owner into owner_role from roles where id = new.role_id;
  if d = 'owner_only' and not coalesce(owner_role, false) then
    raise exception 'OWNER_ONLY_CAPABILITY %', new.capability using errcode = 'P0001';
  end if;
  if d <> 'safeguarded' and new.cap_kobo is not null then
    raise exception 'CAP_NOT_ALLOWED %', new.capability using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger role_capabilities_guard_row before insert or update on role_capabilities
  for each row execute function role_capabilities_guard();

-- 3. Profiles gain their role. The identity class must agree with the role. ------------------------------------
alter table profiles add constraint profiles_role_id_fk foreign key (role_id) references roles (id);

create function profiles_role_guard() returns trigger language plpgsql as $$
declare owner_role boolean;
begin
  select is_owner into owner_role from roles where id = new.role_id;
  if owner_role is null or (new.role = 'owner') <> owner_role then
    raise exception 'PROFILE_ROLE_MISMATCH' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger profiles_role_guard_row before insert or update on profiles
  for each row execute function profiles_role_guard();

-- 4. Audit log: insert-only (prevent). Written only by the functions below. --------------------------------------
create table audit_log (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null,
  subject text not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create trigger audit_log_insert_only before update or delete on audit_log
  for each row execute function forbid_change();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function forbid_change();

create function write_audit(p_action text, p_subject text, p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = public, pg_temp as
$$ insert into audit_log(actor, action, subject, before, after) values (auth.uid(), p_action, p_subject, p_before, p_after) $$;

-- 5. Seed roles: Owner (fixed) and the default roles from section 10.1 ------------------------------------------
-- Cashier and Deputy approver hold a safeguarded capability with NO cap yet: they cannot act until the Owner sets one.
insert into roles (name, is_owner) values ('Owner', true);
insert into roles (name) values ('Staff'), ('Sales lead'), ('Accountant'), ('Cashier'), ('Deputy approver');

insert into role_capabilities (role_id, capability, cap_kobo)
select r.id, v.capability, null
from (values
  ('Staff', 'draft.create_own'), ('Staff', 'customers.manage'),
  ('Sales lead', 'draft.create_own'), ('Sales lead', 'customers.manage'), ('Sales lead', 'draft.view_all'),
  ('Sales lead', 'reports.view'), ('Sales lead', 'documents.share'),
  ('Accountant', 'draft.view_all'), ('Accountant', 'reports.view'), ('Accountant', 'payments.record_evidence'),
  ('Accountant', 'vat.change_per_document'),
  ('Cashier', 'payments.record_evidence'), ('Cashier', 'payments.confirm'),
  ('Deputy approver', 'draft.view_all'), ('Deputy approver', 'documents.approve_issue')
) as v(role_name, capability)
join roles r on r.name = v.role_name;

-- 6. Checks used by every RPC and row policy --------------------------------------------------------------------
create function is_owner() returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'owner' and p.active) $$;

-- True only for an active user who holds the capability. The Owner holds every catalogue capability.
create function has_capability(p_code text) returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(
     case
       when not exists (select 1 from capabilities c where c.code = p_code) then false
       when is_owner() then true
       else exists (
         select 1 from profiles p join role_capabilities rc on rc.role_id = p.role_id
         where p.user_id = auth.uid() and p.active and rc.capability = p_code)
     end, false) $$;

-- Cap in kobo for a safeguarded capability. 0 = no authority (not held, or no cap set yet).
-- The Owner is not capped (largest bigint). NULL = the capability has no money cap by design.
create function capability_cap_kobo(p_code text) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d text; v bigint;
begin
  select delegation into d from capabilities where code = p_code;
  if d is null or d <> 'safeguarded' then return null; end if;
  if not has_capability(p_code) then return 0; end if;
  if is_owner() then return 9223372036854775807; end if;
  select coalesce(rc.cap_kobo, 0) into v
  from profiles p join role_capabilities rc on rc.role_id = p.role_id
  where p.user_id = auth.uid() and p.active and rc.capability = p_code;
  return coalesce(v, 0);
end $$;

-- Fresh second factor: the JWT amr claim must hold a totp or webauthn entry no older than p_max_age_seconds.
create function fresh_mfa(p_max_age_seconds int default 300) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare claims jsonb;
begin
  claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if claims is null then return false; end if;
  return exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(claims -> 'amr') = 'array' then claims -> 'amr' else '[]'::jsonb end) a
    where a ->> 'method' in ('totp', 'webauthn', 'mfa/totp', 'mfa/webauthn')
      and (a ->> 'timestamp') ~ '^[0-9]+$'
      and extract(epoch from now()) - (a ->> 'timestamp')::bigint between -60 and p_max_age_seconds);
end $$;

create function require_fresh_mfa() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not fresh_mfa() then raise exception 'MFA_REQUIRED' using errcode = 'P0001'; end if;
end $$;

-- Gate for business RPCs. Safeguarded capabilities also need fresh MFA; a non-Owner is held to the cap and four-eyes.
--   p_amount_kobo : the document or payment amount (required for safeguarded capabilities)
--   p_created_by  : who created the document or payment being acted on
create function require_capability(p_code text, p_amount_kobo bigint default null, p_created_by uuid default null)
returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d text;
begin
  if auth.uid() is null or not has_capability(p_code) then
    raise exception 'CAPABILITY_DENIED %', p_code using errcode = '42501';
  end if;
  select delegation into d from capabilities where code = p_code;
  if d = 'safeguarded' then
    if not fresh_mfa() then raise exception 'MFA_REQUIRED' using errcode = 'P0001'; end if;
    if not is_owner() then
      if p_created_by is not null and p_created_by = auth.uid() then
        raise exception 'FOUR_EYES' using errcode = 'P0001';
      end if;
      if p_amount_kobo is null then raise exception 'AMOUNT_REQUIRED' using errcode = 'P0001'; end if;
      if p_amount_kobo > capability_cap_kobo(p_code) then raise exception 'OVER_CAP' using errcode = 'P0001'; end if;
    end if;
  end if;
end $$;

create function role_snapshot(p_role_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as
$$ select jsonb_build_object('id', r.id, 'name', r.name, 'capabilities',
     coalesce((select jsonb_agg(jsonb_build_object('capability', rc.capability, 'cap_kobo', rc.cap_kobo) order by rc.capability)
               from role_capabilities rc where rc.role_id = r.id), '[]'::jsonb))
   from roles r where r.id = p_role_id $$;

-- 7. Owner RPCs (the only write path) ---------------------------------------------------------------------------
-- p_caps: JSON array of {"capability": "...", "cap_kobo": 123}. Replaces the role's capabilities. p_role_id null creates.
create function save_role(p_role_id uuid, p_name text, p_caps jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_before jsonb; c record; d text; seen text[] := '{}';
begin
  perform require_full_access();
  perform require_capability('roles.manage');
  perform require_fresh_mfa();
  if btrim(coalesce(p_name, '')) = '' then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if p_caps is null or jsonb_typeof(p_caps) <> 'array' then raise exception 'CAPS_INVALID' using errcode = 'P0001'; end if;
  for c in select * from jsonb_to_recordset(p_caps) as x(capability text, cap_kobo bigint) loop
    select delegation into d from capabilities where code = c.capability;
    if d is null then raise exception 'UNKNOWN_CAPABILITY %', c.capability using errcode = 'P0001'; end if;
    if c.capability = any (seen) then raise exception 'DUPLICATE_CAPABILITY %', c.capability using errcode = 'P0001'; end if;
    seen := seen || c.capability;
    if d = 'owner_only' then raise exception 'OWNER_ONLY_CAPABILITY %', c.capability using errcode = 'P0001'; end if;
    if d = 'safeguarded' then
      if c.cap_kobo is null then raise exception 'CAP_REQUIRED %', c.capability using errcode = 'P0001'; end if;
      if c.cap_kobo <= 0 then raise exception 'CAP_INVALID %', c.capability using errcode = 'P0001'; end if;
    elsif c.cap_kobo is not null then
      raise exception 'CAP_NOT_ALLOWED %', c.capability using errcode = 'P0001';
    end if;
  end loop;
  if p_role_id is null then
    insert into roles (name) values (btrim(p_name)) returning id into v_id;
    v_before := null;
  else
    select id into v_id from roles where id = p_role_id for update;
    if v_id is null then raise exception 'ROLE_NOT_FOUND' using errcode = 'P0001'; end if;
    if (select is_owner from roles where id = v_id) then raise exception 'OWNER_ROLE_LOCKED' using errcode = 'P0001'; end if;
    v_before := role_snapshot(v_id);
    update roles set name = btrim(p_name), updated_at = now() where id = v_id;
    delete from role_capabilities where role_id = v_id;
  end if;
  insert into role_capabilities (role_id, capability, cap_kobo)
    select v_id, x.capability, x.cap_kobo from jsonb_to_recordset(p_caps) as x(capability text, cap_kobo bigint);
  perform write_audit('SAVE_ROLE', v_id::text, v_before, role_snapshot(v_id));
  return v_id;
end $$;

-- Give one person (new or existing) a non-Owner role. The Owner profile and the Developer account are never touched.
create function assign_role(p_user_id uuid, p_full_name text, p_role_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old profiles%rowtype; v_found boolean; v_is_owner_role boolean;
begin
  perform require_full_access();
  perform require_capability('roles.manage');
  perform require_fresh_mfa();
  if p_user_id is null then raise exception 'USER_REQUIRED' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_full_name, '')) = '' then raise exception 'NAME_REQUIRED' using errcode = 'P0001'; end if;
  if exists (select 1 from platform_admins where user_id = p_user_id) then
    raise exception 'RESERVED_ACCOUNT' using errcode = 'P0001';
  end if;
  select is_owner into v_is_owner_role from roles where id = p_role_id;
  if not found then raise exception 'ROLE_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_is_owner_role then raise exception 'OWNER_ROLE_NOT_ASSIGNABLE' using errcode = 'P0001'; end if;
  select * into v_old from profiles where user_id = p_user_id for update;
  v_found := found;
  if v_found and v_old.role = 'owner' then raise exception 'OWNER_PROFILE_LOCKED' using errcode = 'P0001'; end if;
  insert into profiles (user_id, full_name, role, role_id) values (p_user_id, btrim(p_full_name), 'staff', p_role_id)
    on conflict (user_id) do update
      set full_name = excluded.full_name, role_id = excluded.role_id, active = true, updated_at = now();
  perform write_audit('ASSIGN_ROLE', p_user_id::text,
    case when v_found then to_jsonb(v_old) else null end,
    (select to_jsonb(p) from profiles p where p.user_id = p_user_id));
end $$;

-- A security action: works at once and is allowed in read-only mode, so it does not call require_full_access().
create function deactivate_user(p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old profiles%rowtype;
begin
  perform require_capability('roles.manage');
  perform require_fresh_mfa();
  select * into v_old from profiles where user_id = p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_old.role = 'owner' then raise exception 'OWNER_CANNOT_BE_DEACTIVATED' using errcode = 'P0001'; end if;
  update profiles set active = false, updated_at = now() where user_id = p_user_id;
  perform write_audit('DEACTIVATE_USER', p_user_id::text, to_jsonb(v_old),
    (select to_jsonb(p) from profiles p where p.user_id = p_user_id));
end $$;

-- 8. Privileges and row-level security --------------------------------------------------------------------------
alter table capabilities enable row level security;
alter table roles enable row level security;
alter table role_capabilities enable row level security;
alter table audit_log enable row level security;

revoke all on capabilities, roles, role_capabilities, audit_log from public, anon, authenticated;
grant select on capabilities, roles, role_capabilities, audit_log, profiles to authenticated;

create policy capabilities_read on capabilities for select to authenticated using (true);

-- The Owner sees everyone; anyone else sees only their own profile and role.
create policy profiles_read on profiles for select to authenticated
  using (user_id = auth.uid() or is_owner());
create policy roles_read on roles for select to authenticated
  using (is_owner() or id = (select p.role_id from profiles p where p.user_id = auth.uid()));
create policy role_capabilities_read on role_capabilities for select to authenticated
  using (is_owner() or role_id = (select p.role_id from profiles p where p.user_id = auth.uid()));
create policy audit_log_read on audit_log for select to authenticated using (has_capability('audit.view'));

revoke execute on function
  is_owner(), has_capability(text), capability_cap_kobo(text), fresh_mfa(int), require_fresh_mfa(),
  require_capability(text, bigint, uuid), role_snapshot(uuid), write_audit(text, text, jsonb, jsonb),
  save_role(uuid, text, jsonb), assign_role(uuid, text, uuid), deactivate_user(uuid)
  from public, anon;
grant execute on function
  is_owner(), has_capability(text), capability_cap_kobo(text), fresh_mfa(int), require_capability(text, bigint, uuid),
  save_role(uuid, text, jsonb), assign_role(uuid, text, uuid), deactivate_user(uuid)
  to authenticated;
revoke execute on function require_fresh_mfa(), role_snapshot(uuid), write_audit(text, text, jsonb, jsonb) from authenticated;
