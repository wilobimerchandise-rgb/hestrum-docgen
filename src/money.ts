// money.ts — Hestrum DocGen money engine (reference implementation, complete file).
// Units: money = integer kobo (bigint); quantity = thousandths (bigint); rates = basis points (bigint).
// No JavaScript Number is used anywhere. The Postgres function remains the authority;
// this file must match it on every golden vector (G1–G7) and on the property test.

export const MAX_DOC_KOBO = 1_000_000_000_000n; // ₦10,000,000,000.00 (configurable per business)
export const MAX_QTY_MILLI = 1_000_000_000n; // 1,000,000.000 units
export const MAX_LINES = 500;

export type Discount =
  | { kind: "none" }
  | { kind: "percent"; bp: bigint }
  | { kind: "fixed"; kobo: bigint };

export type Line = { qtyMilli: bigint; unitKobo: bigint };
export type Vat = { enabled: boolean; rateBp: bigint };

export type MoneyErrorCode =
  | "ROUNDING_DOMAIN"
  | "LINES_COUNT"
  | "QTY_RANGE"
  | "PRICE_RANGE"
  | "DISCOUNT_PERCENT_RANGE"
  | "DISCOUNT_FIXED_RANGE"
  | "VAT_RATE_RANGE"
  | "WHT_RATE_RANGE"
  | "WHT_RANGE"
  | "DOC_LIMIT";

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode) {
    super(code);
    this.name = "MoneyError";
    this.code = code;
  }
}

/** Round-half-up of num/den. Domain: num >= 0, den > 0. */
export function halfUp(num: bigint, den: bigint): bigint {
  if (num < 0n || den <= 0n) throw new MoneyError("ROUNDING_DOMAIN");
  return (2n * num + den) / (2n * den); // bigint "/" truncates; safe because operands are non-negative
}

export type Computed = {
  lineTotals: bigint[];
  subtotal: bigint;
  discount: bigint;
  base: bigint;
  vat: bigint;
  total: bigint;
};

/** The only calculation order (spec section 7.2). Every amount is rounded once, never on a running total. */
export function compute(lines: Line[], d: Discount, vat: Vat): Computed {
  if (lines.length < 1 || lines.length > MAX_LINES) throw new MoneyError("LINES_COUNT");

  const lineTotals = lines.map((l) => {
    if (l.qtyMilli <= 0n || l.qtyMilli > MAX_QTY_MILLI) throw new MoneyError("QTY_RANGE");
    if (l.unitKobo < 0n || l.unitKobo > MAX_DOC_KOBO) throw new MoneyError("PRICE_RANGE");
    const t = halfUp(l.qtyMilli * l.unitKobo, 1000n);
    if (t > MAX_DOC_KOBO) throw new MoneyError("DOC_LIMIT");
    return t;
  });

  const subtotal = lineTotals.reduce((a, b) => a + b, 0n);
  if (subtotal > MAX_DOC_KOBO) throw new MoneyError("DOC_LIMIT");

  let discount = 0n;
  if (d.kind === "percent") {
    if (d.bp < 0n || d.bp > 9000n) throw new MoneyError("DISCOUNT_PERCENT_RANGE");
    discount = halfUp(subtotal * d.bp, 10000n);
  } else if (d.kind === "fixed") {
    if (d.kobo < 0n || d.kobo > subtotal) throw new MoneyError("DISCOUNT_FIXED_RANGE");
    discount = d.kobo;
  }

  const base = subtotal - discount;

  let vatKobo = 0n;
  if (vat.enabled) {
    if (vat.rateBp < 0n || vat.rateBp > 10000n) throw new MoneyError("VAT_RATE_RANGE");
    vatKobo = halfUp(base * vat.rateBp, 10000n);
  }

  const total = base + vatKobo;
  if (total > MAX_DOC_KOBO) throw new MoneyError("DOC_LIMIT");
  return { lineTotals, subtotal, discount, base, vat: vatKobo, total };
}

/** Issuing rule: total must be greater than zero. */
export function canIssue(total: bigint): boolean {
  return total > 0n;
}

/** Suggested WHT on the PRE-VAT base. The Owner enters the final figure; this is only a helper. */
export function suggestWht(base: bigint, rateBp: bigint): bigint {
  if (rateBp < 0n || rateBp > 10000n) throw new MoneyError("WHT_RATE_RANGE");
  return halfUp(base * rateBp, 10000n);
}

/** Settlement of an invoice: cash/transfer + WHT must equal the invoice total. */
export function settle(total: bigint, whtKobo: bigint): { cash: bigint; wht: bigint } {
  if (whtKobo < 0n || whtKobo > total) throw new MoneyError("WHT_RANGE");
  return { cash: total - whtKobo, wht: whtKobo };
}
