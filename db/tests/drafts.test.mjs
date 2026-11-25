// Draft lifecycle and customers (Playbook sections 7.1, 7.2, 7.8), ending with a full run: staff draft, submit, approve, issue.
// Expected values are literals from the playbook or computed in JavaScript, never by the SQL under test.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const STAFF = '00000000-0000-0000-0000-0000000000a2';
const STAFF2 = '00000000-0000-0000-0000-0000000000a5';
const DEPUTY = '00000000-0000-0000-0000-0000000000a3';
const LEAD = '00000000-0000-0000-0000-0000000000a6';
const ACCT = '00000000-0000-0000-0000-0000000000a7';
const db = new PGlite();
let passed = 0;

const nowSec = () => Math.floor(Date.now() / 1000);
const as = async (uid, fn, mfaAgeSec = 10) => {
  const claims = { aal: 'aal2', amr: [{ method: 'totp', timestamp: nowSec() - mfaAgeSec }] };
  await db.exec(`select set_config('app.uid', '${uid}', false)`);
  await db.exec(`select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false)`);
  await db.exec('set role authenticated');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.exec(`select set_config('app.uid', '', false)`);
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
  }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };
const who = (uid) => (sql, params, age) => as(uid, () => q(sql, params), age);
const owner = who(OWNER); const staff = who(STAFF); const staff2 = who(STAFF2); const deputy = who(DEPUTY); const lead = who(LEAD); const acct = who(ACCT);
const setSub = (periodEnd) => db.exec(`delete from subscription; insert into subscription(plan, current_period_end) values ('annual', '${periodEnd}')`);
const lagosYear = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date()).slice(0, 4));

