// Roles, capabilities, caps, four-eyes, fresh MFA, deactivation and audit (Playbook section 10.1).
// Expected values are literals or computed in JavaScript, never by the SQL under test.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const STAFF = '00000000-0000-0000-0000-0000000000a2';
const CASHIER = '00000000-0000-0000-0000-0000000000a3';
const NEWBIE = '00000000-0000-0000-0000-0000000000a4';
const DEV = '00000000-0000-0000-0000-0000000000d1';
const GHOST = '00000000-0000-0000-0000-0000000000ff';
const MAX_BIGINT = '9223372036854775807';
const db = new PGlite();
let passed = 0;

const nowSec = () => Math.floor(Date.now() / 1000);
// mfaAgeSec: undefined = no second factor at all; a number = a TOTP check that many seconds ago.
const as = async (uid, role, fn, mfaAgeSec) => {
  const claims = mfaAgeSec === undefined
    ? { aal: 'aal1', amr: [{ method: 'password', timestamp: nowSec() }] }
    : { aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - mfaAgeSec }, { method: 'password', timestamp: nowSec() - 5000 }] };
  await db.exec(`select set_config('app.uid', '${uid}', false)`);
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false)`);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.exec(`select set_config('app.uid', '', false)`);
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
  }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const owner = (sql, params, age = 10) => as(OWNER, 'authenticated', () => q(sql, params), age);
const staff = (sql, params, age) => as(STAFF, 'authenticated', () => q(sql, params), age);
const cashier = (sql, params, age = 10) => as(CASHIER, 'authenticated', () => q(sql, params), age);
const roleId = async (name) => (await q('select id from roles where name = $1', [name]))[0].id;
const setSub = (periodEnd) => db.exec(`delete from subscription; insert into subscription(plan, current_period_end) values ('annual', '${periodEnd}')`);

// ---- harness stubs (Supabase provides these) ----
await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users(id) values ('${OWNER}'), ('${STAFF}'), ('${CASHIER}'), ('${NEWBIE}'), ('${DEV}');
`);
for (const f of ['0000_profiles.sql', '0001_subscription.sql', '0002_roles_audit.sql']) {
  await db.exec(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
}
await db.exec(`
  insert into commercial_config(trial_days, grace_days, reminder_days, price_notice_days) values (14, 7, '{30,7,1}', 30);
  insert into plan_prices(effective_from, annual_fee_kobo) values ('2000-01-01', 100000000);
  insert into platform_admins(user_id) values ('${DEV}');
`);
await setSub('2099-01-01T00:00:00Z');
// Bootstrap (done once by the Developer at go-live): the Owner profile, then two staff through the Owner's own RPC.
await db.exec(`insert into profiles(user_id, full_name, role, role_id)
  values ('${OWNER}', 'Ngozi Eze', 'owner', (select id from roles where is_owner))`);
const STAFF_ROLE = await roleId('Staff');
const CASHIER_ROLE = await roleId('Cashier');
const OWNER_ROLE = await roleId('Owner');
await owner('select assign_role($1, $2, $3)', [STAFF, 'Chinedu Eze', STAFF_ROLE]);
await owner('select assign_role($1, $2, $3)', [CASHIER, 'Ada Obi', CASHIER_ROLE]);

await t('R1 catalogue: 20 capabilities, 9 delegable, 3 safeguarded, 8 owner-only', async () => {
  const rows = await q('select delegation, count(*)::int as n from capabilities group by delegation order by delegation');
  assert.deepEqual(rows, [{ delegation: 'delegable', n: 9 }, { delegation: 'owner_only', n: 8 }, { delegation: 'safeguarded', n: 3 }]);
});

await t('R2 default roles hold exactly the section 10.1 capabilities; Owner holds all', async () => {
  const caps = async (name) => (await q('select rc.capability from role_capabilities rc join roles r on r.id = rc.role_id where r.name = $1 order by 1', [name])).map((r) => r.capability);
  assert.deepEqual(await caps('Staff'), ['customers.manage', 'draft.create_own']);
  assert.deepEqual(await caps('Sales lead'), ['customers.manage', 'documents.share', 'draft.create_own', 'draft.view_all', 'reports.view']);
  assert.deepEqual(await caps('Accountant'), ['draft.view_all', 'payments.record_evidence', 'reports.view', 'vat.change_per_document']);
  assert.deepEqual(await caps('Cashier'), ['payments.confirm', 'payments.record_evidence']);
  assert.deepEqual(await caps('Deputy approver'), ['documents.approve_issue', 'draft.view_all']);
  assert.deepEqual(await caps('Owner'), []);
  assert.equal((await owner('select count(*)::int as n from capabilities where has_capability(code)'))[0].n, 20);
  assert.equal((await staff('select has_capability($1) as h', ['draft.create_own'], 10))[0].h, true);
  assert.equal((await staff('select has_capability($1) as h', ['payments.confirm'], 10))[0].h, false);
  assert.equal((await staff('select has_capability($1) as h', ['no.such.capability'], 10))[0].h, false);
  assert.equal((await q('select count(*)::int as n from roles where is_owner'))[0].n, 1);
});

await t('R3 database triggers refuse an Owner-only capability on a non-Owner role and a cap on a non-money capability', async () => {
  await assert.rejects(() => db.query("insert into role_capabilities(role_id, capability) values ($1, 'settings.manage')", [STAFF_ROLE]), /OWNER_ONLY_CAPABILITY/);
  await assert.rejects(() => db.query("insert into role_capabilities(role_id, capability) values ($1, 'waybill.cancel')", [CASHIER_ROLE]), /OWNER_ONLY_CAPABILITY/);
  await assert.rejects(() => db.query("insert into role_capabilities(role_id, capability, cap_kobo) values ($1, 'reports.view', 5)", [STAFF_ROLE]), /CAP_NOT_ALLOWED/);
  await assert.rejects(() => db.query("update roles set name = 'Boss' where is_owner"), /OWNER_ROLE_LOCKED/);
  await assert.rejects(() => db.query('delete from roles where is_owner'), /OWNER_ROLE_LOCKED/);
  await assert.rejects(() => db.query("update capabilities set delegation = 'delegable' where code = 'roles.manage'"), /INSERT_ONLY_TABLE/);
});

await t('R4 save_role: Owner only, fresh MFA, valid catalogue, audited with the capability and its cap', async () => {
  const caps = JSON.stringify([{ capability: 'payments.confirm', cap_kobo: 50000000 }, { capability: 'payments.record_evidence' }]);
  await assert.rejects(() => staff('select save_role(null, $1, $2::jsonb)', ['Junior cashier', caps], 10), /CAPABILITY_DENIED/);
  await assert.rejects(() => as(OWNER, 'authenticated', () => q('select save_role(null, $1, $2::jsonb)', ['Junior cashier', caps])), /MFA_REQUIRED/);
  await assert.rejects(() => owner('select save_role(null, $1, $2::jsonb)', ['Junior cashier', caps], 3600), /MFA_REQUIRED/);
  const bad = (c) => owner('select save_role(null, $1, $2::jsonb)', ['Bad role', JSON.stringify(c)]);
  await assert.rejects(() => bad([{ capability: 'settings.manage' }]), /OWNER_ONLY_CAPABILITY/);
  await assert.rejects(() => bad([{ capability: 'payments.confirm' }]), /CAP_REQUIRED/);
  await assert.rejects(() => bad([{ capability: 'payments.confirm', cap_kobo: 0 }]), /CAP_INVALID/);
  await assert.rejects(() => bad([{ capability: 'reports.view', cap_kobo: 100 }]), /CAP_NOT_ALLOWED/);
  await assert.rejects(() => bad([{ capability: 'not.real' }]), /UNKNOWN_CAPABILITY/);
  await assert.rejects(() => bad([{ capability: 'reports.view' }, { capability: 'reports.view' }]), /DUPLICATE_CAPABILITY/);
  await assert.rejects(() => owner('select save_role(null, $1, $2::jsonb)', ['  ', '[]']), /NAME_REQUIRED/);
  await assert.rejects(() => owner('select save_role(null, $1, $2::jsonb)', ['X', '{}']), /CAPS_INVALID/);
  await assert.rejects(() => owner('select save_role($1, $2, $3::jsonb)', [OWNER_ROLE, 'Owner', '[]']), /OWNER_ROLE_LOCKED/);
  assert.equal((await q("select count(*)::int as n from roles where name = 'Bad role'"))[0].n, 0);
  const [{ id }] = await owner('select save_role(null, $1, $2::jsonb) as id', ['Junior cashier', caps]);
  const [a] = await q("select actor, action, before, after from audit_log where action = 'SAVE_ROLE' and subject = $1", [id]);
  assert.equal(a.actor, OWNER);
  assert.equal(a.before, null);
  assert.deepEqual(a.after.capabilities, [{ capability: 'payments.confirm', cap_kobo: 50000000 }, { capability: 'payments.record_evidence', cap_kobo: null }]);
  await assert.rejects(() => owner('select save_role(null, $1, $2::jsonb)', ['junior CASHIER', '[]']), /roles_name_unique/);
});

await t('R5 assign_role: never the Owner role, never the Owner or Developer account, audited before and after', async () => {
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [NEWBIE, 'New Person', OWNER_ROLE]), /OWNER_ROLE_NOT_ASSIGNABLE/);
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [OWNER, 'Ngozi Eze', STAFF_ROLE]), /OWNER_PROFILE_LOCKED/);
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [DEV, 'Dev', STAFF_ROLE]), /RESERVED_ACCOUNT/);
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [GHOST, 'Ghost', STAFF_ROLE]), /foreign key/);
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [NEWBIE, 'New Person', '00000000-0000-0000-0000-000000000000']), /ROLE_NOT_FOUND/);
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [NEWBIE, ' ', STAFF_ROLE]), /NAME_REQUIRED/);
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [NEWBIE, 'New Person', STAFF_ROLE], 3600), /MFA_REQUIRED/);
  await assert.rejects(() => staff('select assign_role($1, $2, $3)', [NEWBIE, 'New Person', CASHIER_ROLE], 10), /CAPABILITY_DENIED/);
  assert.equal((await q('select count(*)::int as n from profiles where user_id = $1', [NEWBIE]))[0].n, 0);
  await owner('select assign_role($1, $2, $3)', [NEWBIE, 'New Person', STAFF_ROLE]);
  await owner('select assign_role($1, $2, $3)', [NEWBIE, 'New Person', CASHIER_ROLE]);
  const rows = await q("select before, after from audit_log where action = 'ASSIGN_ROLE' and subject = $1 order by id", [NEWBIE]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].before, null);
  assert.equal(rows[0].after.role_id, STAFF_ROLE);
  assert.equal(rows[1].before.role_id, STAFF_ROLE);
  assert.equal(rows[1].after.role_id, CASHIER_ROLE);
});

