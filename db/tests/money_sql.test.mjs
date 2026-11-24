// The database money engine (0003_money.sql) against the golden vectors and against the TypeScript engine.
// Expected values are literals from the playbook, or come from src/money.ts (a separate implementation), never from the SQL.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { compute, MoneyError } from '../../src/money.ts';

const db = new PGlite();
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

await db.exec(`
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create role anon nologin; create role authenticated nologin;
`);
await db.exec(fs.readFileSync(new URL('../migrations/0003_money.sql', import.meta.url), 'utf8'));

const sqlCompute = async (lines, kind, value, vatOn, vatBp) => {
  const r = await db.query('select compute_totals($1::jsonb, $2, $3::bigint, $4, $5::bigint) as r',
    [JSON.stringify(lines), kind, value === null ? null : String(value), vatOn, vatBp === null ? null : String(vatBp)]);
  return r.rows[0].r;
};
const L = (qtyMilli, unitKobo) => ({ qty_milli: String(qtyMilli), unit_kobo: String(unitKobo) });
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof MoneyError ? e.code : String(e.message); } };

await t('G1 and G2: 3 x 45,000.00 + 1 x 12,500.50, 10% discount, VAT 7.5% (and VAT off)', async () => {
  const lines = [L(3000, 4500000), L(1000, 1250050)];
  assert.deepEqual(await sqlCompute(lines, 'percent', 1000, true, 750), {
    line_totals: ['13500000', '1250050'], subtotal: '14750050', discount: '1475005', base: '13275045', vat: '995628', total: '14270673' });
  assert.deepEqual(await sqlCompute(lines, 'percent', 1000, false, 750), {
    line_totals: ['13500000', '1250050'], subtotal: '14750050', discount: '1475005', base: '13275045', vat: '0', total: '13275045' });
});

await t('G3: VAT 7.5% on bases of 6, 7 and 20 kobo gives 0, 1 and 2 kobo', async () => {
  for (const [base, vat] of [[6, '0'], [7, '1'], [20, '2']]) {
    const r = await sqlCompute([L(1000, base)], 'none', null, true, 750);
    assert.equal(r.vat, vat);
    assert.equal(r.total, String(base + Number(vat)));
  }
});

await t('G4: discount 90.00% accepted, 90.01% rejected', async () => {
  const r = await sqlCompute([L(1000, 100000)], 'percent', 9000, false, null);
  assert.equal(r.discount, '90000');
  assert.equal(await code(() => sqlCompute([L(1000, 100000)], 'percent', 9001, false, null)), 'DISCOUNT_PERCENT_RANGE');
  assert.equal(await code(() => sqlCompute([L(1000, 100000)], 'percent', -1, false, null)), 'DISCOUNT_PERCENT_RANGE');
});

await t('G5: fixed discount equal to the subtotal gives total 0; one kobo above is rejected', async () => {
  const r = await sqlCompute([L(1000, 5000)], 'fixed', 5000, true, 750);
  assert.deepEqual([r.base, r.vat, r.total], ['0', '0', '0']);
  assert.deepEqual((await db.query('select can_issue(0) as a, can_issue(1) as b, can_issue(null) as c')).rows[0], { a: false, b: true, c: false });
  assert.equal(await code(() => sqlCompute([L(1000, 5000)], 'fixed', 5001, false, null)), 'DISCOUNT_FIXED_RANGE');
  assert.equal(await code(() => sqlCompute([L(1000, 5000)], 'fixed', -1, false, null)), 'DISCOUNT_FIXED_RANGE');
});

await t('G6: quantity 2.5 x 1,000.01 is 250,002.5 and rounds up to 250,003', async () => {
  const r = await sqlCompute([L(2500, 100001)], 'none', null, false, null);
  assert.equal(r.total, '250003');
});

await t('G7: base 10,000,000 kobo with VAT on gives VAT 750,000 and total 10,750,000', async () => {
  const r = await sqlCompute([L(1000, 10000000)], 'none', null, true, 750);
  assert.deepEqual([r.vat, r.total], ['750000', '10750000']);
});

await t('round-half-up boundaries', async () => {
  const hu = async (n, d) => (await db.query('select money_half_up($1::numeric, $2::numeric)::text as r', [String(n), String(d)])).rows[0].r;
  assert.equal(await hu(5, 10), '1');
  assert.equal(await hu(4, 10), '0');
  assert.equal(await hu(15, 10), '2');
  assert.equal(await hu(0, 7), '0');
  assert.equal(await hu('999999999999999999999', 1000), '1000000000000000000');
  await assert.rejects(() => db.query('select money_half_up(-1, 10)'), /ROUNDING_DOMAIN/);
  await assert.rejects(() => db.query('select money_half_up(1, 0)'), /ROUNDING_DOMAIN/);
});

