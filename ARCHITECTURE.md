# EAT Inventory — Architecture & File Guide

This doc is a complete map of the codebase: what the app is for, how data flows,
what every file does, how the Zoho "connector" works, the full database schema,
and every page/tab in the UI. See also [README.md](README.md) (quick start) and
[DEPLOY.md](DEPLOY.md) (production deploy steps) — this file goes deeper.

## 1. The goal

EAT ran its storage-room operations on **7 handwritten paper sheets** (receiving,
sorting, DC assembly for 3 channels, wastage, returns) plus a manual end-of-day
re-typing of everything into Zoho. That process had no validation — a typo could
silently corrupt inventory, and there was no live view of stock.

This app replaces all 7 sheets with **one web app**:
- Dropdown-only entry (SearchSelect) — nobody can type a free-text SKU/vendor/reason, only pick from what exists.
- Every entry is validated **at save time** (can't oversort, can't sell more than in stock, decimal-exact math — no floating point drift).
- Stock is **live** — the dashboard polls every 12s.
- Every change is **audited forever** — an append-only ledger, never edited or deleted; corrections are reversing entries, not overwrites.
- It works on unreliable warehouse wifi — every submit carries a client-generated idempotency token, so a retried request can't double-post.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16.2.9 (App Router), React 19.2.4, TypeScript | UI + server actions in one deployable |
| Database | Postgres via Drizzle ORM (`drizzle-orm` 0.45) | `node-postgres` in production; **PGlite** (in-process WASM Postgres) for local dev — no external DB needed |
| Hosting | Vercel, region `bom1` (Mumbai) | Pairs with Supabase's `ap-south-1` |
| Prod DB | Supabase Postgres | Transaction pooler for the app, direct connection for migrations |
| Precision math | `decimal.js` | All qty/money arithmetic is exact decimal, never native float |
| Auth | `jose` (JWT session cookie) + `bcryptjs` (PIN hashing) | Lightweight PIN login, no external IdP |
| Styling | Tailwind CSS v4 | |
| Validation | `zod` | Every server action parses/validates its input |
| Zoho integration | Plain `fetch` (no SDK) | Zoho Inventory + Zoho Books REST APIs |
| Tests | `vitest` | Ledger unit tests (over-draw, void, reconcile, append-only) |

## 3. Data flow (the operational pipeline)

```
Zoho PO ──▶ Receiving ──▶ Sorting (A/B/C; waste auto = received − A − B − C) ──▶ Cold Room stock
                                                                       │
                                        DC Assembly (Blinkit / Spencer's / Bulk Fruit)
                                              Used = Out − In  (consumes mother, produces packs)
                                                                       │
                                        Finished Goods ──▶ Dispatch (not yet built) ──▶ Returns (match Zoho invoice)

   Wastage (hub — records waste from anywhere)      Inventory Adjustment (PO/bill tie-out + manual ± + supervisor override)
```

- **Two locations only**: `COLD_ROOM` (raw/mother stock) and `DC_FLOOR_FG` (finished packs).
- **Stock = total qty per SKU per location.** Grades A/B/C are recorded as *data* on the sorting line, not as separate stock buckets, in v1.
- **`stock_ledger`** (append-only) is the single source of truth. **`stock_balance`** is a mutable cache, always updated in the same DB transaction as the ledger insert, and guarded by a `qty >= 0` CHECK constraint.
- Every out-movement is **hard-blocked** below zero via `SELECT ... FOR UPDATE` inside a transaction (`lib/ledger/post.ts`); only an ADMIN adjustment can force it negative-to-zero-correcting (`allowNegative`).
- Corrections are **reversing entries** (`voidDocumentLedger`) — nothing is ever destructively edited.

## 4. The Zoho "connector"

The app treats Zoho (Zoho **Inventory** for items/stock/vendors/POs, Zoho **Books** for customers/invoices) as an external system of record it mostly *reads from*.

### Guarantee: hard read-only, with one narrow, explicit exception

