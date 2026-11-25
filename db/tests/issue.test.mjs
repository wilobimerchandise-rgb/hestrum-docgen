// Atomic issue, numbering, snapshot, hash chain and authority (Playbook sections 7.2, 7.3, 7.7, 10.1).
// Expected values are literals or computed in JavaScript (including the SHA-256), never by the SQL under test.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const STAFF = '00000000-0000-0000-0000-0000000000a2';
const DEPUTY = '00000000-0000-0000-0000-0000000000a3';
const ZERO = '0'.repeat(64);
const db = new PGlite();
let passed = 0;

const nowSec = () => Math.floor(Date.now() / 1000);
const as = async (uid, role, fn, mfaAgeSec) => {
  const claims = mfaAgeSec === undefined
    ? { aal: 'aal1', amr: [{ method: 'password', timestamp: nowSec() }] }
    : { aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - mfaAgeSec }] };
  await db.exec(`select set_config('app.uid', '${uid}', false)`);
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false)`);
  if (role) await db.exec(`set role ${role}`);
  try { return await fn(); } finally {
    if (role) await db.exec('reset role');
    await db.exec(`select set_config('app.uid', '', false)`);
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
  }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const owner = (sql, params, age = 10) => as(OWNER, 'authenticated', () => q(sql, params), age);
const staff = (sql, params, age = 10) => as(STAFF, 'authenticated', () => q(sql, params), age);
const deputy = (sql, params, age = 10) => as(DEPUTY, 'authenticated', () => q(sql, params), age);
const core = (id, at, uid = OWNER) => as(uid, null, async () => (await q('select issue_core($1::uuid, $2::timestamptz) as n', [id, at]))[0].n, 10);
const setSub = (periodEnd) => db.exec(`delete from subscription; insert into subscription(plan, current_period_end) values ('annual', '${periodEnd}')`);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const lagosToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
const counter = async (type, year) => String((await q('select last_value from document_counters where doc_type = $1 and year = $2', [type, year]))[0]?.last_value ?? 0);
const auditCount = async () => (await q("select count(*)::int as n from audit_log where action = 'ISSUE_DOCUMENT'"))[0].n;

// ---- harness stubs (Supabase provides these) ----
await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users(id) values ('${OWNER}'), ('${STAFF}'), ('${DEPUTY}');
`);
for (const f of ['0000_profiles.sql', '0001_subscription.sql', '0002_roles_audit.sql', '0003_money.sql', '0004_documents_issue.sql']) {
  await db.exec(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
}
await db.exec(`
  insert into commercial_config(trial_days, grace_days, reminder_days, price_notice_days) values (14, 7, '{30,7,1}', 30);
  insert into plan_prices(effective_from, annual_fee_kobo) values ('2000-01-01', 100000000);
  insert into profiles(user_id, full_name, role, role_id) values ('${OWNER}', 'Ngozi Eze', 'owner', (select id from roles where is_owner));
  insert into business_settings(business_name, address, phone, email, registration_number, tin, vat_enabled, vat_rate_bp, bank_name, account_name, account_number)
    values ('Hestrum Projects & Services Limited', '12 Example Road, Port Harcourt, Rivers State', '0803 000 0000', 'accounts@example.com',
            'RC 0000000', '00000000-0001', true, 750, 'Example Bank Plc', 'Hestrum Projects & Services Limited', '0000000000');
  insert into customers(id, name, billing_address, phone, created_by)
    values ('11111111-1111-1111-1111-111111111111', 'Adaeze Okafor Ventures', '45 Sample Street, GRA Phase 2, Port Harcourt', '0802 000 0000', '${OWNER}');
`);
await setSub('2099-01-01T00:00:00Z');
const CUST = '11111111-1111-1111-1111-111111111111';
const STAFF_ROLE = (await q("select id from roles where name = 'Staff'"))[0].id;
const DEPUTY_ROLE = (await q("select id from roles where name = 'Deputy approver'"))[0].id;
await owner('select assign_role($1, $2, $3)', [STAFF, 'Chinedu Eze', STAFF_ROLE]);
await owner('select assign_role($1, $2, $3)', [DEPUTY, 'Ada Obi', DEPUTY_ROLE]);
await owner('select save_role($1, $2, $3::jsonb)', [DEPUTY_ROLE, 'Deputy approver',
  JSON.stringify([{ capability: 'draft.view_all' }, { capability: 'documents.approve_issue', cap_kobo: 20000000 }])]); // cap N200,000.00

const G1 = [[3000, 4500000], [1000, 1250050]];
let seq = 0;
const mkDoc = async ({ type = 'invoice', status = 'pending_approval', by = STAFF, lines = G1, vat = true, kind = 'percent', value = 1000, terms = 14, validUntil = null } = {}) => {
  const id = crypto.randomUUID();
  await db.query(`insert into documents(id, doc_type, status, customer_id, created_by, discount_kind, discount_value, vat_enabled, payment_terms_days, valid_until, po_reference, notes)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PO-' || $11::text, 'Test note')`,
    [id, type, status, CUST, by, kind, kind === 'none' ? null : value, vat, terms, validUntil, ++seq]);
  for (const [i, [qty, price]] of lines.entries()) {
    await db.query('insert into document_lines(document_id, position, description, qty_milli, unit_kobo) values ($1, $2, $3, $4, $5)', [id, i + 1, `Item ${i + 1}`, qty, price]);
  }
  return id;
};
const row = async (id) => (await q(`select status, number, number_year, to_char(issue_date, 'YYYY-MM-DD') as issue_date, to_char(due_date, 'YYYY-MM-DD') as due_date,
  total_kobo::text as total, subtotal_kobo::text as subtotal, discount_kobo::text as discount, base_kobo::text as base, vat_kobo::text as vat,
  snapshot, snapshot::text as snap_text, snapshot_hash, prev_hash, chain_seq, issued_by from documents where id = $1`, [id]))[0];

const NOW1 = '2026-11-25T10:00:00Z';
let docA; let hashA;

await t('I1 issue an invoice (vector G1): number, dates, totals, frozen snapshot, audit, render job, hash computed in JavaScript', async () => {
  docA = await mkDoc();
  const number = await core(docA, NOW1);
  assert.equal(number, 'INV-2026-0001');
  const r = await row(docA);
  assert.deepEqual([r.status, r.number, r.number_year, r.issue_date, r.due_date], ['issued', 'INV-2026-0001', 2026, '2026-11-25', '2026-12-09']);
  assert.deepEqual([r.subtotal, r.discount, r.base, r.vat, r.total], ['14750050', '1475005', '13275045', '995628', '14270673']);
  assert.equal(r.issued_by, OWNER);
  const s = r.snapshot;
  assert.equal(s.business.name, 'Hestrum Projects & Services Limited');
  assert.deepEqual(s.bank, { bank_name: 'Example Bank Plc', account_name: 'Hestrum Projects & Services Limited', account_number: '0000000000' });
  assert.equal(s.customer.name, 'Adaeze Okafor Ventures');
  assert.equal(s.creator_name, 'Chinedu Eze');
  assert.equal(s.approved_by_name, 'Ngozi Eze');
  assert.deepEqual(s.vat, { enabled: true, rate_bp: 750, amount: '995628' });
  assert.deepEqual(s.lines.map((l) => [l.sn, l.line_total]), [[1, '13500000'], [2, '1250050']]);
  assert.deepEqual(s.totals, { subtotal: '14750050', discount: '1475005', base: '13275045', vat: '995628', total: '14270673' });
  assert.equal(s.document.number, 'INV-2026-0001');
  assert.equal(s.document.po_reference, 'PO-1');
  assert.equal(r.prev_hash, ZERO);
  hashA = sha(ZERO + '|' + r.snap_text);
  assert.equal(r.snapshot_hash, hashA);
  const jobs = await q("select status, reason, attempts from render_jobs where document_id = $1", [docA]);
  assert.deepEqual(jobs, [{ status: 'queued', reason: 'issue', attempts: 0 }]);
  const [a] = await q("select actor, subject, after from audit_log where action = 'ISSUE_DOCUMENT' and subject = $1", [docA]);
  assert.equal(a.actor, OWNER);
  assert.deepEqual([a.after.number, a.after.total_kobo, a.after.snapshot_hash], ['INV-2026-0001', '14270673', hashA]);
  assert.equal(await counter('invoice', 2026), '1');
});

await t('I2 numbering: own sequence per type, Lagos year boundary, retired numbers never reused, digits grow past 9999', async () => {
  const qte = await mkDoc({ type: 'quotation', validUntil: '2026-12-25', terms: null });
  assert.equal(await core(qte, NOW1), 'QTN-2026-0001');
  const b = await mkDoc();
  assert.equal(await core(b, NOW1), 'INV-2026-0002');
  await db.query("update documents set status = 'void' where id = $1", [b]);
  const c = await mkDoc();
  assert.equal(await core(c, '2026-12-31T22:59:59Z'), 'INV-2026-0003');
  assert.equal((await row(c)).issue_date, '2026-12-31');
  const d = await mkDoc();
  assert.equal(await core(d, '2026-12-31T23:00:00Z'), 'INV-2027-0001');
  assert.equal((await row(d)).issue_date, '2027-01-01');
  await db.exec("insert into document_counters(doc_type, year, last_value) values ('invoice', 2028, 9999)");
  const e = await mkDoc();
  assert.equal(await core(e, '2028-06-01T10:00:00Z'), 'INV-2028-10000');
  assert.equal((await row(qte)).due_date, null);
  assert.equal(await counter('invoice', 2026), '3');
});

await t('I3 atomic: a failure after the number is taken rolls everything back, and the retry gets the same number (no gap)', async () => {
  const e = await mkDoc();
  const before = { counter: await counter('invoice', 2026), audit: await auditCount(), chain: (await q('select count(*)::int as n from documents where chain_seq is not null'))[0].n };
  await db.exec(`create function boom() returns trigger language plpgsql as $$ begin raise exception 'TEST_BOOM'; end $$;
                 create trigger boom_t before insert on render_jobs for each row execute function boom();`);
  await assert.rejects(() => core(e, '2026-12-05T10:00:00Z'), /TEST_BOOM/);
  const r = await row(e);
  assert.deepEqual([r.status, r.number, r.snapshot, r.snapshot_hash], ['pending_approval', null, null, null]);
  assert.equal(await counter('invoice', 2026), before.counter);
  assert.equal(await auditCount(), before.audit);
  assert.equal((await q('select count(*)::int as n from documents where chain_seq is not null'))[0].n, before.chain);
  await db.exec('drop trigger boom_t on render_jobs; drop function boom()');
  assert.equal(await core(e, '2026-12-05T10:00:00Z'), 'INV-2026-0004');
});

await t('I4 issue rules: each failure leaves no number spent', async () => {
  const fail = async (id, re) => assert.rejects(() => core(id, NOW1), re);
  await fail(await mkDoc({ lines: [[1000, 5000]], kind: 'fixed', value: 5000 }), /TOTAL_NOT_ABOVE_ZERO/);
  await fail(await mkDoc({ lines: [] }), /LINES_COUNT/);
  await fail(await mkDoc({ type: 'quotation', terms: null, validUntil: null }), /VALID_UNTIL_REQUIRED/);
  await fail(await mkDoc({ terms: null }), /TERMS_REQUIRED/);
  await fail(await mkDoc({ lines: [[1000, 100]], kind: 'percent', value: 9001 }), /DISCOUNT_PERCENT_RANGE/);
  await fail(crypto.randomUUID(), /DOCUMENT_NOT_FOUND/);
  const notAuthed = await mkDoc();
  await assert.rejects(() => as('', null, async () => q('select issue_core($1::uuid, now())', [notAuthed]), 10), /NOT_AUTHENTICATED|invalid input syntax/);
  await db.exec('update business_settings set tin = null');
  await fail(await mkDoc(), /VAT_COMPLIANCE_MISSING/);
  await db.exec("update business_settings set tin = '00000000-0001', vat_enabled = false");
  await fail(await mkDoc({ vat: true }), /VAT_DISABLED/);
  await db.exec("update business_settings set vat_enabled = true, account_number = null");
  await fail(await mkDoc(), /BANK_DETAILS_MISSING/);
  await db.exec("update business_settings set account_number = '0000000000'");
  assert.equal(await counter('invoice', 2026), '4');
  assert.equal(await counter('quotation', 2026), '1');
});

await t('I5 idempotent: issuing an issued document returns the same number and writes nothing new', async () => {
  const audits = await auditCount();
  const jobs = (await q('select count(*)::int as n from render_jobs'))[0].n;
  assert.equal(await core(docA, '2027-05-05T10:00:00Z'), 'INV-2026-0001');
  assert.equal(await auditCount(), audits);
  assert.equal((await q('select count(*)::int as n from render_jobs'))[0].n, jobs);
  assert.equal(await counter('invoice', 2026), '4');
});

await t('I6 authority through approve_and_issue: capability, cap, four-eyes, fresh MFA, full access, status', async () => {
  const mine = await mkDoc({ by: STAFF });
  await assert.rejects(() => staff('select approve_and_issue($1)', [mine]), /CAPABILITY_DENIED/);
  await assert.rejects(() => deputy('select approve_and_issue($1)', [mine], 3600), /MFA_REQUIRED/);
  const draft = await mkDoc({ by: STAFF, status: 'draft' });
  await assert.rejects(() => deputy('select approve_and_issue($1)', [draft]), /STATUS_NOT_ISSUABLE/);
  const big = await mkDoc({ by: STAFF, lines: [[1000, 30000000]] });                       // total over the N200,000.00 cap
  await assert.rejects(() => deputy('select approve_and_issue($1)', [big]), /OVER_CAP/);
  const own = await mkDoc({ by: DEPUTY });
  await assert.rejects(() => deputy('select approve_and_issue($1)', [own]), /FOUR_EYES/);
  await assert.rejects(() => owner('select approve_and_issue($1)', [mine], 3600), /MFA_REQUIRED/);
  await setSub(new Date(Date.now() - 864e5).toISOString());
  await assert.rejects(() => owner('select approve_and_issue($1)', [mine]), /ACCESS_GRACE/);
  await setSub('2099-01-01T00:00:00Z');
  assert.equal((await row(mine)).status, 'pending_approval');
  const before = await counter('invoice', Number(lagosToday().slice(0, 4)));
  const [{ approve_and_issue: n1 }] = await deputy('select approve_and_issue($1)', [mine]);
  const year = Number(lagosToday().slice(0, 4));
  assert.match(n1, new RegExp(`^INV-${year}-\\d{4,}$`));
  assert.equal(String(Number(before) + 1), await counter('invoice', year));
  const r = await row(mine);
  assert.equal(r.status, 'issued');
  assert.equal(r.issue_date, lagosToday());
  assert.equal(r.issued_by, DEPUTY);
  assert.equal(r.snapshot.approved_by_name, 'Ada Obi');
  const [{ approve_and_issue: again }] = await deputy('select approve_and_issue($1)', [mine]);
  assert.equal(again, n1);
  const ownersOwn = await mkDoc({ by: OWNER, status: 'draft' });
  const [{ approve_and_issue: n2 }] = await owner('select approve_and_issue($1)', [ownersOwn]);
  assert.match(n2, /^INV-\d{4}-\d{4,}$/);
  assert.equal((await row(ownersOwn)).snapshot.creator_name, 'Ngozi Eze');
});

await t('I7 an issued document is frozen: snapshot, number, money, lines and delete are refused; only void and accept paths remain', async () => {
  const frozen = async (sql, params) => assert.rejects(() => db.query(sql, params), /DOCUMENT_IMMUTABLE/);
  await frozen("update documents set number = 'INV-2026-9999' where id = $1", [docA]);
  await frozen("update documents set total_kobo = 1 where id = $1", [docA]);
  await frozen("update documents set snapshot = '{}'::jsonb where id = $1", [docA]);
  await frozen("update documents set notes = 'changed' where id = $1", [docA]);
  await frozen("update documents set po_reference = 'other' where id = $1", [docA]);
  await frozen('delete from documents where id = $1', [docA]);
  await frozen("update document_lines set unit_kobo = 1 where document_id = $1", [docA]);
  await frozen("insert into document_lines(document_id, position, description, qty_milli, unit_kobo) values ($1, 9, 'late', 1000, 1)", [docA]);
  await frozen('delete from document_lines where document_id = $1', [docA]);
  await assert.rejects(() => db.query("update documents set status = 'draft' where id = $1", [docA]), /STATUS_TRANSITION_INVALID|violates check/);
  await assert.rejects(() => db.query("update documents set status = 'accepted' where id = $1", [docA]), /violates check constraint/);
  await assert.rejects(() => db.query("insert into documents(id, doc_type, status, customer_id, created_by) values (gen_random_uuid(), 'invoice', 'issued', $1, $2)", [CUST, OWNER]), /violates check constraint/);
  const draft = await mkDoc({ status: 'draft' });
  await db.query("update documents set notes = 'edit ok' where id = $1", [draft]);
  await db.query('update document_lines set unit_kobo = 7 where document_id = $1', [draft]);
  await db.query('delete from documents where id = $1', [draft]);
  assert.equal((await q('select count(*)::int as n from documents where id = $1', [draft]))[0].n, 0);
  await assert.rejects(() => db.query("insert into documents(id, doc_type, customer_id, created_by, number) values (gen_random_uuid(), 'invoice', $1, $2, 'INV-2026-0001')", [CUST, OWNER]), /violates check constraint|duplicate key/);
  await db.query("update documents set status = 'void' where id = $1", [(await q("select id from documents where number = 'QTN-2026-0001'"))[0].id]);
});

await t('I8 hash chain: each snapshot links to the previous; verification passes, then detects an edit', async () => {
  const rows = await q('select number, prev_hash, snapshot_hash, snapshot::text as snap, chain_seq from documents where chain_seq is not null order by chain_seq');
  assert.ok(rows.length >= 9, `chain length ${rows.length}`);
  let prev = ZERO;
  for (const r of rows) {
    assert.equal(r.prev_hash, prev, r.number);
    assert.equal(r.snapshot_hash, sha(prev + '|' + r.snap), r.number);
    prev = r.snapshot_hash;
  }
  assert.equal(rows[0].number, 'INV-2026-0001');
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, true);
  await db.exec('alter table documents disable trigger documents_guard_row');
  await db.exec(`update documents set snapshot = jsonb_set(snapshot, '{totals,total}', '"1"') where number = 'INV-2026-0001'`);
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, false);
  await db.exec(`update documents set snapshot = jsonb_set(snapshot, '{totals,total}', '"14270673"') where number = 'INV-2026-0001'`);
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, true);
  await db.exec(`update documents set prev_hash = '${'f'.repeat(64)}' where number = 'INV-2026-0003'`);
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, false);
});