await t('invalid and outlier inputs return the same error code as the TypeScript engine', async () => {
  const MAX = 1000000000000;
  const cases = [
    [[], 'none', null, false, null, 'LINES_COUNT'],
    [Array.from({ length: 501 }, () => L(1000, 1)), 'none', null, false, null, 'LINES_COUNT'],
    [[L(0, 100)], 'none', null, false, null, 'QTY_RANGE'],
    [[L(1000000001, 100)], 'none', null, false, null, 'QTY_RANGE'],
    [[{ qty_milli: '-5', unit_kobo: '100' }], 'none', null, false, null, 'QTY_RANGE'],
    [[{ qty_milli: '2.5', unit_kobo: '100' }], 'none', null, false, null, 'QTY_RANGE'],
    [[{ qty_milli: '1e3', unit_kobo: '100' }], 'none', null, false, null, 'QTY_RANGE'],
    [[{ unit_kobo: '100' }], 'none', null, false, null, 'QTY_RANGE'],
    [[L(1000, MAX + 1)], 'none', null, false, null, 'PRICE_RANGE'],
    [[{ qty_milli: '1000', unit_kobo: '-1' }], 'none', null, false, null, 'PRICE_RANGE'],
    [[{ qty_milli: '1000', unit_kobo: ' 100' }], 'none', null, false, null, 'PRICE_RANGE'],
    [[L(2000, MAX)], 'none', null, false, null, 'DOC_LIMIT'],
    [[L(1000, MAX), L(1000, 1)], 'none', null, false, null, 'DOC_LIMIT'],
    [[L(1000, MAX)], 'none', null, true, 750, 'DOC_LIMIT'],
    [[L(1000, 100)], 'none', null, true, 10001, 'VAT_RATE_RANGE'],
    [[L(1000, 100)], 'none', null, true, -1, 'VAT_RATE_RANGE'],
  ];
  for (const [lines, kind, val, on, bp, want] of cases) {
    assert.equal(await code(() => sqlCompute(lines, kind, val, on, bp)), want, `SQL ${want}`);
    const ts = await code(() => compute(lines.map((l) => ({ qtyMilli: BigInt(/^[0-9]+$/.test(l.qty_milli ?? '') ? l.qty_milli : -1), unitKobo: BigInt(/^[0-9]+$/.test(l.unit_kobo ?? '') ? l.unit_kobo : -1) })),
      kind === 'none' ? { kind } : kind === 'percent' ? { kind, bp: BigInt(val) } : { kind, kobo: BigInt(val) }, { enabled: on, rateBp: BigInt(bp ?? 0) }));
    assert.equal(ts, want, `TS ${want}`);
  }
  assert.equal(await code(() => sqlCompute([L(1000, 100)], 'weird', null, false, null)), 'DISCOUNT_KIND_INVALID');
  assert.equal(await code(() => db.query("select compute_totals('{}'::jsonb, 'none', null, false, null)")), 'LINES_COUNT');
  assert.equal(await code(() => db.query("select compute_totals(null, 'none', null, false, null)")), 'LINES_COUNT');
  assert.equal((await sqlCompute(Array.from({ length: 500 }, () => L(1000, 1000)), 'none', null, false, null)).total, '500000');
});

await t('differential: 3,000 seeded random documents match the TypeScript engine exactly (totals or error code)', async () => {
  let s = 20261124;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const big = () => BigInt(Math.floor(rnd() * 1e9)) * BigInt(Math.floor(rnd() * 1e3) + 1) + BigInt(Math.floor(rnd() * 1e3));
  let ok = 0, err = 0;
  for (let n = 0; n < 3000; n++) {
    const k = pick([1, 1, 2, 3, 5, 12, 40]);
    const lines = Array.from({ length: k }, () => ({
      qtyMilli: pick([1n, 500n, 1000n, 2500n, 3000n, 999999n, BigInt(Math.floor(rnd() * 100000) + 1), 1000000000n, 1000000001n]),
      unitKobo: pick([0n, 1n, 6n, 7n, 100001n, 4500000n, big(), BigInt(Math.floor(rnd() * 1e7))]) }));
    const kind = pick(['none', 'percent', 'fixed']);
    const dv = kind === 'percent' ? BigInt(pick([0, 1, 750, 1000, 8999, 9000, 9001, Math.floor(rnd() * 9001)])) : BigInt(pick([0, 1, 5, Math.floor(rnd() * 1e8)]));
    const vat = { enabled: rnd() < 0.7, rateBp: BigInt(pick([0, 750, 1000, 10000, 10001, Math.floor(rnd() * 3000)])) };
    const d = kind === 'none' ? { kind } : kind === 'percent' ? { kind, bp: dv } : { kind, kobo: dv };
    let want, wantErr = null;
    try { want = compute(lines, d, vat); } catch (e) { if (!(e instanceof MoneyError)) throw e; wantErr = e.code; }
    const sqlLines = lines.map((l) => L(l.qtyMilli, l.unitKobo));
    if (wantErr) {
      assert.equal(await code(() => sqlCompute(sqlLines, kind, kind === 'none' ? null : dv, vat.enabled, vat.rateBp)), wantErr, `case ${n}`);
      err++;
    } else {
      const got = await sqlCompute(sqlLines, kind, kind === 'none' ? null : dv, vat.enabled, vat.rateBp);
      assert.deepEqual(got, {
        line_totals: want.lineTotals.map(String), subtotal: String(want.subtotal), discount: String(want.discount),
        base: String(want.base), vat: String(want.vat), total: String(want.total) }, `case ${n}`);
      ok++;
    }
  }
  assert.ok(ok > 500 && err > 100, `mix ok=${ok} err=${err}`);
  console.log(`   (${ok} documents matched, ${err} error codes matched)`);
});

await t('privileges: anon cannot call compute_totals; authenticated can', async () => {
  await db.exec('set role anon');
  await assert.rejects(() => db.query("select compute_totals('[]'::jsonb, 'none', null, false, null)"), /permission denied/);
  await db.exec('reset role');
  await db.exec('set role authenticated');
  const r = await db.query(`select compute_totals('[{"qty_milli":"1000","unit_kobo":"100"}]'::jsonb, 'none', null, false, null) as r`);
  await db.exec('reset role');
  assert.equal(r.rows[0].r.total, '100');
});

console.log(`\n${passed} vector groups passed`);