await t('R6 caps and four-eyes: a safeguarded capability with no cap has no authority; cap boundary is inclusive', async () => {
  const gate = (amount, createdBy, age = 10) => cashier('select require_capability($1, $2, $3)', ['payments.confirm', amount, createdBy], age);
  assert.equal(String((await cashier('select capability_cap_kobo($1) as c', ['payments.confirm']))[0].c), '0');
  await assert.rejects(() => gate(1, OWNER), /OVER_CAP/);
  const [{ id }] = await q("select id from roles where name = 'Cashier'");
  await owner('select save_role($1, $2, $3::jsonb)', [id, 'Cashier', JSON.stringify([{ capability: 'payments.confirm', cap_kobo: 20000000 }, { capability: 'payments.record_evidence' }])]);
  assert.equal(String((await cashier('select capability_cap_kobo($1) as c', ['payments.confirm']))[0].c), '20000000');
  await gate(20000000, OWNER);
  await assert.rejects(() => gate(20000001, OWNER), /OVER_CAP/);
  await assert.rejects(() => gate(100, CASHIER), /FOUR_EYES/);
  await assert.rejects(() => gate(null, OWNER), /AMOUNT_REQUIRED/);
  await assert.rejects(() => gate(100, OWNER, 3600), /MFA_REQUIRED/);
  await assert.rejects(() => cashier('select require_capability($1, $2, $3)', ['documents.approve_issue', 100, OWNER]), /CAPABILITY_DENIED/);
  await assert.rejects(() => cashier('select require_capability($1)', ['settings.manage']), /CAPABILITY_DENIED/);
  await cashier('select require_capability($1)', ['payments.record_evidence']);
  assert.equal((await cashier('select capability_cap_kobo($1) as c', ['reports.view']))[0].c, null);
  assert.equal(String((await owner('select capability_cap_kobo($1) as c', ['documents.approve_issue']))[0].c), MAX_BIGINT);
  await owner('select require_capability($1, $2, $3)', ['documents.approve_issue', 1000000000000, OWNER]);
  await assert.rejects(() => owner('select require_capability($1, $2, $3)', ['documents.approve_issue', 1, OWNER], 3600), /MFA_REQUIRED/);
});

