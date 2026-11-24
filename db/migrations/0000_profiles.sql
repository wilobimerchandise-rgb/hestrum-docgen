-- 0000_profiles.sql: Hestrum DocGen Playbook v6.0, section 10.1 (staff profiles).
-- Run FIRST: 0001_subscription.sql reads this table in its row policies.
-- Assumes Supabase: the auth.users table exists. Single business, so there is no tenant column.
-- role is the identity class only: 'owner' (exactly one active) or 'staff'. What a staff member may do comes from role_id
-- (added in 0002_roles_audit.sql). The hidden Developer is never a profile: it lives in platform_admins (0001).

create table profiles (
  user_id uuid primary key references auth.users (id) on delete restrict,
  full_name text not null check (btrim(full_name) <> ''),
  role text not null check (role in ('owner', 'staff')),
  role_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At least one, and at most one, active Owner. Replacing the Owner is the identity-checked recovery process, not the app.
create unique index profiles_one_active_owner on profiles (role) where role = 'owner' and active;

alter table profiles enable row level security;
revoke all on profiles from public, anon, authenticated;
