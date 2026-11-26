// Payments, allocation, WHT, receipts, short-pay and reversal (Playbook sections 7.2, 8.4; vectors G7, G8, G9).
// Expected values are literals from the playbook or computed in JavaScript (including SHA-256), never by the SQL under test.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const STAFF = '00000000-0000-0000-0000-0000000000a2';
const DEPUTY = '00000000-0000-0000-0000-0000000000a3';
const ACCT = '00000000-0000-0000-0000-0000000000a7';
const CASH = '00000000-0000-0000-0000-0000000000a8';
const CASH2 = '00000000-0000-0000-0000-0000000000a9';
const MAKER = '00000000-0000-0000-0000-0000000000aa';
const NOBODY = '00000000-0000-0000-0000-000000000099';
const db = new PGlite();
let passed = 0;

const nowSec = () => Math.floor(Date.now() / 1000);
const as = async (uid, role, fn, mfaAgeSec = 10) => {
  const claims = { aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - mfaAgeSec }] };
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
const who = (uid) => (sql, params, age) => as(uid, 'authenticated', () => q(sql, params), age);
const sup = (uid, sql, params, age) => as(uid, null, () => q(sql, params), age);   // superuser with an identity: internal functions only
const owner = who(OWNER); const staff = who(STAFF); const deputy = who(DEPUTY); const acct = who(ACCT);
const cash = who(CASH); const cash2 = who(CASH2); const maker = who(MAKER);
const setSub = (periodEnd) => db.exec(`delete from subscription; insert into subscription(plan, current_period_end) values ('annual', '${periodEnd}')`);
const setCap = (kobo) => db.exec(`update business_settings set short_pay_cap_kobo = ${kobo}`);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const lagosToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
const YEAR = Number(lagosToday().slice(0, 4));
const addDays = (isoDate, n) => new Date(Date.parse(isoDate + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users(id) values ('${OWNER}'), ('${STAFF}'), ('${DEPUTY}'), ('${ACCT}'), ('${CASH}'), ('${CASH2}'), ('${MAKER}');
`);
for (const f of ['0000_profiles.sql', '0001_subscription.sql', '0002_roles_audit.sql', '0003_money.sql', '0004_documents_issue.sql', '0005_drafts_customers.sql', '0006_payments_receipts.sql']) {
  await db.exec(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
}
await db.exec(`
  insert into commercial_config(trial_days, grace_days, reminder_days, price_notice_days) values (14, 7, '{30,7,1}', 30);
  insert into plan_prices(effective_from, annual_fee_kobo) values ('2000-01-01', 100000000);
  insert into profiles(user_id, full_name, role, role_id) values ('${OWNER}', 'Ngozi Eze', 'owner', (select id from roles where is_owner));
  insert into business_settings(business_name, address, registration_number, tin, vat_enabled, vat_rate_bp, bank_name, account_name, account_number)
    values ('Hestrum Projects & Services Limited', '12 Example Road, Port Harcourt, Rivers State', 'RC 0000000', '00000000-0001', true, 750,
            'Example Bank Plc', 'Hestrum Projects & Services Limited', '0000000000');
`);
await setSub('2099-01-01T00:00:00Z');
const roleId = async (n) => (await q('select id from roles where name = $1', [n]))[0].id;
await owner('select save_role($1, $2, $3::jsonb)', [await roleId('Cashier'), 'Cashier',
  JSON.stringify([{ capability: 'payments.record_evidence' }, { capability: 'payments.confirm', cap_kobo: 60000000 }])]);
await owner('select save_role($1, $2, $3::jsonb)', [await roleId('Deputy approver'), 'Deputy approver',
  JSON.stringify([{ capability: 'draft.view_all' }, { capability: 'documents.approve_issue', cap_kobo: 20000000 }])]);
const makerRole = (await owner('select save_role(null, $1, $2::jsonb) as id', ['Maker and checker',
  JSON.stringify([{ capability: 'draft.create_own' }, { capability: 'customers.manage' }, { capability: 'vat.change_per_document' }, { capability: 'payments.record_evidence' },
    { capability: 'payments.confirm', cap_kobo: 60000000 }])]))[0].id;
for (const [uid, name, role] of [[STAFF, 'Chinedu Eze', await roleId('Staff')], [DEPUTY, 'Ada Obi', await roleId('Deputy approver')],
  [ACCT, 'Tunde Ojo', await roleId('Accountant')], [CASH, 'Kemi Adebayo', await roleId('Cashier')],
  [CASH2, 'Femi Lawal', await roleId('Cashier')], [MAKER, 'Ife Okon', makerRole]]) {
  await owner('select assign_role($1, $2, $3)', [uid, name, role]);
}

const today = lagosToday();
const cust = async (name) => (await owner('select create_customer($1, $2) as id', [name, '45 Sample Street, Port Harcourt']))[0].id;
const mkInvoice = async (customer, qtyMilli, unit, doc = {}, by = OWNER) => {
  const body = { doc_type: 'invoice', customer_id: customer, payment_terms_days: 14, vat_enabled: false,
    lines: [{ description: 'Item', qty_milli: qtyMilli, unit_kobo: unit }], ...doc };
  const id = (await who(by)('select save_draft($1, $2::jsonb) as r', [null, JSON.stringify(body)]))[0].r.id;
  await owner('select approve_and_issue($1)', [id]);
  return id;
};
const rec = async (uid, key, customer, amount, ref, method = 'transfer') =>
  (await who(uid)('select record_payment($1, $2, $3, $4, $5::date, $6, $7) as id', [key, customer, String(amount), method, today, ref, null]))[0].id;
const alloc = (...rows) => JSON.stringify(rows.map(([invoice_id, cash_kobo, wht_kobo]) => ({ invoice_id, cash_kobo: String(cash_kobo), wht_kobo: String(wht_kobo ?? 0) })));
const confirmAs = (fn, payId, allocations, note = 'Bank alert checked') =>
  fn('select confirm_payment($1::uuid, $2::jsonb, $3) as r', [payId, allocations, note]).then((r) => r[0].r);
const status = async (id) => (await owner('select invoice_payment_status($1) as r', [id]))[0].r;
const counts = async () => (await q(`select (select count(*) from payment_allocations)::int as a,
  (select count(*) from documents where doc_type = 'receipt')::int as r,
  (select coalesce(sum(last_value), 0) from document_counters where doc_type = 'receipt')::int as c,
  (select count(*) from audit_log)::int as au, (select count(*) from render_jobs)::int as j,
  (select count(*) from payments where status = 'confirmed')::int as p`))[0];
let receipts = 0;     // successful confirmations so far in the current year (receipt numbers must be gapless)
const receiptCounter = async (year = YEAR) => Number((await q("select last_value from document_counters where doc_type = 'receipt' and year = $1", [year]))[0]?.last_value ?? 0);

const K1 = await cust('Adaeze Okafor Ventures');
const K2 = await cust('Other Customer Ltd');
const A = await mkInvoice(K1, '1000', '30000000');   // INV-A, total 30,000,000
const B = await mkInvoice(K1, '1000', '25000000');   // INV-B, total 25,000,000
const C = await mkInvoice(K2, '1000', '50000000');   // another customer's invoice
const D = await mkInvoice(K1, '1000', '50000000');   // will be voided
await owner('select void_document($1, $2)', [D, 'Issued by mistake']);
const draftInv = (await owner('select save_draft(null, $1::jsonb) as r', [JSON.stringify({ doc_type: 'invoice', customer_id: K1, payment_terms_days: 14, vat_enabled: false,
  lines: [{ description: 'Draft', qty_milli: '1000', unit_kobo: '50000000' }] })]))[0].r.id;
const QUOTE = (await owner('select save_draft(null, $1::jsonb) as r', [JSON.stringify({ doc_type: 'quotation', customer_id: K1, valid_until: '2099-01-31', vat_enabled: false,
  lines: [{ description: 'Quote', qty_milli: '1000', unit_kobo: '50000000' }] })]))[0].r.id;
await owner('select approve_and_issue($1)', [QUOTE]);

await t('P1 record_payment: validation, authority, idempotency, duplicate reference; pending settles nothing', async () => {
  const call = (uid, key, c, amt, method, on, ref) =>
    who(uid)('select record_payment($1, $2, $3, $4, $5::date, $6) as id', [key, c, amt, method, on, ref]);
  await assert.rejects(() => call(STAFF, 'k-0', K1, '100', 'transfer', today, 'R-0'), /CAPABILITY_DENIED/);
  await assert.rejects(() => call(NOBODY, 'k-0', K1, '100', 'transfer', today, 'R-0'), /CAPABILITY_DENIED/);
  for (const bad of ['0', '-5', '10.5', 'abc', '', '1000000000001', '1e3', ' 5']) {
    await assert.rejects(() => call(ACCT, 'k-bad', K1, bad, 'transfer', today, 'R-bad'), /AMOUNT_INVALID/, `amount ${bad}`);
  }
  await assert.rejects(() => call(ACCT, 'k-1', K1, '100', 'bitcoin', today, 'R-1'), /METHOD_INVALID/);
  await assert.rejects(() => call(ACCT, 'k-1', K1, '100', 'transfer', addDays(today, 1), 'R-1'), /PAID_ON_FUTURE/);
  await assert.rejects(() => call(ACCT, 'k-1', K1, '100', 'transfer', null, 'R-1'), /PAID_ON_REQUIRED/);
  await assert.rejects(() => call(ACCT, 'k-1', '00000000-0000-0000-0000-000000000000', '100', 'transfer', today, 'R-1'), /CUSTOMER_MISSING/);
  await assert.rejects(() => call(ACCT, 'k-1', null, '100', 'transfer', today, 'R-1'), /CUSTOMER_MISSING/);
  await assert.rejects(() => call(ACCT, '   ', K1, '100', 'transfer', today, 'R-1'), /IDEMPOTENCY_KEY_REQUIRED/);
  await assert.rejects(() => call(ACCT, 'x'.repeat(101), K1, '100', 'transfer', today, 'R-1'), /IDEMPOTENCY_KEY_REQUIRED/);
  assert.equal((await q('select count(*)::int as n from payments'))[0].n, 0);

  const before = await status(A);
  const id1 = (await call(ACCT, 'k-1', K1, '500', 'transfer', today, ' NIP-1 '))[0].id;
  assert.deepEqual(await status(A), before);                                              // pending settles nothing
  const row = (await q('select status, amount_kobo, reference, recorded_by, confirmed_at from payments where id = $1', [id1]))[0];
  assert.deepEqual([row.status, String(row.amount_kobo), row.reference, row.recorded_by, row.confirmed_at], ['pending_verification', '500', 'NIP-1', ACCT, null]);

  assert.equal((await call(ACCT, 'k-1', K1, '500', 'transfer', today, 'NIP-1'))[0].id, id1);   // same key, same payload: original
  await assert.rejects(() => call(ACCT, 'k-1', K1, '501', 'transfer', today, 'NIP-1'), /IDEMPOTENCY_KEY_REUSED/);
  await assert.rejects(() => call(ACCT, 'k-1', K2, '500', 'transfer', today, 'NIP-1'), /IDEMPOTENCY_KEY_REUSED/);
  assert.equal((await q('select count(*)::int as n from payments'))[0].n, 1);
  // Another user using the same key text gets their own payment, never someone else's.
  const idOther = (await call(CASH, 'k-1', K1, '700', 'cash', today, null))[0].id;
  assert.notEqual(idOther, id1);

  await assert.rejects(() => call(ACCT, 'k-2', K1, '500', 'transfer', today, 'nip-1'), /PAYMENT_REFERENCE_DUPLICATE/);
  await assert.rejects(() => call(CASH, 'k-3', K2, '9', 'transfer', today, '  NIP-1  '), /PAYMENT_REFERENCE_DUPLICATE/);
  await call(ACCT, 'k-4', K1, '500', 'pos', today, 'NIP-1');                              // another method may share a reference text
  await call(ACCT, 'k-5', K1, '500', 'cash', today, null);
  await call(ACCT, 'k-6', K1, '500', 'cash', today, null);                                // no reference: no duplicate rule
  assert.equal((await q('select count(*)::int as n from payments'))[0].n, 5);
  assert.equal(String((await q("select amount_kobo from payments where idempotency_key = 'k-1' and recorded_by = $1", [CASH]))[0].amount_kobo), '700');
  assert.equal((await q("select count(*)::int as n from audit_log where action = 'RECORD_PAYMENT'"))[0].n, 5);

  // Read-only mode refuses a financial write.
  await setSub(new Date(Date.now() - 864e5).toISOString());
  await assert.rejects(() => call(ACCT, 'k-9', K1, '100', 'transfer', today, 'R-9'), /ACCESS_/);
  await setSub('2099-01-01T00:00:00Z');
});

let PG8; let receiptG8;
await t('P2 G8: one transfer of 50,000,000 settles INV-A (30,000,000) and INV-B (25,000,000 -> balance 5,000,000); bad sums rejected; failures change nothing', async () => {
  PG8 = await rec(ACCT, 'g8', K1, 50000000, 'NIP-G8-0001');
  assert.equal((await status(A)).balance, '30000000');
  assert.equal((await status(B)).balance, '25000000');
  const ghost = '11111111-1111-1111-1111-111111111111';
  const baseline = await counts();
  const bad = [
    [alloc([A, 29999999], [B, 20000000]), /ALLOCATION_SUM_MISMATCH/],            // 49,999,999
    [alloc([A, 30000000], [B, 20000001]), /ALLOCATION_SUM_MISMATCH/],            // 50,000,001
    [alloc([A, 30000001], [B, 19999999]), /ALLOCATION_EXCEEDS_BALANCE/],         // INV-A only owes 30,000,000
    [alloc([A, 24999999], [B, 25000001]), /ALLOCATION_EXCEEDS_BALANCE/],
    [alloc([A, 25000000], [A, 25000000]), /ALLOCATION_DUPLICATE/],
    [alloc([C, 50000000]), /ALLOCATION_CUSTOMER_MISMATCH/],
    [alloc([D, 50000000]), /INVOICE_VOID/],
    [alloc([draftInv, 50000000]), /INVOICE_NOT_PAYABLE/],
    [alloc([QUOTE, 50000000]), /INVOICE_NOT_PAYABLE/],
    [alloc([ghost, 50000000]), /INVOICE_NOT_FOUND/],
    ['[]', /ALLOCATION_REQUIRED/],
    ['{}', /ALLOCATION_REQUIRED/],
    ['null', /ALLOCATION_REQUIRED/],
    [alloc(['not-a-uuid', 50000000]), /ALLOCATION_INVALID/],
    [alloc([A, 0, 0], [B, 50000000]), /ALLOCATION_INVALID/],
    [alloc([A, '10.5'], [B, 50000000]), /ALLOCATION_INVALID/],
    [alloc([A, '-1'], [B, 50000001]), /ALLOCATION_INVALID/],
    [JSON.stringify([{ invoice_id: A, cash_kobo: '1e7' }]), /ALLOCATION_INVALID/],
  ];
  for (const [a, re] of bad) {
    await assert.rejects(() => confirmAs(owner, PG8, a), re, String(re));
    assert.deepEqual(await counts(), baseline);                                    // atomic: no allocation, receipt, number, audit or job
  }
  await assert.rejects(() => confirmAs(owner, PG8, alloc([A, 30000000], [B, 20000000]), '   '), /VERIFICATION_NOTE_REQUIRED/);
  await assert.rejects(() => confirmAs(owner, ghost, alloc([A, 50000000])), /PAYMENT_NOT_FOUND/);
  assert.deepEqual(await counts(), baseline);
  assert.equal((await q('select status from payments where id = $1', [PG8]))[0].status, 'pending_verification');

  const r = await confirmAs(owner, PG8, alloc([A, 30000000], [B, 20000000]), 'Checked bank alert NIP-G8-0001 on 2026 statement');
  receipts++;
  receiptG8 = r.receipt_id;
  assert.equal(r.receipt_number, `RCP-${YEAR}-0001`);
  assert.equal(r.stamp, 'PART PAID');
  assert.equal(r.already_confirmed, false);
  const a = await status(A); const b = await status(B);
  assert.deepEqual([a.state, a.balance, a.settled], ['paid', '0', '30000000']);
  assert.deepEqual([b.state, b.balance, b.settled], ['partially_paid', '5000000', '20000000']);
  assert.equal(a.overdue, false);

  const d = (await q('select doc_type, status, number, total_kobo, customer_id, payment_id, snapshot, snapshot_hash, prev_hash from documents where id = $1', [receiptG8]))[0];
  assert.deepEqual([d.doc_type, d.status, d.number, String(d.total_kobo), d.customer_id, d.payment_id], ['receipt', 'issued', `RCP-${YEAR}-0001`, '50000000', K1, PG8]);
  assert.equal(d.snapshot.stamp, 'PART PAID');
  assert.deepEqual(d.snapshot.totals, { paid_on_this_receipt: '50000000', wht: '0', settled: '50000000' });
  assert.deepEqual(d.snapshot.payment, { id: PG8, method: 'transfer', paid_on: today, reference: 'NIP-G8-0001', amount: '50000000' });
  assert.equal(d.snapshot.confirmed_by_name, 'Ngozi Eze');
  assert.equal(d.snapshot.customer.name, 'Adaeze Okafor Ventures');
  assert.deepEqual(d.snapshot.applied.map((x) => [x.sn, x.invoice_id, x.invoice_total, x.earlier_paid, x.cash, x.wht, x.balance_after]), [
    [1, A, '30000000', '0', '30000000', '0', '0'],
    [2, B, '25000000', '0', '20000000', '0', '5000000'],
  ]);
  const text = (await q('select snapshot::text as s from documents where id = $1', [receiptG8]))[0].s;
  assert.equal(d.snapshot_hash, sha(d.prev_hash + '|' + text));

  const p = (await q('select status, confirmed_by, verification_note from payments where id = $1', [PG8]))[0];
  assert.deepEqual([p.status, p.confirmed_by, p.verification_note], ['confirmed', OWNER, 'Checked bank alert NIP-G8-0001 on 2026 statement']);
  assert.equal((await q('select count(*)::int as n from payment_allocations where payment_id = $1', [PG8]))[0].n, 2);
  assert.equal((await q("select count(*)::int as n from render_jobs where document_id = $1 and reason = 'issue' and status = 'queued'", [receiptG8]))[0].n, 1);
  assert.equal((await q("select count(*)::int as n from audit_log where action = 'CONFIRM_PAYMENT' and subject = $1", [PG8]))[0].n, 1);
  assert.equal(await receiptCounter(), receipts);
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, true);

  // A retry returns the original result and writes nothing new, even with different allocations.
  const after = await counts();
  const again = await confirmAs(owner, PG8, alloc([B, 50000000]));
  assert.deepEqual([again.receipt_id, again.receipt_number, again.already_confirmed], [receiptG8, `RCP-${YEAR}-0001`, true]);
  assert.deepEqual(await counts(), after);
});

await t('P3 G7 WHT: base 10,000,000, VAT 750,000, total 10,750,000; cash 10,250,000 + WHT 500,000 settles the invoice; credit-note-pending flag', async () => {
  const k = await cust('WHT Customer Ltd');
  const inv = await mkInvoice(k, '1000', '10000000', { vat_enabled: true });
  assert.equal((await status(inv)).total, '10750000');
  const pay = await rec(ACCT, 'g7', k, 10250000, 'NIP-G7-0001');
  const r = await confirmAs(owner, pay, alloc([inv, 10250000, 500000]), 'Checked bank alert; customer deducted 5% WHT on 10,000,000');
  receipts++;
  assert.equal(r.stamp, 'PAID');
  const s = await status(inv);
  assert.deepEqual([s.state, s.balance, s.settled, s.wht, s.wht_credit_note_pending], ['paid', '0', '10750000', '500000', '500000']);
  const snap = (await q('select snapshot from documents where id = $1', [r.receipt_id]))[0].snapshot;
  assert.deepEqual(snap.totals, { paid_on_this_receipt: '10250000', wht: '500000', settled: '10750000' });
  assert.deepEqual([snap.applied[0].cash, snap.applied[0].wht, snap.applied[0].balance_after], ['10250000', '500000', '0']);

  const aid = (await q('select id from payment_allocations where payment_id = $1', [pay]))[0].id;
  await assert.rejects(() => cash('select record_wht_credit_note($1, $2, $3::date)', [aid, 'WHT-CN-1', today]), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select record_wht_credit_note($1, $2, $3::date)', [aid, '  ', today]), /REFERENCE_REQUIRED/);
  await assert.rejects(() => owner('select record_wht_credit_note($1, $2, $3::date)', [aid, 'WHT-CN-1', addDays(today, 1)]), /RECEIVED_ON_INVALID/);
  await assert.rejects(() => owner('select record_wht_credit_note($1, $2, $3::date)', ['11111111-1111-1111-1111-111111111111', 'X', today]), /ALLOCATION_NOT_FOUND/);
  const noWht = (await q('select id from payment_allocations where payment_id = $1', [PG8]))[0].id;
  await assert.rejects(() => owner('select record_wht_credit_note($1, $2, $3::date)', [noWht, 'X', today]), /NO_WHT_ON_ALLOCATION/);
  await owner('select record_wht_credit_note($1, $2, $3::date)', [aid, 'WHT-CN-1', today]);
  assert.equal((await status(inv)).wht_credit_note_pending, '0');
  assert.equal((await status(inv)).wht, '500000');
  await assert.rejects(() => owner('select record_wht_credit_note($1, $2, $3::date)', [aid, 'WHT-CN-2', today]), /WHT_CREDIT_NOTE_ALREADY_RECORDED/);
  // WHT counts toward the open balance: cash + WHT may not exceed it.
  const inv2 = await mkInvoice(k, '1000', '1000000');
  const pay2 = await rec(ACCT, 'g7b', k, 600000, 'NIP-G7-0002');
  await assert.rejects(() => confirmAs(owner, pay2, alloc([inv2, 600000, 400001])), /ALLOCATION_EXCEEDS_BALANCE/);
  const ok = await confirmAs(owner, pay2, alloc([inv2, 600000, 400000]));
  receipts++;
  assert.equal(ok.stamp, 'PAID');
  assert.equal((await status(inv2)).state, 'paid');
});

await t('P4 G9 short-pay: total 10,750,000, paid 10,745,000; cap 10,000 closes balance 5,000; caps 4,999 and 0 are rejected and the invoice stays partially paid', async () => {
  const k = await cust('Short Payer Ltd');
  const inv = await mkInvoice(k, '1000', '10000000', { vat_enabled: true });
  const pay = await rec(ACCT, 'g9', k, 10745000, 'NIP-G9-0001');
  await confirmAs(owner, pay, alloc([inv, 10745000]));
  receipts++;
  let s = await status(inv);
  assert.deepEqual([s.state, s.balance], ['partially_paid', '5000']);

  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', [inv, 'Bank charges']), /SHORT_PAY_DISABLED/);       // cap 0 (default)
  await setCap(4999);
  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', [inv, 'Bank charges']), /ADJUSTMENT_OVER_CAP/);
  s = await status(inv);
  assert.deepEqual([s.state, s.balance, s.adjusted], ['partially_paid', '5000', '0']);
  await setCap(10000);
  await assert.rejects(() => cash('select adjust_short_pay($1, $2)', [inv, 'Bank charges']), /CAPABILITY_DENIED/);
  await assert.rejects(() => deputy('select adjust_short_pay($1, $2)', [inv, 'Bank charges']), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', [inv, '  ']), /REASON_REQUIRED/);
  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', ['11111111-1111-1111-1111-111111111111', 'x']), /INVOICE_NOT_FOUND/);
  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', [QUOTE, 'x']), /INVOICE_NOT_FOUND/);
  const amount = (await owner('select adjust_short_pay($1, $2) as n', [inv, 'Bank charges on transfer']))[0].n;
  assert.equal(String(amount), '5000');
  s = await status(inv);
  assert.deepEqual([s.state, s.balance, s.settled, s.adjusted], ['paid', '0', '10745000', '5000']);    // never counted as cash received
  const adj = (await q('select amount_kobo, cap_kobo, reason, created_by from payment_adjustments where invoice_id = $1', [inv]))[0];
  assert.deepEqual([String(adj.amount_kobo), String(adj.cap_kobo), adj.reason, adj.created_by], ['5000', '10000', 'Bank charges on transfer', OWNER]);
  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', [inv, 'again']), /NOTHING_TO_ADJUST/);
  assert.equal((await q("select count(*)::int as n from audit_log where action = 'ADJUST_SHORT_PAY'"))[0].n, 1);
  // The cap is inclusive: a balance exactly equal to the cap may be closed.
  const inv2 = await mkInvoice(k, '1000', '1000000');
  await confirmAs(owner, await rec(ACCT, 'g9b', k, 995000, 'NIP-G9-0002'), alloc([inv2, 995000]));
  receipts++;
  await setCap(5000);
  assert.equal(String((await owner('select adjust_short_pay($1, $2) as n', [inv2, 'Rounding']))[0].n), '5000');
  const inv3 = await mkInvoice(k, '1000', '1000000');
  await confirmAs(owner, await rec(ACCT, 'g9c', k, 994999, 'NIP-G9-0003'), alloc([inv3, 994999]));
  receipts++;
  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', [inv3, 'x']), /ADJUSTMENT_OVER_CAP/);   // balance 5,001 > cap 5,000
  await setCap(0);
  // Direct SQL cannot change a recorded adjustment.
  await assert.rejects(() => db.exec('update payment_adjustments set amount_kobo = 1'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('delete from payment_adjustments'), /INSERT_ONLY_TABLE/);
});

await t('P5 authority: capability, fresh MFA, per-payment cap, four-eyes on the payment and on every invoice; Owner exempt from caps and four-eyes only', async () => {
  const k = await cust('Authority Customer Ltd');
  const inv = await mkInvoice(k, '1000', '5000000');                         // created by the Owner
  const makerInv = await mkInvoice(k, '1000', '5000000', {}, MAKER);          // created by MAKER
  const p1 = await rec(ACCT, 'a1', k, 5000000, 'NIP-A-0001');
  const big = await mkInvoice(k, '1000', '70000000');
  const pBig = await rec(ACCT, 'a-big', k, 70000000, 'NIP-A-BIG');
  const baseline = await counts();
  await assert.rejects(() => confirmAs(staff, p1, alloc([inv, 5000000])), /CAPABILITY_DENIED/);
  await assert.rejects(() => confirmAs(acct, p1, alloc([inv, 5000000])), /CAPABILITY_DENIED/);
  await assert.rejects(() => confirmAs(deputy, p1, alloc([inv, 5000000])), /CAPABILITY_DENIED/);
  await assert.rejects(() => confirmAs((s, p) => cash(s, p, 3600), p1, alloc([inv, 5000000])), /MFA_REQUIRED/);
  await assert.rejects(() => confirmAs((s, p) => owner(s, p, 3600), p1, alloc([inv, 5000000])), /MFA_REQUIRED/);   // MFA applies to the Owner too
  assert.deepEqual(await counts(), baseline);

  // Over the cashier's 60,000,000 cap.
  await assert.rejects(() => confirmAs(cash, pBig, alloc([big, 70000000])), /OVER_CAP/);
  assert.deepEqual(await counts(), baseline);
  await confirmAs(owner, pBig, alloc([big, 70000000]));                      // the Owner has no cap
  receipts++;

  // Four-eyes on the payment: a cashier cannot confirm what they recorded themselves.
  const pOwn = await rec(CASH, 'a-own', k, 5000000, 'NIP-A-OWN');
  await assert.rejects(() => confirmAs(cash, pOwn, alloc([inv, 5000000])), /FOUR_EYES/);
  // Four-eyes on the invoice: the invoice's creator cannot confirm a payment against it.
  const pForMaker = await rec(ACCT, 'a-mk', k, 5000000, 'NIP-A-MK');
  await assert.rejects(() => confirmAs(maker, pForMaker, alloc([makerInv, 5000000])), /FOUR_EYES/);
  await assert.rejects(() => confirmAs(maker, pForMaker, alloc([inv, 2000000], [makerInv, 3000000])), /FOUR_EYES/);   // even as one of several invoices
  assert.equal((await q('select status from payments where id = $1', [pForMaker]))[0].status, 'pending_verification');
  // A different cashier, within the cap, with fresh MFA, confirms both.
  const r = await confirmAs(cash2, pForMaker, alloc([makerInv, 5000000]));
  receipts++;
  assert.equal(r.stamp, 'PAID');
  assert.equal((await q('select confirmed_by from payments where id = $1', [pForMaker]))[0].confirmed_by, CASH2);
  const r2 = await confirmAs(cash2, pOwn, alloc([inv, 5000000]));
  receipts++;
  assert.equal(r2.receipt_number, `RCP-${YEAR}-${String(receipts).padStart(4, '0')}`);
  // Retrying a confirmed payment still needs authority; a stranger gets nothing.
  await assert.rejects(() => confirmAs(staff, pOwn, alloc([inv, 5000000])), /CAPABILITY_DENIED/);
  assert.equal((await confirmAs(cash2, pOwn, alloc([inv, 5000000]))).already_confirmed, true);
  // The Owner confirms a payment they recorded themselves (not bound by four-eyes).
  const k2 = await cust('Owner Own Ltd');
  const oi = await mkInvoice(k2, '1000', '1000000');
  const op = await rec(OWNER, 'o1', k2, 1000000, 'NIP-O-1');
  await confirmAs(owner, op, alloc([oi, 1000000]));
  receipts++;
  // Read-only mode refuses confirmation.
  const pRo = await rec(ACCT, 'a-ro', k, 100, 'NIP-A-RO');
  const roInv = await mkInvoice(k, '1000', '100');
  await setSub(new Date(Date.now() - 864e5).toISOString());
  await assert.rejects(() => confirmAs(owner, pRo, alloc([roInv, 100])), /ACCESS_/);
  await assert.rejects(() => owner('select reverse_payment($1, $2)', [op, 'x']), /ACCESS_/);
  await assert.rejects(() => owner('select adjust_short_pay($1, $2)', [roInv, 'x']), /ACCESS_/);
  await setSub('2099-01-01T00:00:00Z');
  assert.equal(await receiptCounter(), receipts);                              // failures burned no receipt number
});

await t('P6 reversal: Owner only with a reason; original untouched; balance restored; receipt voided; reference reusable; no direct edits', async () => {
  assert.deepEqual([(await status(A)).state, (await status(A)).balance], ['paid', '0']);
  await assert.rejects(() => cash('select reverse_payment($1, $2)', [PG8, 'Bank reversed it']), /CAPABILITY_DENIED/);
  await assert.rejects(() => deputy('select reverse_payment($1, $2)', [PG8, 'x']), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select reverse_payment($1, $2)', [PG8, '  ']), /REASON_REQUIRED/);
  await assert.rejects(() => owner('select reverse_payment($1, $2)', ['11111111-1111-1111-1111-111111111111', 'x']), /PAYMENT_NOT_FOUND/);
  const pendingId = await rec(ACCT, 'rv-pending', K1, 10, 'NIP-RV-P');
  await assert.rejects(() => owner('select reverse_payment($1, $2)', [pendingId, 'x']), /PAYMENT_NOT_REVERSIBLE/);

  const origAlloc = await q('select id, invoice_id, cash_kobo::text as c, wht_kobo::text as w from payment_allocations where payment_id = $1 order by invoice_id', [PG8]);
  await owner('select reverse_payment($1, $2)', [PG8, 'Bank reversed the transfer']);
  const a = await status(A); const b = await status(B);
  assert.deepEqual([a.state, a.balance, a.settled], ['unpaid', '30000000', '0']);                 // balance restored
  assert.deepEqual([b.state, b.balance, b.settled], ['unpaid', '25000000', '0']);
  const p = (await q('select status, amount_kobo::text as amt, confirmed_by from payments where id = $1', [PG8]))[0];
  assert.deepEqual([p.status, p.amt, p.confirmed_by], ['reversed', '50000000', OWNER]);           // original untouched
  assert.deepEqual(await q('select id, invoice_id, cash_kobo::text as c, wht_kobo::text as w from payment_allocations where payment_id = $1 order by invoice_id', [PG8]), origAlloc);
  const rev = (await q('select reason, reversed_by from payment_reversals where payment_id = $1', [PG8]))[0];
  assert.deepEqual([rev.reason, rev.reversed_by], ['Bank reversed the transfer', OWNER]);
  const rd = (await q('select status, void_reason, voided_by, number from documents where id = $1', [receiptG8]))[0];
  assert.deepEqual([rd.status, rd.void_reason, rd.voided_by, rd.number], ['void', 'Payment reversed: Bank reversed the transfer', OWNER, `RCP-${YEAR}-0001`]);
  await assert.rejects(() => owner('select reverse_payment($1, $2)', [PG8, 'again']), /PAYMENT_NOT_REVERSIBLE/);
  await assert.rejects(() => confirmAs(owner, PG8, alloc([A, 50000000])), /PAYMENT_NOT_CONFIRMABLE|ALLOCATION_EXCEEDS_BALANCE/);
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, true);                    // voiding does not touch the frozen snapshot
  assert.equal((await q("select count(*)::int as n from audit_log where action = 'REVERSE_PAYMENT'"))[0].n, 1);
  assert.equal(await receiptCounter(), receipts);                                                  // the number is retired, never reused

  // The same reference may be recorded again once its payment is reversed, and the restored balance can be paid.
  const again = await rec(ACCT, 'g8-again', K1, 55000000, 'NIP-G8-0001');
  const r = await confirmAs(owner, again, alloc([A, 30000000], [B, 25000000]));
  receipts++;
  assert.equal(r.stamp, 'PAID');
  assert.equal(r.receipt_number, `RCP-${YEAR}-${String(receipts).padStart(4, '0')}`);

  // Nothing can be edited or deleted underneath the application.
  await assert.rejects(() => db.exec(`update payments set amount_kobo = 1 where id = '${PG8}'`), /PAYMENT_IMMUTABLE/);
  await assert.rejects(() => db.exec(`update payments set confirmed_by = '${STAFF}' where id = '${PG8}'`), /PAYMENT_IMMUTABLE/);
  await assert.rejects(() => db.exec(`update payments set status = 'confirmed' where id = '${PG8}'`), /STATUS_TRANSITION_INVALID/);
  await assert.rejects(() => db.exec(`delete from payments where id = '${PG8}'`), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('update payment_allocations set cash_kobo = 1'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('delete from payment_allocations'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('update payment_reversals set reason = $$x$$'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('truncate payments cascade'), /INSERT_ONLY_TABLE/);
  await assert.rejects(() => db.exec('truncate payment_allocations'), /INSERT_ONLY_TABLE|cannot truncate/);
  await assert.rejects(() => db.exec('update documents set total_kobo = 1 where doc_type = $$receipt$$'), /DOCUMENT_IMMUTABLE/);
});

await t('P7 void rules: blocked while confirmed payments or adjustments exist; receipts void only through reversal; allowed again after reversal', async () => {
  const k = await cust('Void Rules Ltd');
  const inv = await mkInvoice(k, '1000', '1000000');
  const pay = await rec(ACCT, 'v1', k, 400000, 'NIP-V-1');
  const r = await confirmAs(owner, pay, alloc([inv, 400000]));
  receipts++;
  await assert.rejects(() => owner('select void_document($1, $2)', [inv, 'Wrong customer']), /VOID_BLOCKED_PAYMENTS/);
  await assert.rejects(() => owner('select void_document($1, $2)', [r.receipt_id, 'Wrong']), /RECEIPT_VOID_VIA_REVERSAL/);
  assert.equal((await q('select status from documents where id = $1', [inv]))[0].status, 'issued');
  await owner('select reverse_payment($1, $2)', [pay, 'Customer chargeback']);
  await assert.rejects(() => owner('select void_document($1, $2)', [r.receipt_id, 'Wrong']), /RECEIPT_VOID_VIA_REVERSAL|STATUS_NOT_VOIDABLE/);
  await owner('select void_document($1, $2)', [inv, 'Wrong customer']);                           // allowed: no live payments
  assert.equal((await q('select status from documents where id = $1', [inv]))[0].status, 'void');
  const payAgain = await rec(ACCT, 'v2', k, 100, 'NIP-V-2');
  await assert.rejects(() => confirmAs(owner, payAgain, alloc([inv, 100])), /INVOICE_VOID/);
  // An adjustment also blocks a void.
  const inv2 = await mkInvoice(k, '1000', '3000');
  await setCap(10000);
  await owner('select adjust_short_pay($1, $2)', [inv2, 'Write-off of a few naira']);
  await setCap(0);
  await assert.rejects(() => owner('select void_document($1, $2)', [inv2, 'x']), /VOID_BLOCKED_PAYMENTS/);
  // The earlier behaviour is intact: reason required, capability, status.
  await assert.rejects(() => owner('select void_document($1, $2)', [inv2, ' ']), /REASON_REQUIRED/);
  await assert.rejects(() => staff('select void_document($1, $2)', [inv2, 'x']), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select void_document($1, $2)', [draftInv, 'x']), /STATUS_NOT_VOIDABLE/);
});

await t('P8 end to end: staff draft -> submit -> deputy approves -> two part payments -> two receipts; earlier-paid carried; PAID only on the last', async () => {
  const k = await cust('End To End Ltd');
  const id = (await staff('select save_draft(null, $1::jsonb) as r', [JSON.stringify({ doc_type: 'invoice', customer_id: k, discount_kind: 'percent', discount_value: '1000',
    payment_terms_days: 14, lines: [{ description: '18 mm marine board', qty_milli: '3000', unit_kobo: '4500000' }, { description: 'Delivery to site', qty_milli: '1000', unit_kobo: '1250050' }] })]))[0].r.id;
  await staff('select submit_document($1)', [id]);
  await deputy('select approve_and_issue($1)', [id]);
  assert.equal((await status(id)).total, '14270673');                                              // vector G1
  const p1 = await rec(ACCT, 'e1', k, 10000000, 'NIP-E-1');
  const r1 = await confirmAs(cash, p1, alloc([id, 10000000]), 'Bank alert seen');
  receipts++;
  assert.equal(r1.stamp, 'PART PAID');
  assert.equal((await status(id)).balance, '4270673');
  const p2 = await rec(ACCT, 'e2', k, 4270673, 'NIP-E-2');
  const r2 = await confirmAs(cash2, p2, alloc([id, 4270673]), 'Bank alert seen');
  receipts++;
  assert.equal(r2.stamp, 'PAID');
  const snap = (await q('select snapshot from documents where id = $1', [r2.receipt_id]))[0].snapshot;
  assert.deepEqual([snap.applied[0].invoice_total, snap.applied[0].earlier_paid, snap.applied[0].cash, snap.applied[0].balance_after], ['14270673', '10000000', '4270673', '0']);
  const s = await status(id);
  assert.deepEqual([s.state, s.balance, s.settled], ['paid', '0', '14270673']);
  // Overpayment is rejected: nothing is owed any more.
  const p3 = await rec(ACCT, 'e3', k, 1, 'NIP-E-3');
  await assert.rejects(() => confirmAs(cash, p3, alloc([id, 1])), /ALLOCATION_EXCEEDS_BALANCE/);
  // Owner switch: always stamp PAID.
  await db.exec('update business_settings set receipt_stamp_always_paid = true');
  const part = await mkInvoice(k, '1000', '1000000');
  const p4 = await rec(ACCT, 'e4', k, 1000, 'NIP-E-4');
  const r4 = await confirmAs(owner, p4, alloc([part, 1000]));
  receipts++;
  assert.equal(r4.stamp, 'PAID');
  await db.exec('update business_settings set receipt_stamp_always_paid = false');
  assert.equal(await receiptCounter(), receipts);
});

await t('P9 derived status and overdue use the Lagos date; visibility is limited', async () => {
  const k = await cust('Status Ltd');
  const inv = await mkInvoice(k, '1000', '1000000');
  const due = (await q('select due_date::text as d from documents where id = $1', [inv]))[0].d;
  assert.equal(due, addDays(today, 14));
  const at = async (d) => (await q('select invoice_state_at($1, $2::date) as r', [inv, d]))[0].r;
  assert.equal((await at(due)).overdue, false);                      // due date itself is not overdue
  assert.equal((await at(addDays(due, 1))).overdue, true);
  assert.equal((await at(addDays(due, 1))).state, 'unpaid');
  await confirmAs(owner, await rec(ACCT, 's1', k, 1000000, 'NIP-S-1'), alloc([inv, 1000000]));
  receipts++;
  assert.equal((await at(addDays(due, 30))).overdue, false);         // paid: never overdue
  await assert.rejects(() => q('select invoice_state_at($1, $2::date)', [QUOTE, today]), /INVOICE_NOT_FOUND/);
  await owner('select reverse_payment($1, $2)', [(await q('select id from payments where idempotency_key = $1', ['s1']))[0].id, 'x']);
  assert.equal((await at(addDays(due, 1))).overdue, true);           // reversal restores the balance and the overdue flag
  // Who may see an invoice's payment status.
  const own = await mkInvoice(k, '1000', '1000', {}, MAKER);
  assert.equal((await maker('select invoice_payment_status($1) as r', [own]))[0].r.state, 'unpaid');
  assert.equal((await acct('select invoice_payment_status($1) as r', [own]))[0].r.state, 'unpaid');
  await assert.rejects(() => staff('select invoice_payment_status($1)', [own]), /CAPABILITY_DENIED/);
  await assert.rejects(() => who(NOBODY)('select invoice_payment_status($1)', [own]), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select invoice_payment_status($1)', [QUOTE]), /INVOICE_NOT_FOUND/);
  await assert.rejects(() => as('', 'anon', () => q('select invoice_payment_status($1)', [own])), /permission denied/);
});

await t('P10 privileges: no direct table writes, internal functions not callable, rows visible only to the right roles', async () => {
  for (const sql of [
    "insert into payments(customer_id, amount_kobo, method, paid_on, idempotency_key, recorded_by) values (gen_random_uuid(), 1, 'cash', now(), 'x', gen_random_uuid())",
    'update payments set amount_kobo = 1', 'delete from payments', 'insert into payment_allocations(payment_id, invoice_id, cash_kobo) values (gen_random_uuid(), gen_random_uuid(), 1)',
    'update payment_adjustments set amount_kobo = 1', 'insert into payment_reversals(payment_id, reason, reversed_by) values (gen_random_uuid(), $$x$$, gen_random_uuid())',
    'insert into wht_credit_notes(allocation_id, reference, received_on, recorded_by) values (gen_random_uuid(), $$x$$, now(), gen_random_uuid())',
  ]) await assert.rejects(() => owner(sql), /permission denied/, sql);
  const id = '11111111-1111-1111-1111-111111111111';
  for (const sql of [
    `select confirm_core('${id}', '[]', 'x', now())`, 'select chain_stamp($$ {} $$::jsonb)', `select invoice_balance('${id}')`,
    `select invoice_settled_kobo('${id}')`, `select invoice_state_at('${id}', current_date)`,
  ]) {
    await assert.rejects(() => owner(sql), /permission denied/, sql);
    await assert.rejects(() => as(OWNER, 'anon', () => q(sql)), /permission denied/, sql);
  }
  for (const sql of ['select record_payment($$k$$, $$' + id + '$$, $$1$$, $$cash$$, current_date)', `select confirm_payment('${id}', '[]', 'x')`,
    `select reverse_payment('${id}', 'x')`, `select adjust_short_pay('${id}', 'x')`]) {
    await assert.rejects(() => as(OWNER, 'anon', () => q(sql)), /permission denied/, sql);
  }
  assert.equal((await staff('select count(*)::int as n from payments'))[0].n, 0);                 // Staff holds no payment capability
  assert.equal((await staff('select count(*)::int as n from payment_adjustments'))[0].n, 0);
  assert.ok((await acct('select count(*)::int as n from payments'))[0].n > 5);
  assert.ok((await cash('select count(*)::int as n from payment_allocations'))[0].n > 0);
  assert.equal((await cash('select count(*)::int as n from payment_reversals'))[0].n, 0);         // reversals: Owner and reports.view only
  assert.ok((await owner('select count(*)::int as n from payment_reversals'))[0].n > 0);
  assert.ok((await acct('select count(*)::int as n from payment_reversals'))[0].n > 0);           // Accountant holds reports.view
});

await t('P11 receipt numbering by Lagos year, gapless, with a tamper check on the chain', async () => {
  const k = await cust('Year Boundary Ltd');
  const inv = await mkInvoice(k, '1000', '3000000');
  const at = async (iso, ref, key) => {
    const pay = await rec(ACCT, key, k, 1000000, ref);
    return (await sup(OWNER, 'select confirm_core($1::uuid, $2::jsonb, $3, $4::timestamptz) as r', [pay, alloc([inv, 1000000]), 'Bank alert seen', iso]))[0].r;
  };
  const before2027 = await receiptCounter(2027);
  assert.equal(before2027, 0);
  const a = await at('2026-12-31T23:30:00Z', 'NIP-Y-1', 'y1');        // 00:30 on 1 Jan 2027 in Lagos
  assert.equal(a.receipt_number, 'RCP-2027-0001');
  assert.equal((await q('select issue_date::text as d from documents where id = $1', [a.receipt_id]))[0].d, '2027-01-01');
  const b = await at('2027-12-31T22:59:59Z', 'NIP-Y-2', 'y2');        // 23:59:59 on 31 Dec 2027 in Lagos
  assert.equal(b.receipt_number, 'RCP-2027-0002');
  const c = await at('2027-12-31T23:00:00Z', 'NIP-Y-3', 'y3');        // 00:00 on 1 Jan 2028 in Lagos
  assert.equal(c.receipt_number, 'RCP-2028-0001');
  assert.equal(await receiptCounter(), receipts);                       // the current year's counter is untouched

  // Every receipt hash links to the one before it, recomputed here in JavaScript.
  const rows = await q('select chain_seq, prev_hash, snapshot_hash, snapshot::text as s from documents where chain_seq is not null order by chain_seq');
  let prev = '0'.repeat(64);
  for (const r of rows) { assert.equal(r.prev_hash, prev); assert.equal(r.snapshot_hash, sha(prev + '|' + r.s)); prev = r.snapshot_hash; }
  assert.ok(rows.length > 20);
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, true);
  await db.exec('alter table documents disable trigger documents_guard_row');
  await db.exec(`update documents set snapshot = jsonb_set(snapshot, '{totals,settled}', '"1"') where id = '${a.receipt_id}'`);
  await db.exec('alter table documents enable trigger documents_guard_row');
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, false);                    // tampering with a receipt is detected
});

await t('P12 property: 120 random payments (cash + WHT) against 6 invoices: the database balance always equals an independent model; never negative', async () => {
  let seed = 20261125;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const k = await cust('Random Payer Ltd');
  const totals = [1, 999, 100000, 7500050, 123456789, 999999999999];
  const invs = [];
  for (const [i, total] of totals.entries()) {
    // total = quantity 1.000 x unit price, VAT off; the largest sits just under the 10,000,000,000 naira limit
    invs.push({ id: await mkInvoice(k, '1000', String(total)), total: BigInt(total), settled: 0n });
    assert.equal((await status(invs[i].id)).total, String(total));
  }
  let accepted = 0; let rejected = 0;
  for (let n = 0; n < 120; n++) {
    const inv = invs[Math.floor(rnd() * invs.length)];
    const bal = inv.total - inv.settled;
    const pick = rnd();
    let cashK; let whtK;
    if (pick < 0.15) { cashK = bal + 1n; whtK = 0n; }                               // one kobo too much
    else if (pick < 0.3) { cashK = bal; whtK = 0n; }                                // exactly the balance
    else { const span = bal > 0n ? bal : 1n; cashK = 1n + BigInt(Math.floor(rnd() * Number(span > 2n ** 50n ? 2n ** 50n : span))) % span; whtK = rnd() < 0.3 ? BigInt(Math.floor(rnd() * 5)) : 0n; }
    if (cashK < 1n) cashK = 1n;
    const pay = await rec(OWNER, `p12-${n}`, k, cashK, `NIP-P12-${n}`);
    const fits = cashK + whtK <= bal;
    if (fits) {
      await confirmAs(owner, pay, alloc([inv.id, cashK, whtK]), 'Checked');
      receipts++; accepted++; inv.settled += cashK + whtK;
    } else {
      await assert.rejects(() => confirmAs(owner, pay, alloc([inv.id, cashK, whtK]), 'Checked'), /ALLOCATION_EXCEEDS_BALANCE/);
      rejected++;
    }
    if (n % 20 === 19) for (const v of invs) assert.equal((await status(v.id)).balance, String(v.total - v.settled));
  }
  for (const v of invs) {
    const s = await status(v.id);
    assert.equal(s.balance, String(v.total - v.settled));
    assert.ok(BigInt(s.balance) >= 0n);
    assert.equal(s.state, v.settled === v.total ? 'paid' : v.settled > 0n ? 'partially_paid' : 'unpaid');
  }
  assert.ok(accepted > 20 && rejected > 5, `accepted ${accepted}, rejected ${rejected}`);
  assert.equal(await receiptCounter(), receipts);
});

console.log(`\n${passed} payment test groups passed`);
assert.equal(passed, 12);
await db.close();