await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users(id) values ('${OWNER}'), ('${STAFF}'), ('${STAFF2}'), ('${DEPUTY}'), ('${LEAD}'), ('${ACCT}');
`);
for (const f of ['0000_profiles.sql', '0001_subscription.sql', '0002_roles_audit.sql', '0003_money.sql', '0004_documents_issue.sql', '0005_drafts_customers.sql']) {
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
for (const [uid, name, role] of [[STAFF, 'Chinedu Eze', 'Staff'], [STAFF2, 'Bola Ade', 'Staff'], [DEPUTY, 'Ada Obi', 'Deputy approver'], [LEAD, 'Sade Bello', 'Sales lead'], [ACCT, 'Tunde Ojo', 'Accountant']]) {
  await owner('select assign_role($1, $2, $3)', [uid, name, await roleId(role)]);
}
await owner('select save_role($1, $2, $3::jsonb)', [await roleId('Deputy approver'), 'Deputy approver',
  JSON.stringify([{ capability: 'draft.view_all' }, { capability: 'documents.approve_issue', cap_kobo: 20000000 }])]);

const cid = async (uid = STAFF, name = 'Adaeze Okafor Ventures') =>
  (await who(uid)('select create_customer($1, $2, $3, $4, $5) as id', [name, '45 Sample Street, GRA Phase 2, Port Harcourt', 'Adaeze', '0802 000 0000', 'Adaeze@Example.com']))[0].id;
const G1 = [{ description: '18 mm marine board', qty_milli: '3000', unit_kobo: '4500000' }, { description: 'Delivery to site', qty_milli: '1000', unit_kobo: '1250050' }];
const draftDoc = (customer, extra = {}) => ({ doc_type: 'invoice', customer_id: customer, discount_kind: 'percent', discount_value: '1000', payment_terms_days: 14, lines: G1, ...extra });
const save = async (uid, id, doc, age) => (await who(uid)('select save_draft($1, $2::jsonb) as r', [id, JSON.stringify(doc)], age))[0].r;

await t('C1 customers: phone to +234, email syntax, required fields, edit, capability', async () => {
  const mk = async (phone, email = null) => (await staff('select create_customer($1, $2, null, $3, $4) as id', ['Test Co', 'Some address', phone, email]))[0].id;
  const phoneOf = async (id) => (await q('select phone from customers where id = $1', [id]))[0].phone;
  for (const p of ['0803 000 0000', '08030000000', '2348030000000', '+234 803 000 0000', '+2348030000000', '(0803) 000-0000', '0803.000.0000']) {
    assert.equal(await phoneOf(await mk(p)), '+2348030000000', p);
  }
  assert.equal(await phoneOf(await mk(null)), null);
  assert.equal(await phoneOf(await mk('   ')), null);
  for (const bad of ['abc', '0803', '+15551234567', '803000000', '080300000000', '+234803000000']) {
    await assert.rejects(() => mk(bad), /PHONE_INVALID/, bad);
  }
  assert.equal((await q('select email from customers where id = $1', [await mk(null, ' Ada@Example.COM ')]))[0].email, 'ada@example.com');
  for (const bad of ['plain', 'a@b', '@b.com', 'a b@c.com', 'a@@b.com']) await assert.rejects(() => mk(null, bad), /EMAIL_INVALID/, bad);
  await assert.rejects(() => staff('select create_customer($1, $2)', ['  ', 'addr']), /NAME_REQUIRED/);
  await assert.rejects(() => staff('select create_customer($1, $2)', ['Name', ' ']), /ADDRESS_REQUIRED/);
  await assert.rejects(() => acct('select create_customer($1, $2)', ['Name', 'addr']), /CAPABILITY_DENIED/);
  const id = await cid();
  await staff('select update_customer($1, $2, $3, $4, $5, $6)', [id, 'Adaeze Okafor Ltd', 'New address', null, '09012345678', null]);
  const r = (await q('select name, billing_address, phone, email from customers where id = $1', [id]))[0];
  assert.deepEqual(r, { name: 'Adaeze Okafor Ltd', billing_address: 'New address', phone: '+2349012345678', email: null });
  await assert.rejects(() => staff('select update_customer($1, $2, $3)', ['00000000-0000-0000-0000-000000000000', 'X', 'Y']), /CUSTOMER_NOT_FOUND/);
  await assert.rejects(() => who('00000000-0000-0000-0000-000000000099')('select create_customer($1, $2)', ['X', 'Y']), /CAPABILITY_DENIED/);
});

await t('C2 customer search: staff need 2+ characters and get at most 20 rows with no paging; Sales lead and Owner may list and page', async () => {
  for (let i = 1; i <= 25; i++) await owner('select create_customer($1, $2, null, $3)', [`Bulk Customer ${String(i).padStart(2, '0')}`, 'addr', `0805000${String(1000 + i)}`]);
  await assert.rejects(() => staff("select * from search_customers('')"), /QUERY_TOO_SHORT/);
  await assert.rejects(() => staff("select * from search_customers('b')"), /QUERY_TOO_SHORT/);
  assert.equal((await staff("select * from search_customers('bulk', 500, 5)")).length, 20);
  const first = await staff("select name from search_customers('bulk', 20, 0)");
  const paged = await staff("select name from search_customers('bulk', 20, 20)");
  assert.deepEqual(paged, first);
  assert.deepEqual((await staff("select name from search_customers('Customer 07')")).map((r) => r.name), ['Bulk Customer 07']);
  assert.deepEqual((await staff("select name from search_customers('8050001024')")).map((r) => r.name), ['Bulk Customer 24']);
  assert.equal((await staff("select * from search_customers('Bulk%')")).length, 0);
  assert.equal((await staff("select * from search_customers('b_lk')")).length, 0);
  assert.equal((await lead("select * from search_customers('', 100, 0)")).length >= 26, true);
  assert.equal((await lead("select * from search_customers('', 10, 0)")).length, 10);
  const p2 = await lead("select name from search_customers('bulk', 10, 10)");
  assert.deepEqual(p2.map((r) => r.name), Array.from({ length: 10 }, (_, i) => `Bulk Customer ${String(i + 11).padStart(2, '0')}`));
  assert.equal((await owner("select * from search_customers('', 1000, 0)")).length <= 200, true);
  await assert.rejects(() => acct("select * from search_customers('bulk')"), /CAPABILITY_DENIED/);
});

let CUST; let draftId;
await t('C3 save_draft: server totals for vector G1, no number, no snapshot, lines stored; update replaces lines', async () => {
  CUST = await cid();
  const r = await save(STAFF, null, draftDoc(CUST));
  draftId = r.id;
  assert.deepEqual(r.totals, { line_totals: ['13500000', '1250050'], subtotal: '14750050', discount: '1475005', base: '13275045', vat: '995628', total: '14270673' });
  const d = (await q('select status, number, snapshot, created_by, vat_enabled, total_kobo from documents where id = $1', [draftId]))[0];
  assert.deepEqual([d.status, d.number, d.snapshot, d.created_by, d.vat_enabled, d.total_kobo], ['draft', null, null, STAFF, true, null]);
  assert.equal((await q('select count(*)::int as n from document_lines where document_id = $1', [draftId]))[0].n, 2);
  assert.equal((await q("select count(*)::int as n from document_counters"))[0].n, 0);
  const r2 = await save(STAFF, draftId, draftDoc(CUST, { lines: [G1[0]], discount_kind: 'none', discount_value: null }));
  assert.equal(r2.totals.total, '14512500');                                   // 13,500,000 + 7.5% VAT 1,012,500
  const lines = await q('select position, description from document_lines where document_id = $1 order by position', [draftId]);
  assert.deepEqual(lines, [{ position: 1, description: '18 mm marine board' }]);
  const empty = await save(STAFF, null, { doc_type: 'quotation', customer_id: CUST, valid_until: '2027-01-31' });
  assert.equal(empty.totals, null);
  await save(STAFF, draftId, draftDoc(CUST));
});

await t('C4 save_draft validation: shape, money limits, customer, VAT rules, ownership, lock, read-only mode', async () => {
  const bad = (doc, re, uid = STAFF, id = null) => assert.rejects(() => save(uid, id, doc), re);
  await bad(draftDoc(CUST, { doc_type: 'receipt' }), /DOC_TYPE_INVALID/);
  await bad(draftDoc(null), /CUSTOMER_MISSING/);
  await bad(draftDoc('not-a-uuid'), /CUSTOMER_MISSING/);
  await bad(draftDoc('00000000-0000-0000-0000-000000000000'), /CUSTOMER_MISSING/);
  await bad(draftDoc(CUST, { discount_kind: 'percent', discount_value: '9001' }), /DISCOUNT_PERCENT_RANGE/);
  await bad(draftDoc(CUST, { discount_kind: 'percent', discount_value: null }), /DISCOUNT_VALUE_REQUIRED/);
  await bad(draftDoc(CUST, { discount_kind: 'weird' }), /DISCOUNT_KIND_INVALID/);
  await bad(draftDoc(CUST, { lines: [{ description: 'x', qty_milli: '0', unit_kobo: '1' }] }), /QTY_RANGE/);
  await bad(draftDoc(CUST, { lines: [{ description: 'x', qty_milli: '2.5', unit_kobo: '1' }] }), /QTY_RANGE/);
  await bad(draftDoc(CUST, { lines: [{ description: 'x', qty_milli: '1000', unit_kobo: '-1' }] }), /PRICE_RANGE/);
  await bad(draftDoc(CUST, { lines: [{ description: '  ', qty_milli: '1000', unit_kobo: '1' }] }), /DESCRIPTION_REQUIRED/);
  await bad(draftDoc(CUST, { lines: 'nope' }), /LINES_INVALID/);
  await bad(draftDoc(CUST, { lines: Array.from({ length: 501 }, () => ({ description: 'x', qty_milli: '1000', unit_kobo: '1' })) }), /LINES_COUNT/);
  await bad(draftDoc(CUST, { payment_terms_days: -1 }), /TERMS_INVALID/);
  await bad(draftDoc(CUST, { payment_terms_days: 'x' }), /TERMS_INVALID/);
  await bad({ doc_type: 'quotation', customer_id: CUST, valid_until: '2027-13-45' }, /VALID_UNTIL_INVALID/);
  await bad({ doc_type: 'quotation', customer_id: CUST, valid_until: 'tomorrow' }, /VALID_UNTIL_INVALID/);
  await bad(draftDoc(CUST, { vat_enabled: 'yes' }), /VAT_FLAG_INVALID/);
  await assert.rejects(() => staff('select save_draft(null, $1::jsonb)', ['[]']), /DOC_INVALID/);
  await bad(draftDoc(CUST, { vat_enabled: false }), /CAPABILITY_DENIED vat.change_per_document/);
  await bad(draftDoc(CUST), /NOT_YOUR_DRAFT/, STAFF2, draftId);
  await bad(draftDoc(CUST, { doc_type: 'quotation' }), /DOC_TYPE_IMMUTABLE/, STAFF, draftId);
  await bad(draftDoc(CUST), /CAPABILITY_DENIED/, ACCT);
  await bad(draftDoc(CUST), /DOCUMENT_NOT_FOUND/, STAFF, '00000000-0000-0000-0000-000000000000');
  const ownerNoVat = await save(OWNER, null, draftDoc(CUST, { vat_enabled: false }));
  assert.equal(ownerNoVat.totals.vat, '0');
  assert.equal((await q('select vat_enabled from documents where id = $1', [ownerNoVat.id]))[0].vat_enabled, false);
  await db.exec('update business_settings set vat_enabled = false');
  await bad(draftDoc(CUST, { vat_enabled: true }), /VAT_DISABLED/);
  const noVat = await save(STAFF, null, draftDoc(CUST));
  assert.equal(noVat.totals.vat, '0');
  await db.exec('update business_settings set vat_enabled = true');
  await setSub(new Date(Date.now() - 864e5).toISOString());
  await bad(draftDoc(CUST), /ACCESS_GRACE/);
  await setSub('2099-01-01T00:00:00Z');
});

await t('C5 submit: creator only, needs lines and terms, locks editing, audited', async () => {
  const empty = (await save(STAFF, null, draftDoc(CUST, { lines: [] }))).id;
  await assert.rejects(() => staff('select submit_document($1)', [empty]), /LINES_COUNT/);
  const noTerms = (await save(STAFF, null, draftDoc(CUST, { payment_terms_days: null }))).id;
  await assert.rejects(() => staff('select submit_document($1)', [noTerms]), /TERMS_REQUIRED/);
  const noValid = (await save(STAFF, null, { doc_type: 'quotation', customer_id: CUST, lines: G1 })).id;
  await assert.rejects(() => staff('select submit_document($1)', [noValid]), /VALID_UNTIL_REQUIRED/);
  await assert.rejects(() => staff2('select submit_document($1)', [draftId]), /NOT_YOUR_DRAFT/);
  await assert.rejects(() => acct('select submit_document($1)', [draftId]), /CAPABILITY_DENIED/);
  await assert.rejects(() => staff('select submit_document($1)', ['00000000-0000-0000-0000-000000000000']), /DOCUMENT_NOT_FOUND/);
  await setSub(new Date(Date.now() - 864e5).toISOString());
  await assert.rejects(() => staff('select submit_document($1)', [draftId]), /ACCESS_GRACE/);
  await setSub('2099-01-01T00:00:00Z');
  await staff('select submit_document($1)', [draftId]);
  const d = (await q('select status, submitted_at is not null as sub from documents where id = $1', [draftId]))[0];
  assert.deepEqual(d, { status: 'pending_approval', sub: true });
  await assert.rejects(() => staff('select save_draft($1, $2::jsonb)', [draftId, JSON.stringify(draftDoc(CUST))]), /DRAFT_LOCKED/);
  await assert.rejects(() => staff('select submit_document($1)', [draftId]), /STATUS_NOT_SUBMITTABLE/);
  const [a] = await q("select actor, before, after from audit_log where action = 'SUBMIT_DOCUMENT' and subject = $1", [draftId]);
  assert.equal(a.actor, STAFF);
  assert.deepEqual(a.after, { status: 'pending_approval', doc_type: 'invoice', total_kobo: '14270673' });
  await db.exec('update business_settings set vat_enabled = false');
  const vatLater = (await save(OWNER, null, draftDoc(CUST, { vat_enabled: false }))).id;
  await owner('select submit_document($1)', [vatLater]);
  await db.exec('update business_settings set vat_enabled = true');
});

await t('C6 return: Owner only, reason required, back to draft, creator edits and resubmits, audited with the reason', async () => {
  await assert.rejects(() => deputy('select return_document($1, $2)', [draftId, 'x']), /CAPABILITY_DENIED/);
  await assert.rejects(() => staff('select return_document($1, $2)', [draftId, 'x']), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select return_document($1, $2)', [draftId, '  ']), /REASON_REQUIRED/);
  await assert.rejects(() => owner('select return_document($1, $2)', ['00000000-0000-0000-0000-000000000000', 'x']), /DOCUMENT_NOT_FOUND/);
  const fresh = (await save(STAFF, null, draftDoc(CUST))).id;
  await assert.rejects(() => owner('select return_document($1, $2)', [fresh, 'x']), /STATUS_NOT_RETURNABLE/);
  await owner('select return_document($1, $2)', [draftId, 'Customer address is wrong']);
  const d = (await q('select status, return_reason, returned_by, returned_at is not null as at from documents where id = $1', [draftId]))[0];
  assert.deepEqual(d, { status: 'draft', return_reason: 'Customer address is wrong', returned_by: OWNER, at: true });
  const [a] = await q("select actor, after from audit_log where action = 'RETURN_DOCUMENT' and subject = $1", [draftId]);
  assert.deepEqual([a.actor, a.after.reason, a.after.created_by], [OWNER, 'Customer address is wrong', STAFF]);
  await save(STAFF, draftId, draftDoc(CUST, { notes: 'Address fixed' }));
  await staff('select submit_document($1)', [draftId]);
  assert.equal((await q('select status from documents where id = $1', [draftId]))[0].status, 'pending_approval');
});

let issuedNumber; let voidId;
await t('C7 end to end: staff draft, submit, deputy approves within cap, number and snapshot match vector G1', async () => {
  const [{ approve_and_issue: n }] = await deputy('select approve_and_issue($1)', [draftId]);
  issuedNumber = n;
  assert.match(n, new RegExp(`^INV-${lagosYear()}-0001$`));
  const d = (await q('select status, number, total_kobo::text as total, snapshot from documents where id = $1', [draftId]))[0];
  assert.deepEqual([d.status, d.total], ['issued', '14270673']);
  assert.equal(d.snapshot.creator_name, 'Chinedu Eze');
  assert.equal(d.snapshot.approved_by_name, 'Ada Obi');
  assert.equal(d.snapshot.customer.phone, '+2348020000000');
  assert.equal(d.snapshot.document.notes, 'Address fixed');
  assert.equal(d.snapshot.lines.length, 2);
  // changing the customer afterwards never changes the issued document
  await owner('select update_customer($1, $2, $3)', [CUST, 'Renamed Customer', 'Elsewhere']);
  assert.equal((await q('select snapshot #>> \'{customer,name}\' as n from documents where id = $1', [draftId]))[0].n, 'Adaeze Okafor Ventures');
  assert.equal((await q('select verify_snapshot_chain() as ok'))[0].ok, true);
  voidId = draftId;
});

await t('C8 void: Owner only, reason required, issued only, number retired and never reused, record frozen afterwards', async () => {
  await assert.rejects(() => deputy('select void_document($1, $2)', [voidId, 'x']), /CAPABILITY_DENIED/);
  await assert.rejects(() => staff('select void_document($1, $2)', [voidId, 'x']), /CAPABILITY_DENIED/);
  await assert.rejects(() => owner('select void_document($1, $2)', [voidId, ' ']), /REASON_REQUIRED/);
  await assert.rejects(() => owner('select void_document($1, $2)', ['00000000-0000-0000-0000-000000000000', 'x']), /DOCUMENT_NOT_FOUND/);
  const aDraft = (await save(STAFF, null, draftDoc(CUST))).id;
  await assert.rejects(() => owner('select void_document($1, $2)', [aDraft, 'x']), /STATUS_NOT_VOIDABLE/);
  await setSub(new Date(Date.now() - 864e5).toISOString());
  await assert.rejects(() => owner('select void_document($1, $2)', [voidId, 'x']), /ACCESS_GRACE/);
  await setSub('2099-01-01T00:00:00Z');
  await owner('select void_document($1, $2)', [voidId, 'Wrong customer billed']);
  const d = (await q('select status, number, void_reason, voided_by from documents where id = $1', [voidId]))[0];
  assert.deepEqual(d, { status: 'void', number: issuedNumber, void_reason: 'Wrong customer billed', voided_by: OWNER });
  const [a] = await q("select actor, after from audit_log where action = 'VOID_DOCUMENT' and subject = $1", [voidId]);
  assert.deepEqual([a.actor, a.after.reason, a.after.number], [OWNER, 'Wrong customer billed', issuedNumber]);
  await assert.rejects(() => owner('select void_document($1, $2)', [voidId, 'again']), /STATUS_NOT_VOIDABLE/);
  await assert.rejects(() => db.query("update documents set void_reason = 'edited' where id = $1", [voidId]), /DOCUMENT_IMMUTABLE/);
  await assert.rejects(() => db.query("update documents set status = 'issued' where id = $1", [voidId]), /STATUS_TRANSITION_INVALID/);
  await assert.rejects(() => db.query("update documents set number = 'INV-0-0' where id = $1", [voidId]), /DOCUMENT_IMMUTABLE/);
  // the retired number is not reused: the next invoice takes the next number
  const next = (await save(STAFF, null, draftDoc(CUST))).id;
  await staff('select submit_document($1)', [next]);
  const [{ approve_and_issue: n2 }] = await deputy('select approve_and_issue($1)', [next]);
  assert.match(n2, new RegExp(`^INV-${lagosYear()}-0002$`));
  assert.equal((await q("select count(*)::int as n from documents where status = 'void'"))[0].n, 1);
});

await t('C9 tamper: no direct table writes for staff or Owner, internals are not callable', async () => {
  const denied = /permission denied/;
  await assert.rejects(() => staff("insert into customers(name, billing_address, created_by) values ('x', 'y', $1)", [STAFF]), denied);
  await assert.rejects(() => owner("update customers set name = 'x'"), denied);
  await assert.rejects(() => staff("insert into documents(doc_type, customer_id, created_by) values ('invoice', $1, $2)", [CUST, STAFF]), denied);
  await assert.rejects(() => staff("update documents set status = 'issued' where id = $1", [draftId]), denied);
  await assert.rejects(() => staff("insert into document_lines(document_id, position, description, qty_milli, unit_kobo) values ($1, 7, 'x', 1000, 1)", [draftId]), denied);
  await assert.rejects(() => staff("select normalize_ng_phone('08030000000')"), denied);
  await assert.rejects(() => as(STAFF, async () => { await db.exec('reset role'); await db.exec('set role anon'); return q("select save_draft(null, '{}'::jsonb)"); }), denied);
  assert.equal((await staff('select * from customers')).length, 0);
  assert.ok((await staff('select * from documents')).length >= 1);
  assert.equal((await staff2('select * from documents')).length, 0);
});

console.log(`\n${passed} vector groups passed`);
