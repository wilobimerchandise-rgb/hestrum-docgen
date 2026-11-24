// money.test.ts — expected values are literals copied from the playbook (section 7.5) or computed
// by an independent divmod oracle. Nothing here is derived from compute() itself.
import test from "node:test";
import assert from "node:assert/strict";
import { compute, canIssue, suggestWht, settle, MoneyError, MAX_DOC_KOBO, MAX_LINES } from "./money.ts";

const NONE = { kind: "none" } as const;
const VAT_ON = { enabled: true, rateBp: 750n };
const VAT_OFF = { enabled: false, rateBp: 750n };
const one = (kobo: bigint) => [{ qtyMilli: 1000n, unitKobo: kobo }];
const code = (e: unknown) => (e as MoneyError).code;

test("G1: 3 x 45,000.00 + 1 x 12,500.50; 10% discount; VAT 7.5%", () => {
  const r = compute(
    [{ qtyMilli: 3000n, unitKobo: 4_500_000n }, { qtyMilli: 1000n, unitKobo: 1_250_050n }],
    { kind: "percent", bp: 1000n }, VAT_ON);
  assert.deepEqual(r.lineTotals, [13_500_000n, 1_250_050n]);
  assert.equal(r.subtotal, 14_750_050n);
  assert.equal(r.discount, 1_475_005n);
  assert.equal(r.base, 13_275_045n);
  assert.equal(r.vat, 995_628n); // exact 995,628.375 rounds down
  assert.equal(r.total, 14_270_673n);
});

test("G2: same as G1, VAT off", () => {
  const r = compute(
    [{ qtyMilli: 3000n, unitKobo: 4_500_000n }, { qtyMilli: 1000n, unitKobo: 1_250_050n }],
    { kind: "percent", bp: 1000n }, VAT_OFF);
  assert.equal(r.vat, 0n);
  assert.equal(r.total, 13_275_045n);
});

test("G3: VAT rounding at 6, 7 and 20 kobo", () => {
  assert.equal(compute(one(6n), NONE, VAT_ON).vat, 0n); // 0.45
  assert.equal(compute(one(7n), NONE, VAT_ON).vat, 1n); // 0.525
  assert.equal(compute(one(20n), NONE, VAT_ON).vat, 2n); // 1.5
});

test("G4: 90.00% accepted, 90.01% rejected", () => {
  assert.doesNotThrow(() => compute(one(100_000n), { kind: "percent", bp: 9000n }, VAT_OFF));
  assert.throws(() => compute(one(100_000n), { kind: "percent", bp: 9001n }, VAT_OFF),
    (e) => code(e) === "DISCOUNT_PERCENT_RANGE");
  assert.throws(() => compute(one(100_000n), { kind: "percent", bp: -1n }, VAT_OFF),
    (e) => code(e) === "DISCOUNT_PERCENT_RANGE");
});

test("G5: fixed discount = subtotal gives zero total (not issuable); +1 kobo rejected", () => {
  const r = compute(one(100_000n), { kind: "fixed", kobo: 100_000n }, VAT_ON);
  assert.equal(r.base, 0n); assert.equal(r.vat, 0n); assert.equal(r.total, 0n);
  assert.equal(canIssue(r.total), false);
  assert.throws(() => compute(one(100_000n), { kind: "fixed", kobo: 100_001n }, VAT_ON),
    (e) => code(e) === "DISCOUNT_FIXED_RANGE");
});

test("G6: quantity 2.5 x 1,000.01 rounds half-up to 250,003 kobo", () => {
  const r = compute([{ qtyMilli: 2500n, unitKobo: 100_001n }], NONE, VAT_OFF);
  assert.equal(r.lineTotals[0], 250_003n);
});

test("G7: base 100,000.00, VAT on, 5% WHT on pre-VAT base, paid by transfer", () => {
  const r = compute(one(10_000_000n), NONE, VAT_ON);
  assert.equal(r.vat, 750_000n);
  assert.equal(r.total, 10_750_000n);
  const wht = suggestWht(r.base, 500n);
  assert.equal(wht, 500_000n);
  assert.deepEqual(settle(r.total, wht), { cash: 10_250_000n, wht: 500_000n });
});

test("invalid and outlier inputs are rejected, never wrapped or negated", () => {
  const bad = (lines: Parameters<typeof compute>[0], c: string) =>
    assert.throws(() => compute(lines, NONE, VAT_OFF), (e) => code(e) === c);
  bad([], "LINES_COUNT");
  bad(Array.from({ length: MAX_LINES + 1 }, () => ({ qtyMilli: 1000n, unitKobo: 1n })), "LINES_COUNT");
  bad([{ qtyMilli: 0n, unitKobo: 1n }], "QTY_RANGE");
  bad([{ qtyMilli: -1000n, unitKobo: 1n }], "QTY_RANGE");
  bad([{ qtyMilli: 1000n, unitKobo: -1n }], "PRICE_RANGE");
  bad([{ qtyMilli: 1000n, unitKobo: MAX_DOC_KOBO + 1n }], "PRICE_RANGE");
  bad([{ qtyMilli: 2000n, unitKobo: MAX_DOC_KOBO }], "DOC_LIMIT");
  assert.throws(() => settle(100n, 101n), (e) => code(e) === "WHT_RANGE");
  assert.throws(() => compute(one(1n), NONE, { enabled: true, rateBp: 10001n }), (e) => code(e) === "VAT_RATE_RANGE");
});

test("200 line items: totals reconcile to lines", () => {
  const lines = Array.from({ length: 200 }, (_, i) => ({ qtyMilli: BigInt(1000 + i), unitKobo: BigInt(1 + i * 37) }));
  const r = compute(lines, { kind: "percent", bp: 250n }, VAT_ON);
  assert.equal(r.lineTotals.reduce((a, b) => a + b, 0n), r.subtotal);
  assert.equal(r.base + r.vat, r.total);
});

test("property: 5,000 seeded random documents match an independent divmod oracle", () => {
  // Oracle rounds half-up with quotient/remainder (a different algorithm from halfUp()).
  const oracle = (num: bigint, den: bigint) => { const q = num / den, r = num % den; return 2n * r >= den ? q + 1n : q; };
  let s = 123456789n;
  const rnd = (n: bigint) => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return (s >> 11n) % n; };
  for (let i = 0; i < 5000; i++) {
    const n = Number(rnd(8n)) + 1;
    const lines = Array.from({ length: n }, () => ({ qtyMilli: rnd(50_000n) + 1n, unitKobo: rnd(50_000_000n) }));
    const bp = rnd(9001n);
    const vatBp = rnd(2001n);
    const r = compute(lines, { kind: "percent", bp }, { enabled: true, rateBp: vatBp });
    const lt = lines.map((l) => oracle(l.qtyMilli * l.unitKobo, 1000n));
    const sub = lt.reduce((a, b) => a + b, 0n);
    const disc = oracle(sub * bp, 10000n);
    const base = sub - disc;
    const v = oracle(base * vatBp, 10000n);
    assert.deepEqual(r, { lineTotals: lt, subtotal: sub, discount: disc, base, vat: v, total: base + v });
    assert.ok(r.total >= 0n && r.discount <= r.subtotal);
  }
});
