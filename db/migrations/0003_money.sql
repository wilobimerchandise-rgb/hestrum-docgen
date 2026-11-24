-- 0003_money.sql: Hestrum DocGen Playbook v6.0, section 8 (money engine, database side). The database is the authority.
-- Mirrors src/money.ts exactly: same order of steps, same limits, same error codes, same rounding.
-- Money is whole kobo, quantity is thousandths, rates are basis points. Amounts travel as strings in JSON.
-- All arithmetic uses numeric, so qty x price (up to 10^21) can never overflow bigint. Pure functions: no table access.

-- Limits (configurable per business in the playbook; fixed here until the settings table exists).
create function money_max_doc_kobo() returns numeric language sql immutable as $$ select 1000000000000::numeric $$;  -- N10,000,000,000.00
create function money_max_qty_milli() returns numeric language sql immutable as $$ select 1000000000::numeric $$;     -- 1,000,000.000 units
create function money_max_lines() returns int language sql immutable as $$ select 500 $$;

-- Round-half-up of num/den. Domain: num >= 0, den > 0. Applied once per computed amount.
create function money_half_up(p_num numeric, p_den numeric) returns numeric
language plpgsql immutable as $$
begin
  if p_num is null or p_den is null or p_num < 0 or p_den <= 0 then
    raise exception 'ROUNDING_DOMAIN' using errcode = 'P0001';
  end if;
  return div(2 * p_num + p_den, 2 * p_den);
end $$;

-- Whole non-negative integer text, up to 30 digits, else NULL. Rejects signs, decimals, exponents, spaces.
create function money_parse(p_text text) returns numeric
language sql immutable as $$ select case when p_text ~ '^[0-9]{1,30}$' then p_text::numeric else null end $$;

-- The only calculation order (playbook 8.2).
--   p_lines          : JSON array of {"qty_milli": "3000", "unit_kobo": "4500000"} (strings)
--   p_discount_kind  : 'none' | 'percent' | 'fixed'
--   p_discount_value : basis points for 'percent', kobo for 'fixed', ignored for 'none'
--   p_vat_enabled    : whether VAT is on for this document; p_vat_rate_bp the rate in basis points
-- Returns {line_totals: [..], subtotal, discount, base, vat, total}, every amount a string of whole kobo.
create function compute_totals(
  p_lines jsonb, p_discount_kind text, p_discount_value bigint, p_vat_enabled boolean, p_vat_rate_bp bigint
) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  n int; i int; q numeric; u numeric; t numeric;
  totals text[] := '{}'; subtotal numeric := 0; discount numeric := 0; base numeric; vat numeric := 0; total numeric;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'LINES_COUNT' using errcode = 'P0001'; end if;
  n := jsonb_array_length(p_lines);
  if n < 1 or n > money_max_lines() then raise exception 'LINES_COUNT' using errcode = 'P0001'; end if;

  for i in 0 .. n - 1 loop
    q := money_parse(p_lines -> i ->> 'qty_milli');
    if q is null or q <= 0 or q > money_max_qty_milli() then raise exception 'QTY_RANGE' using errcode = 'P0001'; end if;
    u := money_parse(p_lines -> i ->> 'unit_kobo');
    if u is null or u > money_max_doc_kobo() then raise exception 'PRICE_RANGE' using errcode = 'P0001'; end if;
    t := money_half_up(q * u, 1000);
    if t > money_max_doc_kobo() then raise exception 'DOC_LIMIT' using errcode = 'P0001'; end if;
    totals := totals || t::text;
    subtotal := subtotal + t;
  end loop;
  if subtotal > money_max_doc_kobo() then raise exception 'DOC_LIMIT' using errcode = 'P0001'; end if;

  if p_discount_kind = 'percent' then
    if p_discount_value is null or p_discount_value < 0 or p_discount_value > 9000 then
      raise exception 'DISCOUNT_PERCENT_RANGE' using errcode = 'P0001';
    end if;
    discount := money_half_up(subtotal * p_discount_value, 10000);
  elsif p_discount_kind = 'fixed' then
    if p_discount_value is null or p_discount_value < 0 or p_discount_value > subtotal then
      raise exception 'DISCOUNT_FIXED_RANGE' using errcode = 'P0001';
    end if;
    discount := p_discount_value;
  elsif p_discount_kind is distinct from 'none' then
    raise exception 'DISCOUNT_KIND_INVALID' using errcode = 'P0001';
  end if;

  base := subtotal - discount;

  if coalesce(p_vat_enabled, false) then
    if p_vat_rate_bp is null or p_vat_rate_bp < 0 or p_vat_rate_bp > 10000 then
      raise exception 'VAT_RATE_RANGE' using errcode = 'P0001';
    end if;
    vat := money_half_up(base * p_vat_rate_bp, 10000);
  end if;

  total := base + vat;
  if total > money_max_doc_kobo() then raise exception 'DOC_LIMIT' using errcode = 'P0001'; end if;

  return jsonb_build_object(
    'line_totals', to_jsonb(totals), 'subtotal', subtotal::text, 'discount', discount::text,
    'base', base::text, 'vat', vat::text, 'total', total::text);
end $$;

-- Issuing rule: total must be greater than zero.
create function can_issue(p_total bigint) returns boolean
language sql immutable as $$ select coalesce(p_total > 0, false) $$;

revoke execute on function
  money_max_doc_kobo(), money_max_qty_milli(), money_max_lines(), money_half_up(numeric, numeric), money_parse(text),
  compute_totals(jsonb, text, bigint, boolean, bigint), can_issue(bigint)
  from public, anon;
grant execute on function
  money_half_up(numeric, numeric), compute_totals(jsonb, text, bigint, boolean, bigint), can_issue(bigint)
  to authenticated;