| File | Role |
|---|---|
| [lib/zoho/config.ts](lib/zoho/config.ts) | Env-driven config (`ZOHO_DC`, `ZOHO_ORG_ID`, client id/secret/refresh token); `zohoConfig.enabled` gates everything |
| [lib/zoho/token.ts](lib/zoho/token.ts) | OAuth token refresh, cached in the `zoho_token` table (+ an in-process memo) since serverless instances are ephemeral |
| [lib/zoho/guard.ts](lib/zoho/guard.ts) | `assertReadOnly(method)` — throws on anything but `GET`. Every read call routes through this |
| [lib/zoho/client.ts](lib/zoho/client.ts) | `zohoGet` (paced/retrying GET: 401→refresh, 429→backoff, 5xx→retry) and `zohoPaged` (pages a list endpoint) |
| [lib/zoho/write-guard.ts](lib/zoho/write-guard.ts) | `assertDraftCreate(method, path)` — the **only** exception to read-only: allows `POST` to an explicit allowlist (currently just `/inventory/v1/inventoryadjustments`). Any other method or path throws |
| [lib/zoho/write.ts](lib/zoho/write.ts) | `zohoCreateDraft` — the **one** write function in the whole codebase. Conservative retries (never retries a transport error/5xx, since a POST isn't idempotent) |
| [lib/zoho/drafts.ts](lib/zoho/drafts.ts) | Per-doc-type "build a Zoho draft payload" functions. Only `INV_ADJUSTMENT` is wired; Receiving/Assembly/Wastage/Return throw `NotMappedError` until specified |
| [lib/zoho/sync.ts](lib/zoho/sync.ts) | Bulk **read** sync: `syncItems`, `syncVendors`, `syncCustomers`, `syncPurchaseOrders`. Each logs to `sync_log`; `lastSyncAt()` reads that log as the incremental watermark (no separate state table) |
| [lib/zoho/reads.ts](lib/zoho/reads.ts) | On-demand reads not worth bulk-caching: `fetchCustomerInvoices`, `getInvoiceDetail` (used live by the Returns tab) |

There is **no update/delete function anywhere** in `lib/zoho`. There's no way to accidentally add one either — every write attempt must pass `assertDraftCreate`, and every read must pass `assertReadOnly`.

### What's actually synced (and what isn't)

Sync is deliberately **lean**, not a full mirror of Zoho:
- **Items**: only Zoho items that match an existing EAT SKU by normalized code are cached; everything else is skipped (no catalog bloat). Matching sets `skus.zoho_item_id`.
- **Purchase orders**: only *open* (not closed/cancelled/fully-received) POs are kept; line-item detail is fetched only for those. A PO that becomes closed mid-window is deleted from the cache so it drops off the Receiving sheet.
- **Invoices**: never bulk-pulled — fetched live, per customer, only when a Returns entry needs them.
- **Vendors/customers**: full pull (small lists).

### Where Zoho touches the UI

- **Admin → Zoho Sync** ([app/(app)/admin/sync/page.tsx](app/(app)/admin/sync/page.tsx)) — manual "Pull Items/Vendors/Customers/POs/Everything" buttons ([components/SyncPanel.tsx](components/SyncPanel.tsx) → [actions/zoho.ts](actions/zoho.ts)), a table of the last 20 sync runs, and (only if `ALLOW_RESET=true`) the danger-zone reset panel.
- **Receiving** — pre-lists every open PO's lines (`lib/queries.ts: openPurchaseOrdersForReceiving`).
- **Returns** — picking a customer live-loads their recent Zoho invoices; picking an invoice live-loads its line items, pre-filling the return sheet (`actions/returns.ts`).
- **Push draft to Zoho** button (EntryForm, on Receiving/Assembly/Adjustment/Wastage/Return after a save) — calls `actions/zoho-drafts.ts: pushDraftToZoho`, which is idempotent (checks `app_audit_log` for a prior push before creating a duplicate).
- **Daily cron** (`app/api/cron/sync/route.ts`) — incremental pull of Items/Vendors/Customers/POs, scheduled by `vercel.json` at `0 1 * * *` UTC (06:30 IST), protected by a `CRON_SECRET` bearer token.

## 5. Database schema (`lib/db/schema.ts`)

Drizzle/Postgres, `numeric(14,3)` for quantities and `numeric(14,2)` for money (never floats).

### Enums
`user_role` (FLOOR/SUPERVISOR/ADMIN) · `sku_kind` (MOTHER/DERIVATIVE) · `channel` (MOTHER/BULK_FRUIT/BLINKIT/SPENCERS/OTHER) · `uom` (kg/g/pc/box/bunch/unit) · `location_kind` (COLD_ROOM/DC_FLOOR_FG/VIRTUAL) · `movement_type` (OPENING_BALANCE, RECEIPT, SORT_WASTE, REGRADE_WASTE, ASSEMBLY_CONSUME, PACK_PRODUCE, DISPATCH, RETURN_TO_MOTHER, RETURN_WASTE, WASTAGE, ADJUSTMENT_PLUS, ADJUSTMENT_MINUS, VOID_REVERSAL) · `doc_type` (RECEIVING, SORTING, ASSEMBLY, WASTAGE, RETURN, INV_ADJUSTMENT, DISPATCH, PURCHASE_ORDER, OPENING) · `doc_status` (DRAFT/POSTED/VOIDED) · `return_disposition` (RESALABLE/WASTE) · `wastage_source` (SORTING/REGRADE/ASSEMBLY/RETURN/EXPIRY/GENERAL) · `adj_kind` (TIE_OUT/OVERRIDE/MANUAL) · `return_match` (MATCHED/PENDING_MATCH)

### Core tables

| Table | Purpose |
|---|---|
| `users` | PIN-login users: `full_name`, `pin_hash`, `role`, lockout (`attempts`, `locked_until`) |
| `skus` | SKU master. `code`/`normalized_code` (unique), `sku_kind`, `channel`, `mother_sku_id` (self-FK, derivative → mother), `mother_core`, pack-size fields, `uom`, `zoho_item_id` (link once synced), `source` (LOCAL/ZOHO) |
| `locations` | Just `COLD_ROOM` and `DC_FLOOR_FG` (seeded from `lib/constants.ts`) |
| `stock_balance` | **Mutable cache**, one row per (sku, location); `CHECK qty >= 0`; unique on (sku_id, location_id) |
| `stock_ledger` | **Append-only source of truth.** Every row: signed qty, `balance_after` snapshot, `doc_type`/`doc_id` back-reference, `reverses_ledger_id` (for voids), business date, user. `CHECK qty_signed <> 0` |

### Document tables (one header + one line table per sheet, all sharing `docHeaderCols`: status, business date, note, creator, `client_token` for idempotency, void fields)

| Doc | Header | Line | Notes |
|---|---|---|---|
| Receiving | `receiving_doc` (vendor, PO/PR no., `zoho_po_id`) | `receiving_line` (sku, accepted qty, PO expected qty) | |
| Sorting/Regrade | `sorting_doc` (`is_recheck` flag) | `sorting_line` (sorted qty, qty A/B/C, **`qty_waste` is a generated column** = sorted − (A+B+C)) | Same tables serve both Sorting and Regrade tabs; `is_recheck` distinguishes them |
| Assembly | `assembly_doc` (channel) | `assembly_line` (mother SKU, pack SKU, qty out/in, `total_used` — CHECK'd to equal out−in, packs made) | |
| Wastage | `wastage_doc` | `wastage_line` (sku, location, qty, reason, `source` enum, optional back-link to the doc that caused it) | Catches manual waste + is referenced by sorting/regrade/return waste via `movement_type`, not a `source_doc` link, in the current ledger |
| Return | `return_doc` (customer, `zoho_invoice_id`, `match_status`) | `return_line` (qty returned, qty weighed back, `back_to_mother_sku_id`, `disposition`) | |
| Inventory Adjustment | `inv_adjustment_doc` (vendor, `against`) | `inv_adjustment_line` (PO/received/bill quantities, `qty_to_adjust`, `adj_kind`, `unit_cost`) | |
| Dispatch | `dispatch_doc` (customer, channel, ref) | `dispatch_line` (pack SKU, qty) | Schema + action exist; UI page is a placeholder |
| Opening | `opening_doc` | — (movements posted directly) | Used once by `scripts/backfill-opening-balance.ts` |

### Zoho read-cache tables

`zoho_token` (single-row OAuth token) · `zoho_item_cache` · `zoho_vendor_cache` · `zoho_customer_cache` · `zoho_po_cache` (line items as `jsonb`) · `zoho_invoice_cache` (line items as `jsonb`) · `sync_log` (entity, status, rows pulled, error — doubles as the incremental watermark)

### Audit

`app_audit_log` — non-stock events: logins, resets, Zoho draft pushes (`action`, `doc_type`/`doc_id`, `payload` jsonb).

## 6. Pages / tabs (`app/(app)/*`)

All routes below sit inside `app/(app)/layout.tsx`, which calls `requireUser()` (redirects to `/login` if not authenticated) and renders the sidebar `Nav` + sign-out header.

| Route | File | What it does |
|---|---|---|
| `/dashboard` | [app/(app)/dashboard/page.tsx](app/(app)/dashboard/page.tsx) + [components/DashboardClient.tsx](components/DashboardClient.tsx) | Live stock split into Cold Room / Finished Goods tables, filterable, auto-refreshes every 12s via `/api/stock`. Links to per-SKU ledger. CSV export buttons |
| `/dashboard/sku/[id]` | [app/(app)/dashboard/sku/[id]/page.tsx](<app/(app)/dashboard/sku/[id]/page.tsx>) | Full immutable ledger history for one SKU (every movement, balance-after, doc reference) |
| `/receiving` | [app/(app)/receiving/page.tsx](app/(app)/receiving/page.tsx) | Every open Zoho PO's lines pre-listed (locked rows) with vendor + expected qty; staff enters accepted qty. `+ Add row` for off-PO receipts. Saves one receiving doc per PO in one batch |
| `/sorting` | [app/(app)/sorting/page.tsx](app/(app)/sorting/page.tsx) | Everything received-but-unsorted is pre-loaded; split into grade A/B/C; waste auto = received − (A+B+C) |
| `/regrade` | [app/(app)/regrade/page.tsx](app/(app)/regrade/page.tsx) | Re-grade already-sorted stock (no PO/vendor context); posts via the same `submitSorting` action with `isRecheck: true` |
| `/assembly` | [app/(app)/assembly/page.tsx](app/(app)/assembly/page.tsx) + [components/AssemblyTabs.tsx](components/AssemblyTabs.tsx) | Tabs for Blinkit / Spencer's / Bulk Fruit. Pre-lists the channel's operational pack list; `Used = Out − In`; consumes the mother SKU, produces the pack SKU |
| `/dispatch` | [app/(app)/dispatch/page.tsx](app/(app)/dispatch/page.tsx) | **Placeholder** — "Coming soon" card. Schema (`dispatch_doc`/`dispatch_line`) and `submitDispatch` action already exist, UI isn't wired |
| `/return` | [app/(app)/return/page.tsx](app/(app)/return/page.tsx) | Pick customer → live-loads recent Zoho invoices → pick invoice → pre-fills line items. Resalable → re-enters Cold Room as the mother SKU by weighed kg; Waste → recorded only |
| `/wastage` | [app/(app)/wastage/page.tsx](app/(app)/wastage/page.tsx) | Manual waste entry (item + location + qty + reason dropdown) plus a combined log of *all* waste system-wide (manual, sorting, regrade, return) |
| `/adjustment` | [app/(app)/adjustment/page.tsx](app/(app)/adjustment/page.tsx) | PO-vs-received-vs-bill tie-outs, manual ± corrections, supervisor overrides. Requires SUPERVISOR role; ADMIN can push below zero |
| `/purchase-orders` | [app/(app)/purchase-orders/page.tsx](app/(app)/purchase-orders/page.tsx) | Read-only table of open POs cached from Zoho |
| `/admin/skus` | [app/(app)/admin/skus/page.tsx](app/(app)/admin/skus/page.tsx) + [components/SkuAdmin.tsx](components/SkuAdmin.tsx) | ADMIN-only. Add SKUs, toggle active/inactive (inactive SKUs drop out of entry dropdowns but history is kept) |
| `/admin/sync` | [app/(app)/admin/sync/page.tsx](app/(app)/admin/sync/page.tsx) | ADMIN-only. Manual Zoho pull buttons, last-20-syncs log table, danger-zone reset (only rendered if `ALLOW_RESET=true`) |
| `/login` | [app/login/page.tsx](app/login/page.tsx) + [components/PinLogin.tsx](components/PinLogin.tsx) | Pick your name (SearchSelect) + 4-digit PIN keypad. 5 wrong attempts → 60s lockout |
| `/` | [app/page.tsx](app/page.tsx) | Redirects to `/dashboard` |

### API routes (`app/api/*`)

| Route | Purpose |
|---|---|
| `GET /api/stock` | Session-gated JSON feed of `liveStock()` — polled by the dashboard every 12s |
| `GET /api/export/[sheet]` | CSV export. `sheet=grades` → grade-composition report; anything else → the full ledger (with optional `from`/`to` date filters) |
| `GET /api/cron/sync` | Daily incremental Zoho pull, `CRON_SECRET`-protected, triggered by Vercel Cron per `vercel.json` |

## 7. Server actions (`actions/*`)

All files are `"use server"` modules — the only way the client mutates data.

| File | Exports | Purpose |
|---|---|---|
| [actions/entries.ts](actions/entries.ts) | `submitReceiving`, `submitReceivingBatch`, `submitSorting`, `submitAssembly`, `submitWastage`, `submitReturn`, `submitAdjustment`, `submitDispatch`, `voidDocument` | The core write path for every sheet. Each: `zod`-validates input, opens a `db.transaction`, inserts the doc+line rows, computes `MovementInput[]`, calls `applyMovements`, flips the doc to `POSTED`, revalidates the relevant paths. `voidDocument` reverses a posted doc's ledger entries (SUPERVISOR+) |
| [actions/zoho.ts](actions/zoho.ts) | `runZohoSync(entity)` | ADMIN-only wrapper the Sync page calls to trigger `syncItems`/`syncVendors`/`syncCustomers`/`syncPurchaseOrders` |
| [actions/zoho-drafts.ts](actions/zoho-drafts.ts) | `pushDraftToZoho(docType, docId)` | Push a saved local doc to Zoho as a draft via the create-only write guard; idempotent (audit-log lookup prevents duplicate pushes) |
| [actions/returns.ts](actions/returns.ts) | `customerInvoices(customerId)`, `invoiceLines(zohoInvoiceId)` | Live (non-cached) Zoho reads that drive the Returns form's cascading dropdowns |
| [actions/skus.ts](actions/skus.ts) | `setSkuActive`, `addSku` | ADMIN-only SKU master maintenance |
| [actions/admin.ts](actions/admin.ts) | `resetOperationalData(confirm)` | Testing-only full wipe of transactional tables + Zoho cache, then re-pull from Zoho. Gated by `ALLOW_RESET=true` env var + ADMIN role + typing "RESET" |
| [actions/auth.ts](actions/auth.ts) | `listLoginUsers`, `signIn`, `signOut` | PIN auth: lockout after 5 attempts (60s), writes a LOGIN audit row, sets the session cookie |

## 8. Components (`components/*`)

| File | Purpose |
|---|---|
| [components/EntryForm.tsx](components/EntryForm.tsx) | The single generic data-entry grid reused by every sheet (`kind` prop switches column layout, computed columns, and payload shape). Handles idempotency token, save/error state, and the "Push draft to Zoho" button |
| [components/SearchSelect.tsx](components/SearchSelect.tsx) | Dropdown-only searchable select (portal-rendered so it isn't clipped by scrollable tables). The core anti-typo guarantee — every SKU/vendor/customer/reason field uses this, never free text |
| [components/AssemblyTabs.tsx](components/AssemblyTabs.tsx) | Blinkit/Spencer's/Bulk Fruit tab switcher wrapping `EntryForm` for the Assembly page |
| [components/DashboardClient.tsx](components/DashboardClient.tsx) | Client-side live stock table (polls `/api/stock`), filter box, Cold Room / Finished Goods split |
| [components/SyncPanel.tsx](components/SyncPanel.tsx) | Buttons to trigger each Zoho sync entity from Admin → Zoho Sync |
| [components/ResetPanel.tsx](components/ResetPanel.tsx) | Danger-zone "type RESET to confirm" wipe-and-repull control |
| [components/SkuAdmin.tsx](components/SkuAdmin.tsx) | SKU master table + add-SKU form + active/inactive toggle |
| [components/PinLogin.tsx](components/PinLogin.tsx) | Name picker + numeric PIN keypad for `/login` |
| [components/SignOutButton.tsx](components/SignOutButton.tsx) | Calls the `signOut` action |
| [components/Nav.tsx](components/Nav.tsx) | Sidebar navigation, grouped (Entry/Reference/Admin), highlights active route, shows Dispatch as disabled/"soon" |
| [components/PageHeader.tsx](components/PageHeader.tsx) | Shared `PageHeader` title/subtitle and `Card` wrapper used on every page |

## 9. Library code (`lib/*`)

| File | Purpose |
|---|---|
| [lib/db/schema.ts](lib/db/schema.ts) | The entire Drizzle schema (see §5) |
| [lib/db/index.ts](lib/db/index.ts) | Provider-agnostic DB connection: `node-postgres` if `DATABASE_URL` is set (prod), else PGlite (local). Lazily constructed via a `Proxy` so the driver never loads at build/import time |
| [lib/ledger/post.ts](lib/ledger/post.ts) | The heart of the stock-integrity guarantee: `applyMovement`/`applyMovements` (lock the balance row `FOR UPDATE`, hard-block negative, append the ledger row, update the cache) and `voidDocumentLedger` (posts exact reversing entries) |
| [lib/ledger/balance.ts](lib/ledger/balance.ts) | Read-side queries: `currentBalance`, `liveStock` (dashboard feed), `skuLedger` (per-SKU history), `reconcile` (drift check: ledger SUM vs cached balance — should always be empty), `gradeComposition` (A/B/C report) |
| [lib/queries.ts](lib/queries.ts) | All the "what to pre-list on this sheet" queries: `motherSkus`, `packSkusByChannel`, `allActiveSkus`, `vendors`, `customers`, `openPurchaseOrdersForReceiving` (PO lines matched to local SKUs, already-received lines dropped), `receivedPendingSort` (received-minus-sorted remainder), `recentWastage` (unions every waste source) |
| [lib/sku.ts](lib/sku.ts) | SKU code parsing owned by this app (not trusted from legacy Zoho data): `normalizeCode`, `motherCore` (EAT046-BF → EAT046), `deriveChannel` (suffix → channel), `parsePackSize` (free-text → gram range / piece count), `mapUom` |
| [lib/money.ts](lib/money.ts) | `decimal.js`-backed arithmetic helpers (`add`/`sub`/`gt`/`lt`/`qtyStr`/`sumQty`, etc.) — used everywhere instead of native number math to avoid float drift |
| [lib/locations.ts](lib/locations.ts) | `locationId(code)` — cached lookup of a location's numeric id |
| [lib/constants.ts](lib/constants.ts) | Seed data / dropdown option lists: `LOCATIONS`, `COLD_ROOM`/`DC_FLOOR_FG` codes, `RECEIVING_VENDOR_DENYLIST` (hides non-produce vendor POs), `ASSEMBLY_CHANNELS`, `WASTAGE_REASONS` (the fixed reason-code dropdown) |
| [lib/utils.ts](lib/utils.ts) | `cn` (Tailwind class merge) and `newToken` (client idempotency token generator) |
| [lib/auth/session.ts](lib/auth/session.ts) | JWT session cookie (`jose`), 12h expiry, `createSession`/`getSession`/`destroySession` |
| [lib/auth/pin.ts](lib/auth/pin.ts) | PIN hashing with `bcryptjs` + a server-side pepper (`PIN_PEPPER`) |
| [lib/auth/rbac.ts](lib/auth/rbac.ts) | `requireUser`/`requireRole`/`requireSupervisor`/`requireAdmin` — role-ordering guard (FLOOR < SUPERVISOR < ADMIN) used by every server action |
| [lib/zoho/*](lib/zoho) | See §4 |

## 10. Scripts (`scripts/*`)

Run with `npx tsx scripts/<name>.ts`. Also see the `npm run db:*` aliases in §11.

| Script | Purpose |
|---|---|
| [scripts/migrate.ts](scripts/migrate.ts) | Applies Drizzle migrations (`./drizzle`) — Postgres if `DATABASE_URL` set, else PGlite |
| [scripts/seed-skus.ts](scripts/seed-skus.ts) | Seeds the SKU master: `scripts/data/eat_os_skus.json` (the eat-os export) as the base, overlaid by `sheet-skus.ts` (which wins on channel/pack size). Auto-creates missing mother SKUs for any derivative. Idempotent (upsert on `normalized_code`) |
| [scripts/sheet-skus.ts](scripts/sheet-skus.ts) | Hard-coded list of the exact SKUs + pack sizes from the 7 original paper sheets — the operational source of truth for channel/pack overlay |
| [scripts/seed-users.ts](scripts/seed-users.ts) | Idempotently creates the 3 default users (Admin/1234, Supervisor/1111, Ramesh/0000) |
| [scripts/reset.ts](scripts/reset.ts) | Dev-only: wipes all transactional tables, keeps SKUs/users/locations |
| [scripts/backfill-opening-balance.ts](scripts/backfill-opening-balance.ts) | One-time: seeds `OPENING_BALANCE` ledger entries from the latest synced Zoho stock-on-hand (mother SKUs → Cold Room, packs → Finished Goods). Idempotent |
| [scripts/zoho-check.ts](scripts/zoho-check.ts) | Standalone connectivity smoke test — refreshes a token and hits each Zoho read endpoint once. No DB required |
| [scripts/zoho-exchange.ts](scripts/zoho-exchange.ts) | One-shot: exchanges a Zoho Self-Client grant code for a refresh token (used when (re)provisioning Zoho credentials, e.g. adding the inventory-adjustment write scope) |
| [scripts/zoho-sync.ts](scripts/zoho-sync.ts) | CLI wrapper to run the same sync functions the Admin UI buttons call, outside the running dev server (PGlite is single-connection, so the dev server must be stopped first) |

## 11. Config files

| File | Purpose |
|---|---|
| [package.json](package.json) | Scripts: `dev`/`build`/`start` (Next.js), `lint`, `db:generate` (drizzle-kit generate migrations from schema), `db:migrate`, `db:seed` (SKUs + users), `db:reset`, `test` (vitest) |
| [vercel.json](vercel.json) | Deploys to region `bom1`; registers the daily cron `/api/cron/sync` at `0 1 * * *` UTC |
| [next.config.ts](next.config.ts) | Pins the Turbopack/file-tracing root to the project dir (avoids picking up a stray home-dir lockfile); marks `@electric-sql/pglite` and `pg` as server-external packages (they ship native/WASM bits that must not be bundled) |
| [.claude/launch.json](.claude/launch.json) | Dev-tooling launch config: `npm run dev` (port 3000) and a `-prod` variant running `npm run start` |
| [.gitignore](.gitignore) | Standard Next.js ignores plus local DB artifacts |
| [README.md](README.md) | Quick start, stack summary, local dev commands, default logins |
| [DEPLOY.md](DEPLOY.md) | Full Vercel + Supabase deploy walkthrough, Zoho self-client provisioning, env var table, cron verification |

## 12. Auth & roles

Three roles, strictly ordered: **FLOOR < SUPERVISOR < ADMIN**.

- Login is name + 4-digit PIN (no email/password) — `bcryptjs` hash + `PIN_PEPPER`, 5 wrong attempts → 60s lockout.
- Session is a `jose`-signed JWT in an httpOnly cookie, 12h expiry (~one shift).
- `requireUser()` gates every page/action; `requireSupervisor()`/`requireAdmin()` gate voids, adjustments, SKU admin, Zoho sync, and reset.
- ADMIN is the only role that can post an adjustment that pushes a balance below zero (`allowNegative`).

## 13. What's deliberately not built yet (v1 scope)

- **Dispatch** — schema and action exist, UI is a placeholder.
- **Writing to Zoho** beyond the single "push draft" button — only `INV_ADJUSTMENT` has a wired draft builder; Receiving/Assembly/Wastage/Return throw `NotMappedError` until their Zoho field mapping is specified.
- **Grade-based stock** — A/B/C are recorded as data on the sorting line, not tracked as separate stock balances.
- **PWA/offline queue** — the app relies on idempotency tokens to survive weak wifi, not true offline support.
