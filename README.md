# EAT Inventory — Data-Entry System

Replaces EAT's 7 handwritten storage-room ops sheets + end-of-day manual Zoho
re-keying with a single web app: **dropdowns-only entry, validation at entry
time, a live inventory, and a full immutable audit trail.** Built so one bad
entry can't silently corrupt inventory.

## Stack

- **Next.js (App Router, TypeScript)** — UI + secure server in one deployable
- **Postgres** via **Drizzle ORM** — Neon in production; **PGlite** in-process
  for local dev (no external DB needed)
- **Tailwind** UI, **decimal.js** for exact quantity math, **jose**/**bcryptjs** for PIN auth

## How it works

```
Zoho PO ─▶ Receiving ─▶ Sorting (A/B/C; waste auto = received−A−B−C) ─▶ cold-room stock
                                                                  ▼
                                   DC Assembly (Blinkit / Spencer's / Bulk): Used = Out − In
                                                                  ▼
                                   Finished goods ─▶ Dispatch ─▶ Returns (match Zoho invoice)
   Wastage (hub)         Inventory Adjustment (tie-out + manual ±)
```

- **Stock = total qty per mother SKU** (cold room) + per pack SKU (finished goods).
  Grades A/B/C are recorded at sorting **as data** (no per-grade balances in v1).
- **Append-only ledger** is the single source of truth; `stock_balance` is a
  cache updated in the same transaction. Every out-movement is **hard-blocked**
  below zero (atomic `SELECT … FOR UPDATE`); a **supervisor** can override via an
  adjustment. Corrections are **reversing entries**, never destructive edits.
- **Idempotent submits** (client token) survive weak wifi. Every row is
  timestamped (IST) and attributed to the logged-in user.
- **Zoho is READ-ONLY in v1** — items/stock/POs/vendors/customers/invoices are
  pulled in; nothing is ever written back (enforced by `lib/zoho/guard`).

## Local quick start

```bash
npm install
npm run db:migrate     # creates schema in ./.pglite-data (local PGlite)
npm run db:seed        # 387 SKUs from the eat-os master + 7-sheet overlay, + users
npm run dev            # http://localhost:3000
```

Default logins (change after first login, in Admin):
`Admin / 1234`, `Supervisor / 1111`, `Ramesh / 0000`.

## Deploy (Vercel + Supabase)

**Full step-by-step (Supabase, dedicated read-only Zoho self-client, env vars, daily
06:30 IST auto-sync): see [DEPLOY.md](DEPLOY.md).** Quick version:

1. Create a managed Postgres DB (Supabase); copy the connection string.
2. Set Vercel env vars: `DATABASE_URL`, `SESSION_SECRET`, `PIN_PEPPER`
   (and the `ZOHO_*` vars when you want Zoho reads — see `.env.example`).
3. Apply migrations against Supabase (use the **direct** connection string):
   `DATABASE_URL=... npm run db:migrate`, then `DATABASE_URL=... npm run db:seed`.
4. Deploy. Share the URL — staff log in with name + PIN, no install.

When Zoho is configured, run **Admin → Zoho Sync** to pull catalog/POs/vendors/
customers/invoices, then `npx tsx scripts/backfill-opening-balance.ts`
(opening balances from Zoho stock).

## Scripts

| script | purpose |
|---|---|
| `npm run db:generate` | regenerate Drizzle migrations from schema |
| `npm run db:migrate` | apply migrations (Neon if `DATABASE_URL`, else PGlite) |
| `npm run db:seed` | seed SKUs + users |
| `npm run db:reset` | clear transactional data (keep SKUs/users) |
| `npm test` | ledger unit tests (over-draw, void, reconcile, append-only…) |

## Deferred (later phase)

Writing back to Zoho (bills / adjustments / credit notes), grade→finished-SKU
routing, vendor-quality scorecards from grade data, PWA offline queue.
