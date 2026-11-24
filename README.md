# Hestrum DocGen

Quotations, invoices, receipts, credit notes and waybills for Hestrum Projects & Services Limited.
Built step by step from the Hestrum DocGen Expert Prompt Playbook v6.0. This repository holds the tested core so far.

## What is in the repository

| Path | What it is | Playbook |
| --- | --- | --- |
| `src/money.ts` | Money engine: integer kobo, basis points, quantity in thousandths, one rounding rule | Section 8 |
| `src/money.test.ts` | Golden vectors G1 to G7, invalid and outlier inputs, 5,000-case property test | Section 8.5 |
| `db/migrations/0000_profiles.sql` | Staff profiles, exactly one active Owner | Section 10.1 |
| `db/migrations/0001_subscription.sql` | Annual-only subscription, derived access mode, hidden Developer functions, maintenance log | Section 9 and Appendix B |
| `db/migrations/0002_roles_audit.sql` | Capability catalogue, roles, caps, four-eyes, fresh MFA, audit log | Section 10.1 |
| `db/tests/` | SQL tests that run the migrations in an in-memory Postgres (PGlite) | Appendix B, section 10.1 |
| `.github/workflows/ci.yml` | Runs `npm test` on every push and pull request | |

## Requirements

Node.js 22.18 or newer (the tests run TypeScript directly). PostgreSQL 15 or newer for the migrations (Supabase).

## Run the tests

```
npm install
npm test
```

`npm test` runs the type check, the money tests, then the SQL tests. It must exit with code 0.
Single parts: `npm run typecheck`, `npm run test:money`, `npm run test:sql`.

## Apply the migrations

Run the files in `db/migrations/` in name order, once, on an empty Supabase project: `0000`, then `0001`, then `0002`.
Never edit a migration that has been applied; add a new numbered file instead.

## Go-live bootstrap (done once, by the Developer, in the Supabase SQL editor)

Use the values frozen in the Phase 0 decision log (C2, C4 to C8). The numbers below are the draft values from Playbook section 1.
Replace `OWNER-USER-ID` with the Owner's id from Authentication > Users after the Owner has been invited.

```sql
-- 1. Frozen commercial configuration (draft values: trial 14 days, grace 7 days, reminders 30/7/1, price notice 30 days)
insert into commercial_config (trial_days, grace_days, reminder_days, price_notice_days)
values (14, 7, '{30,7,1}', 30);

-- 2. Annual fee in kobo (C2 x 100). Draft value: 1,000,000 naira
insert into plan_prices (effective_from, annual_fee_kobo) values ('2000-01-01', 100000000);

-- 3. The Owner profile (exactly one)
insert into profiles (user_id, full_name, role, role_id)
values ('OWNER-USER-ID', 'Owner full name', 'owner', (select id from roles where is_owner));

-- 4. Start the subscription with the free trial (C4 = none). For included access, use an annual row instead (see 0001).
insert into subscription (plan, trial_ends_at) values ('trial', now() + interval '14 days');

-- 5. Register the Developer account as a platform admin (never a profile)
insert into platform_admins (user_id) values ('DEVELOPER-USER-ID');
```

Afterwards the Owner signs in, sets a cap for the Cashier and Deputy approver roles (they have no authority until a cap is set),
and assigns staff roles in Settings > Team.

## Rules this code follows

- Money is always whole kobo as `bigint`. No floating point anywhere.
- Identity and role come from the server session, never from anything the browser sends.
- Access mode (full, read only, blocked) is derived from dates with the database clock.
- Audit, maintenance, price and payment records cannot be updated or deleted.
