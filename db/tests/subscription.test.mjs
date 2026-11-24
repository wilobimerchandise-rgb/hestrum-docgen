// Vectors S1-S8 for Appendix B. Expected values are literals or computed in JavaScript, not by the SQL under test.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const OWNER = '00000000-0000-0000-0000-000000000001';
const STAFF = '00000000-0000-0000-0000-000000000002';
const DEV = '00000000-0000-0000-0000-000000000003';
const db = new PGlite();
let passed = 0;

const as = async (uid, role, fn) => {
  await db.exec(`select set_config('app.uid', '${uid}', false)`);
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); await db.exec(`select set_config('app.uid', '', false)`); }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const access = async (at) => (await q('select mode, reason from app_access($1::timestamptz)', [at]))[0];
const setSub = (cols) => db.exec(`delete from subscription; insert into subscription(${Object.keys(cols).join(',')}) values (${Object.values(cols).map((v) => (v === null ? 'null' : `'${v}'`)).join(',')})`);
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const dev = (sql, params) => as(DEV, 'authenticated', () => q(sql, params));

// ---- harness stubs (Supabase provides these) ----
await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create table profiles(user_id uuid primary key, role text not null, active boolean not null default true);
  insert into profiles values ('${OWNER}', 'owner', true), ('${STAFF}', 'staff', true);
  grant select on profiles to authenticated;
`);
await db.exec(fs.readFileSync(new URL('../migrations/0001_subscription.sql', import.meta.url), 'utf8'));
await db.exec(`
  insert into commercial_config(trial_days, grace_days, reminder_days, price_notice_days) values (14, 7, '{30,7,1}', 30);
  insert into plan_prices(effective_from, annual_fee_kobo) values ('2000-01-01', 100000000);
  insert into platform_admins(user_id) values ('${DEV}');