await t('I9 tamper and visibility: no direct writes for anyone, internals are not callable, reads follow ownership and capability', async () => {
  const denied = /permission denied/;
  await assert.rejects(() => owner("update documents set status = 'void'"), denied);
  await assert.rejects(() => owner("insert into documents(doc_type, customer_id, created_by) values ('invoice', $1, $2)", [CUST, OWNER]), denied);
  await assert.rejects(() => owner('delete from document_counters'), denied);
  await assert.rejects(() => owner("update document_counters set last_value = 0"), denied);
  await assert.rejects(() => owner("update business_settings set account_number = '1111111111'"), denied);
  await assert.rejects(() => owner('select * from render_jobs'), denied);
  await assert.rejects(() => owner('select nextval(\'document_chain_seq\')'), denied);
  await assert.rejects(() => owner('select issue_core($1::uuid, now())', [docA]), denied);
  await assert.rejects(() => owner('select next_document_number($1, 2026)', ['invoice']), denied);
  await assert.rejects(() => owner('select verify_snapshot_chain()'), denied);
  await assert.rejects(() => as(OWNER, 'anon', () => q('select approve_and_issue($1)', [docA]), 10), denied);
  const mineStaff = await staff('select id from documents');
  assert.ok(mineStaff.length >= 1);
  const staffCreated = (await q('select count(*)::int as n from documents where created_by = $1', [STAFF]))[0].n;
  assert.equal(mineStaff.length, staffCreated);
  assert.equal((await deputy('select id from documents')).length, (await q('select count(*)::int as n from documents'))[0].n);
  assert.equal((await staff('select * from customers')).length, 0);
  assert.equal((await owner('select * from customers')).length, 1);
  assert.equal((await staff('select * from business_settings')).length, 1);
  assert.ok((await staff('select * from document_lines')).length >= 2);
});

console.log(`\n${passed} vector groups passed`);