await t('R7 deactivate_user: immediate, allowed in read-only mode, never the Owner, needs fresh MFA', async () => {
  await assert.rejects(() => owner('select deactivate_user($1)', [CASHIER], 3600), /MFA_REQUIRED/);
  await assert.rejects(() => staff('select deactivate_user($1)', [CASHIER], 10), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select deactivate_user($1)', [OWNER]), /OWNER_CANNOT_BE_DEACTIVATED/);
  await assert.rejects(() => owner('select deactivate_user($1)', [GHOST]), /USER_NOT_FOUND/);
  await setSub(new Date(Date.now() - 864e5).toISOString());
  await assert.rejects(() => owner('select save_role(null, $1, $2::jsonb)', ['Blocked', '[]']), /ACCESS_GRACE/);
  await assert.rejects(() => owner('select assign_role($1, $2, $3)', [GHOST, 'Ghost', STAFF_ROLE]), /ACCESS_GRACE/);
  assert.equal((await cashier('select has_capability($1) as h', ['payments.record_evidence']))[0].h, true);
  await owner('select deactivate_user($1)', [CASHIER]);
  assert.equal((await cashier('select has_capability($1) as h', ['payments.record_evidence']))[0].h, false);
  await assert.rejects(() => cashier('select require_capability($1, $2, $3)', ['payments.confirm', 1, OWNER]), /CAPABILITY_DENIED/);
  await setSub('2099-01-01T00:00:00Z');
  const [a] = await q("select before, after from audit_log where action = 'DEACTIVATE_USER' and subject = $1", [CASHIER]);
  assert.equal(a.before.active, true);
  assert.equal(a.after.active, false);
  await owner('select assign_role($1, $2, $3)', [CASHIER, 'Ada Obi', CASHIER_ROLE]);
  assert.equal((await cashier('select has_capability($1) as h', ['payments.record_evidence']))[0].h, true);
});

await t('R8 exactly one active Owner and the identity class must match the role', async () => {
  await db.exec(`insert into auth.users(id) values ('00000000-0000-0000-0000-0000000000a9')`);
  await assert.rejects(() => db.query("insert into profiles(user_id, full_name, role, role_id) values ('00000000-0000-0000-0000-0000000000a9', 'Second Owner', 'owner', $1)", [OWNER_ROLE]), /profiles_one_active_owner/);
  await assert.rejects(() => db.query("insert into profiles(user_id, full_name, role, role_id) values ('00000000-0000-0000-0000-0000000000a9', 'Sneaky', 'staff', $1)", [OWNER_ROLE]), /PROFILE_ROLE_MISMATCH/);
  await assert.rejects(() => db.query("insert into profiles(user_id, full_name, role, role_id) values ('00000000-0000-0000-0000-0000000000a9', 'Sneaky', 'owner', $1)", [STAFF_ROLE]), /PROFILE_ROLE_MISMATCH/);
});

await t('R9 tamper: no direct writes for the Owner or Staff, audit log is insert-only and Owner-readable only', async () => {
  const denied = /permission denied/;
  await assert.rejects(() => owner("update profiles set role = 'owner' where user_id = $1", [STAFF]), denied);
  await assert.rejects(() => owner('update roles set name = $1', ['x']), denied);
  await assert.rejects(() => owner("insert into role_capabilities(role_id, capability) values ($1, 'reports.view')", [STAFF_ROLE]), denied);
  await assert.rejects(() => owner('delete from role_capabilities'), denied);
  await assert.rejects(() => owner('delete from audit_log'), denied);
  await assert.rejects(() => staff("update profiles set role_id = $1 where user_id = $2", [CASHIER_ROLE, STAFF], 10), denied);
  await assert.rejects(() => staff("select write_audit('X', 'y', null, null)", undefined, 10), denied);
  await assert.rejects(() => owner("select write_audit('X', 'y', null, null)"), denied);
  await assert.rejects(() => db.exec("update audit_log set action = 'x'"), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('delete from audit_log'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('truncate audit_log'), /INSERT_ONLY_TABLE/);
  assert.ok((await owner('select * from audit_log')).length >= 6);
  assert.equal((await staff('select * from audit_log', undefined, 10)).length, 0);
});

await t('R10 visibility: Owner sees all roles and profiles; staff see only their own', async () => {
  assert.ok((await owner('select * from roles')).length >= 7);
  assert.equal((await owner('select * from profiles')).length, 4);
  const mine = await staff('select * from profiles', undefined, 10);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].user_id, STAFF);
  assert.equal((await staff('select * from roles', undefined, 10)).length, 1);
  assert.deepEqual((await staff('select capability from role_capabilities order by 1', undefined, 10)).map((r) => r.capability), ['customers.manage', 'draft.create_own']);
  assert.equal((await staff('select * from capabilities', undefined, 10)).length, 20);
});

console.log(`\n${passed} vector groups passed`);
