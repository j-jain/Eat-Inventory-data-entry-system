# Deploying EAT Inventory (Vercel + Neon)

The app is a single Next.js deployable. Production runs on **Vercel** with a managed
Postgres database — here, **Supabase**. The DB layer is provider-agnostic
([lib/db/index.ts](lib/db/index.ts) uses `node-postgres` for any `DATABASE_URL`, with
SSL), so **no code changes are needed** — it's the same DB the app already uses locally.
(Local dev can fall back to PGlite, but PGlite is file-based and cannot run on Vercel.)

## 1. Database — Supabase

Supabase gives two connection strings (Project → **Settings → Database → Connection
string**). You need both:

- **Transaction pooler** (`...pooler.supabase.com:6543`, *Transaction* mode) → use as
  the app's `DATABASE_URL` on **Vercel**. Serverless functions open many short-lived
  connections; the pooler (Supavisor) absorbs that. The ledger's `SELECT … FOR UPDATE`
  runs inside a `db.transaction()`, which transaction-mode pooling fully supports.
- **Direct** (`db.<ref>.supabase.co:5432`) → use only for **running migrations**
  (step 4), since DDL/multi-statement migration runs want a direct session.

SSL is already handled by the app (`ssl: { rejectUnauthorized: false }` for any
non-localhost URL — exactly what Supabase needs). Mumbai region (`ap-south-1`) pairs
well with Vercel's `bom1`.

## 2. Zoho — a dedicated read-only Self-Client

Don't reuse eat-os's token (if eat-os rotates/revokes it, this app breaks). Create a
dedicated, least-privilege client:

1. Go to the Zoho API console (`https://api-console.zoho.in` for the `in` DC) →
   **Add Client → Self Client**.
2. Note the **Client ID** and **Client Secret**.
3. Under **Generate Code**, request these READ-only scopes (comma-separated), pick a
   duration, and generate a grant code:
   ```
   ZohoInventory.items.READ,ZohoInventory.purchaseorders.READ,ZohoInventory.contacts.READ,ZohoBooks.contacts.READ,ZohoBooks.invoices.READ
   ```
4. Exchange the grant code for a **refresh token** (one-time curl):
   ```bash
   curl -X POST "https://accounts.zoho.in/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=GRANT_CODE_FROM_STEP_3"
   ```
   Save the `refresh_token` from the response (it's long-lived).
5. Find your **Organization ID** in Zoho Inventory → Settings → Organizations.

## 3. Vercel — environment variables

In the Vercel project settings (Production scope):

| Var | Value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** string (`...pooler.supabase.com:6543`) |
| `DB_POOL_MAX` | optional; keep small on serverless (e.g. `3`) |
| `SESSION_SECRET` | long random string (session JWT signing) |
| `PIN_PEPPER` | long random string (PIN hashing) |
| `ZOHO_ENABLED` | `true` |
| `ZOHO_DC` | `in` |
| `ZOHO_ORG_ID` | your org id |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` | from step 2 |
| `CRON_SECRET` | long random string (guards the daily sync endpoint) |

> **Reset button:** while the system is in its testing phase, the destructive
> "reset test data" panel (Admin → Zoho Sync) is always available to ADMIN users —
> no env flag needed. **Before going live with real data**, re-gate it (restore an
> `ALLOW_RESET` check in `actions/admin.ts` + `app/(app)/admin/sync/page.tsx`) or
> remove the panel entirely.

## 4. Migrate + seed (against Supabase)

From your machine, using the **direct** connection string (port 5432, *not* the
pooler):

```bash
DATABASE_URL="<supabase-direct-url>" npm run db:migrate
DATABASE_URL="<supabase-direct-url>" npm run db:seed   # 387 SKUs + default users
```

(If your Supabase project is already seeded from local dev, you can skip the seed.)

Default logins seeded: `Admin / 1234`, `Supervisor / 1111`, `Ramesh / 0000` — change
the PINs after first login.

## 5. Deploy + first sync

1. Push to the connected Git repo (or `vercel --prod`). Vercel builds and deploys.
2. The daily cron auto-registers from `vercel.json`
   (`/api/cron/sync` at **01:00 UTC = 06:30 IST**).
3. Do a one-time **full** pull: in the app, **Admin → Zoho Sync → Pull Everything**
   (or hit the cron endpoint manually, see below). After that, the nightly job runs
   **incrementally** (only what changed since the last run).
4. Restore opening stock once items are synced (direct connection string):
   ```bash
   DATABASE_URL="<supabase-direct-url>" npx tsx scripts/backfill-opening-balance.ts
   ```

## 6. Verify the scheduled sync

```bash
# 401 without the secret:
curl -i https://YOUR_APP.vercel.app/api/cron/sync
# runs with the secret (same value as CRON_SECRET):
curl -s https://YOUR_APP.vercel.app/api/cron/sync -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Then check **Admin → Zoho Sync → Recent syncs** — each run is logged there (entity,
rows, time, error). Incremental runs after the first full pull should report ~0 rows
when nothing changed in Zoho.

## Notes

- Vercel cron runs in **UTC**; `0 1 * * *` = 06:30 IST. Change the schedule in
  `vercel.json` if your timezone differs.
- The Hobby plan allows one daily cron and a 60s function limit; incremental sync stays
  well under it. If a first full pull is ever too slow, run the per-entity buttons once.
- Zoho stays **read-only** in v1 — nothing is ever written back (enforced by
  `lib/zoho/guard`).