`);
const PRICE = 100000000;

await t('S5 fail closed: no subscription row, then no config row', async () => {
  assert.deepEqual(await access('2030-01-01'), { mode: 'blocked', reason: 'NO_SUBSCRIPTION' });
  await setSub({ plan: 'annual', current_period_end: '2030-06-01T00:00:00Z' });
  await db.exec('create table cfg_backup as select * from commercial_config; delete from commercial_config');
  assert.deepEqual(await access('2030-01-01'), { mode: 'blocked', reason: 'NO_CONFIG' });
  await db.exec('insert into commercial_config select * from cfg_backup; drop table cfg_backup');
});

await t('S1 active: full before the period end and exactly at it', async () => {
  await setSub({ plan: 'annual', current_period_end: '2030-06-01T00:00:00Z' });
  assert.deepEqual(await access('2030-05-31T23:59:59Z'), { mode: 'full', reason: 'ACTIVE' });
  assert.deepEqual(await access('2030-06-01T00:00:00Z'), { mode: 'full', reason: 'ACTIVE' });
});

await t('S2 grace: read_only from 1 microsecond after the end to exactly 7 days, then blocked', async () => {
  assert.deepEqual(await access('2030-06-01T00:00:00.000001Z'), { mode: 'read_only', reason: 'GRACE' });
  assert.deepEqual(await access('2030-06-08T00:00:00Z'), { mode: 'read_only', reason: 'GRACE' });
  assert.deepEqual(await access('2030-06-08T00:00:00.000001Z'), { mode: 'blocked', reason: 'EXPIRED' });
});

await t('S3 paused: blocked even when fully paid up', async () => {
  await setSub({ plan: 'annual', current_period_end: '2099-06-01T00:00:00Z', paused_at: '2030-01-01T00:00:00Z', pause_reason: 'ABUSE' });
  assert.deepEqual(await access('2030-05-31T00:00:00Z'), { mode: 'blocked', reason: 'PAUSED' });
});

await t('S4 trial: full, then the same grace, then blocked', async () => {
  await setSub({ plan: 'trial', trial_ends_at: '2030-01-15T00:00:00Z' });
  assert.deepEqual(await access('2030-01-14T00:00:00Z'), { mode: 'full', reason: 'TRIAL' });
  assert.deepEqual(await access('2030-01-16T00:00:00Z'), { mode: 'read_only', reason: 'GRACE' });
  assert.deepEqual(await access('2030-01-22T00:00:00Z'), { mode: 'read_only', reason: 'GRACE' });
  assert.deepEqual(await access('2030-01-22T00:00:00.000001Z'), { mode: 'blocked', reason: 'EXPIRED' });
});

await t('start_subscription: trial of 14 days, once only, needs reason and ticket', async () => {
  await db.exec('delete from subscription');
  await assert.rejects(() => dev("select start_subscription(0, '', 'T-1')"), /REASON_REQUIRED/);
  await assert.rejects(() => dev("select start_subscription(0, 'go-live', '')"), /TICKET_REQUIRED/);
  await dev("select start_subscription(0, 'go-live', 'T-1')");
  const [s] = await q('select plan, trial_ends_at from subscription');
  const days = (s.trial_ends_at.getTime() - Date.now()) / 864e5;
  assert.equal(s.plan, 'trial');
  assert.ok(days > 13.99 && days <= 14.001, `trial days ${days}`);
  await assert.rejects(() => dev("select start_subscription(0, 'again', 'T-2')"), /SUBSCRIPTION_EXISTS/);
});

await t('S6 renewal math: early renew adds 12 months to the end; trial renew starts at trial end; late renew restarts today', async () => {
  await setSub({ plan: 'annual', current_period_end: '2099-03-15T00:00:00Z' });
  const [e] = await dev("select renew_subscription('REF-EARLY', $1, 'early renewal', 'T-3') as e", [PRICE]);
  assert.equal(e.e.toISOString(), new Date(Date.UTC(2100, 2, 15)).toISOString());
  await setSub({ plan: 'trial', trial_ends_at: '2099-01-10T00:00:00Z' });
  const [tr] = await dev("select renew_subscription('REF-TRIAL', $1, 'pay in trial', 'T-4') as e", [PRICE]);
  assert.equal(tr.e.toISOString(), new Date(Date.UTC(2100, 0, 10)).toISOString());
  await setSub({ plan: 'annual', current_period_end: '2020-01-01T00:00:00Z' });
  const [late] = await dev("select renew_subscription('REF-LATE', $1, 'late renewal', 'T-5') as e", [PRICE]);
  const want = new Date(); want.setUTCFullYear(want.getUTCFullYear() + 1);
  assert.ok(Math.abs(late.e.getTime() - want.getTime()) < 2 * 864e5, 'late renewal restarts from today');
});

await t('S7 idempotency, underpayment, pause lifting and price notice', async () => {
  await setSub({ plan: 'annual', current_period_end: '2099-03-15T00:00:00Z' });
  const first = (await dev("select renew_subscription('REF-IDEM', $1, 'renewal', 'T-6') as e", [PRICE]))[0].e;
  const again = (await dev("select renew_subscription('REF-IDEM', $1, 'replay', 'T-6') as e", [PRICE]))[0].e;
  assert.equal(first.toISOString(), again.toISOString());
  assert.equal((await q("select count(*)::int as n from subscription_payments where payment_ref = 'REF-IDEM'"))[0].n, 1);
  assert.equal((await q('select current_period_end as e from subscription'))[0].e.toISOString(), first.toISOString());
  await assert.rejects(() => dev("select renew_subscription('REF-LOW', $1, 'short', 'T-7')", [PRICE - 1]), /AMOUNT_BELOW_PRICE/);
  await dev("select pause_access('NON_PAYMENT', 'unpaid after grace', 'T-8')");
  assert.equal((await q('select paused_at from subscription'))[0].paused_at !== null, true);
  await dev("select renew_subscription('REF-PAID', $1, 'paid late', 'T-9')", [PRICE]);
  assert.equal((await q('select paused_at from subscription'))[0].paused_at, null);
  await dev("select pause_access('ABUSE', 'abuse confirmed', 'T-10')");
  await dev("select renew_subscription('REF-ABUSE', $1, 'paid but abusive', 'T-11')", [PRICE]);
  assert.equal((await q('select pause_reason from subscription'))[0].pause_reason, 'ABUSE');
  await assert.rejects(() => dev("select pause_access('BECAUSE', 'x', 'T-12')"), /PAUSE_CODE_INVALID/);
  await dev("select unpause_access('resolved', 'T-13')");
  await assert.rejects(() => dev("select set_annual_price(now() + interval '10 days', 120000000, 'new price', 'T-14')"), /PRICE_NOTICE_TOO_SHORT/);
  await dev("select set_annual_price(now() + interval '31 days', 120000000, 'new price', 'T-15')");
  assert.equal(Number((await q('select current_annual_fee_kobo() as p'))[0].p), PRICE);
  assert.equal(Number((await q("select current_annual_fee_kobo(now() + interval '32 days') as p"))[0].p), 120000000);
});

await t('S8a tamper: Owner and Staff cannot write or read what they must not', async () => {
  await setSub({ plan: 'annual', current_period_end: '2099-03-15T00:00:00Z' });
  const owner = (fn) => as(OWNER, 'authenticated', fn);
  assert.equal((await owner(() => q('select * from subscription'))).length, 1);
  await assert.rejects(() => owner(() => q("update subscription set current_period_end = '2199-01-01'")), /permission denied/);
  await assert.rejects(() => owner(() => q('delete from subscription')), /permission denied/);
  await assert.rejects(() => owner(() => q("insert into subscription_payments(payment_ref, amount_kobo, price_snapshot_kobo, period_start, period_end, recorded_by) values ('x', 1, 1, now(), now(), gen_random_uuid())")), /permission denied/);
  await assert.rejects(() => owner(() => q('select * from maintenance_log')), /permission denied/);
  await assert.rejects(() => owner(() => q('select * from platform_admins')), /permission denied/);
  await assert.rejects(() => owner(() => q("select renew_subscription('FORGED', 100000000, 'forged', 'T-0')")), /NOT_PLATFORM_ADMIN/);
  await assert.rejects(() => as(STAFF, 'authenticated', () => q("select renew_subscription('FORGED', 100000000, 'forged', 'T-0')")), /NOT_PLATFORM_ADMIN/);
  assert.equal((await as(STAFF, 'authenticated', () => q('select * from subscription'))).length, 0);
  assert.equal((await as(STAFF, 'authenticated', () => q('select * from maintenance_summary'))).length, 0);
  await assert.rejects(() => as(DEV, 'authenticated', () => q('select * from platform_admins')), /permission denied/);
  await assert.rejects(() => as(DEV, 'anon', () => q("select renew_subscription('ANON', 100000000, 'anon', 'T-0')")), /permission denied/);
  const summary = await owner(() => q('select label, action from maintenance_summary'));
  assert.ok(summary.length > 0 && summary.every((r) => r.label === 'Platform maintenance'));
  assert.equal((await q("select count(*)::int as n from pg_proc where proname ilike '%shorten%'"))[0].n, 0);
});

await t('S8b write gate in the database: a direct insert fails outside full access mode', async () => {
  await db.exec(`
    create table demo_drafts(id serial primary key, note text);
    alter table demo_drafts enable row level security;
    grant select, insert on demo_drafts to authenticated; grant usage on sequence demo_drafts_id_seq to authenticated;
    create policy demo_read on demo_drafts for select to authenticated using (true);
    create policy demo_insert on demo_drafts for insert to authenticated with check (is_full_access());
  `);
  await setSub({ plan: 'annual', current_period_end: '2099-03-15T00:00:00Z' });
  await as(STAFF, 'authenticated', () => q("insert into demo_drafts(note) values ('full mode ok')"));
  await as(STAFF, 'authenticated', () => q('select require_full_access()'));
  await setSub({ plan: 'annual', current_period_end: new Date(Date.now() - 864e5).toISOString() });
  await assert.rejects(() => as(STAFF, 'authenticated', () => q("insert into demo_drafts(note) values ('grace')")), /row-level security/);
  await assert.rejects(() => as(STAFF, 'authenticated', () => q('select require_full_access()')), /ACCESS_GRACE/);
  assert.equal((await as(STAFF, 'authenticated', () => q('select * from demo_drafts'))).length, 1);
});

await t('S8c insert-only records and the hash chain detects an edit', async () => {
  await assert.rejects(() => db.exec("update maintenance_log set reason = 'x'"), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('delete from maintenance_log'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('truncate maintenance_log'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec("update subscription_payments set note = 'x'"), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('delete from plan_prices'), /INSERT_ONLY_TABLE/);
  assert.equal((await q('select verify_maintenance_chain() as ok'))[0].ok, true);
  const n = (await q('select count(*)::int as n from maintenance_log'))[0].n;
  assert.ok(n >= 8, `log rows ${n}`);
  await db.exec('alter table maintenance_log disable trigger maintenance_log_insert_only');
  await db.exec("update maintenance_log set reason = 'tampered' where id = 2");
  assert.equal((await q('select verify_maintenance_chain() as ok'))[0].ok, false);
});

console.log(`\n${passed} vector groups passed`);
