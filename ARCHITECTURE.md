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

## 3. Data flow (the operational pipeline — v2, structurally enforced)

```
Zoho PO ──▶ Receiving (PO-only; variance S1/S2/S4) ──▶ RECEIVING_BAY
                                                            │ sorting is the ONLY path onward
        Sorting (A/B/C; waste auto) ─ SORT_OUT/SORT_IN ──▶ COLD_ROOM ◀── Regrade (in place)
                                                            │
Zoho SO + manual orders ──▶ Pick List (MANDATORY gate) ──▶ DC Assembly (pick-list-driven)
                                                            │
                     Finished Goods ──▶ Dispatch (pick-list-driven) ──▶ Delivery confirm ──▶ Returns

   Wastage (hub — every stage tags its source)      Inventory Adjustment (PO/bill tie-out + manual ± + supervisor override)
```

- **Three locations**: `RECEIVING_BAY` (received-unsorted — structurally unusable downstream; SKUs
  with `requires_sorting=false` skip it), `COLD_ROOM` (sorted raw/mother), `DC_FLOOR_FG` (packs).
- **Workflow enforcement**: the bay makes receive-before-sort physical; Assembly & Dispatch
  additionally require today's Pick List generated AND completed (`lib/workflow.ts:
  assertPickListComplete`, checked inside the server actions — no role bypass; the only audited
  escape is a SUPERVISOR short-complete with a recorded reason that surfaces on /summary).
- Receiving is **PO-only** for floor staff (off-PO = MANAGER); accepted > remaining is rejected
  unless S2 is chosen; S1/S4 auto-create their adjustment/wastage paper trail in-transaction.
- **Stock = total qty per SKU per location.** Grades A/B/C are recorded as *data* on the sorting line, not as separate stock buckets, in v1.
- **`stock_ledger`** (append-only) is the single source of truth. **`stock_balance`** is a mutable cache, always updated in the same DB transaction as the ledger insert, and guarded by a `qty >= 0` CHECK constraint.
- Every out-movement is **hard-blocked** below zero via `SELECT ... FOR UPDATE` inside a transaction (`lib/ledger/post.ts`); only an ADMIN adjustment can force it negative-to-zero-correcting (`allowNegative`).
- Corrections are **reversing entries** (`voidDocumentLedger`) — nothing is ever destructively edited.

## 4. The Zoho "connector" (v3)

The app treats Zoho (Zoho **Inventory** for items/stock/vendors/POs/SOs, Zoho **Books** for customers/bills) as an external system it *reads from* freely and *writes to* only through an explicit, registry-guarded push pipeline. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the owner-facing push map.

### The write registry + push state machine

| File | Role |
|---|---|
| [lib/zoho/config.ts](lib/zoho/config.ts) | Env-driven config (`ZOHO_DC`, `ZOHO_ORG_ID`, client id/secret/refresh token); `zohoConfig.enabled` gates everything |
| [lib/zoho/token.ts](lib/zoho/token.ts) | OAuth token refresh, cached in the `zoho_token` table (+ an in-process memo) since serverless instances are ephemeral |
| [lib/zoho/guard.ts](lib/zoho/guard.ts) | `assertReadOnly(method)` — throws on anything but `GET`. Every read call routes through this |
| [lib/zoho/client.ts](lib/zoho/client.ts) | `zohoGet` (paced/retrying GET: 401→refresh, 429→backoff, 5xx→retry) and `zohoPaged`. Every attempt increments the daily API budget counter |
| [lib/zoho/write-guard.ts](lib/zoho/write-guard.ts) | `ZOHO_WRITES` registry — the security guard AND the "where does this land" label source. Every write must match one entry by method + path pattern; DELETE/PATCH can never match; the only PUT is the PO edit |
| [lib/zoho/write.ts](lib/zoho/write.ts) | `zohoWrite` — the one write function. Retries only 401/429 (rejected before processing); a transport error throws `ZohoApiError(0)` = *ambiguous outcome* |
| [lib/zoho/drafts.ts](lib/zoho/drafts.ts) | `PUSH_BUILDERS` per kind: receives, bills, adjustments, bundles, PO drafts. Each request declares its idem-reference (stamped into the payload) and a response contract for extracting the created Zoho id |
| [lib/zoho/push-state.ts](lib/zoho/push-state.ts) | The `zoho_push` state machine: PENDING → IN_FLIGHT (atomic claim) → SUCCESS / FAILED (definite 4xx, re-claimable) / UNKNOWN (ambiguous — never auto-retried) |
| [lib/zoho/resolve.ts](lib/zoho/resolve.ts) | The reconciler: searches Zoho (read-only) for a push's idem-reference to settle UNKNOWN outcomes without ever risking a duplicate |
| [lib/zoho/review.ts](lib/zoho/review.ts) | Review queue + push history, both reading `zoho_push` |
| [lib/zoho/po-workspace.ts](lib/zoho/po-workspace.ts) | Aniket's PO cards: lines with ordered/received/remaining, receipts + their push states, close-remainder eligibility |
| [lib/zoho/sync.ts](lib/zoho/sync.ts) | Bulk **read** sync: items (full catalog + EAT-SKU linking), vendors, customers, open POs, open SOs. Each run logs to `sync_log` (the incremental watermark) |
| [lib/zoho/reads.ts](lib/zoho/reads.ts) | On-demand reads not worth bulk-caching: `fetchCustomerInvoices`, `getInvoiceDetail` (Returns tab) |

Key duplicate-safety properties:
- a push must atomically **claim** its `zoho_push` row (`UPDATE … WHERE status IN ('PENDING','FAILED') RETURNING`) — double-clicks and racing bulk pushes cannot send twice;
- every payload carries an **idem reference** (`EAT-RCV-12`, `EAT-ADJ-7`, `EAT-ASM-3-L9`, bills' `reference_number`, …);
- ambiguous outcomes (transport error / 5xx) park as **UNKNOWN** and only the reference-searching reconciler can move them;
- voiding a doc with a SUCCESS push is blocked (ADMIN override is audited) because a local void never un-pushes anything.

### What's actually synced (and what isn't)

- **Items**: ALL active Zoho items are cached (the Live Inventory shows the whole catalog); those matching an EAT SKU by normalized code additionally get `skus.zoho_item_id` set.
- **Purchase orders / sales orders**: only *open* ones are kept, with line detail; closed ones are deleted from the cache so they drop off the sheets.
- **Invoices**: never bulk-pulled — fetched live, per customer, only when a Returns entry needs them.
- **Vendors/customers**: full pull (small lists).

### Where Zoho touches the UI

- **Review & Push** ([app/(app)/review/page.tsx](app/(app)/review/page.tsx)) — Aniket's cockpit: Purchase Orders workspace (receive/bill pushes, inline PO edit, close-remainder), Inventory pushes, Books pushes, Combined stock, History. Every card shows the exact payload before sending.
- **Admin → Zoho Sync** — manual pull buttons + last-20 sync runs + the reset danger zone (testing phase; re-gate before go-live). ADMIN-only.
- **Admin → Developer** — API budget meter, push health, sync health, error stream.
- **Receiving** — pre-lists every open PO's lines; **Returns** — live invoice loads.
- **Cron** (`app/api/cron/sync/route.ts`) — incremental pull, Vercel daily + GitHub Actions 6×/day, `CRON_SECRET`-protected, serialized by a pooler-safe row mutex (`sync_mutex`).

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
| `/admin/sync` | [app/(app)/admin/sync/page.tsx](app/(app)/admin/sync/page.tsx) | ADMIN-only. Manual Zoho pull buttons, last-20-syncs log table, danger-zone reset (always shown during the testing phase) |
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
| [actions/admin.ts](actions/admin.ts) | `resetOperationalData(confirm)` | Testing-phase full wipe of transactional tables + Zoho cache, then re-pull from Zoho. Gated by ADMIN role + typing "RESET" |
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

Four roles, strictly ordered: **FLOOR < SUPERVISOR < MANAGER < ADMIN**. MANAGER is
Aniket's role: every Zoho push button (nobody else even sees them), PO create/edit
screens, the `/review` push queue, the combined Zoho+local stock view, and off-PO
receipts — without ADMIN's reset/SKU-master/negative-override powers.

- Login is name + 4-digit PIN (no email/password) — `bcryptjs` hash + `PIN_PEPPER`, 5 wrong attempts → 60s lockout.
- Session is a `jose`-signed JWT in an httpOnly cookie, 12h expiry (~one shift).
- `requireUser()` gates every page/action; `requireSupervisor()`/`requireAdmin()` gate voids, adjustments, SKU admin, Zoho sync, and reset.
- ADMIN is the only role that can post an adjustment that pushes a balance below zero (`allowNegative`).

## 13. v2 additions (July 2026) — quick map

- **Receiving Bay + `requires_sorting`** — receipts land in `RECEIVING_BAY`; sorting transfers
  (`SORT_OUT`/`SORT_IN`, waste stays explicit as `SORT_WASTE` from the bay).
- **Partial POs** — `openPurchaseOrdersForReceiving` SUMs cumulative accepted per (PO, SKU);
  lines stay on the sheet with `remainingQty` until fully received; voids restore remaining.
- **Variance scenarios** — S1 free-leftover (extra ₹0 receipt line + record-only TIE_OUT
  adjustment linked via `against='RECEIVING:<id>'`), S2 over-receipt, S4 short-billed-full
  (receipt = bill qty + auto wastage `source=RECEIVING` back-linked via `source_doc_*`).
  Cascade void: voiding a receiving/assembly doc voids its auto-created companions first.
- **Orders & Pick List** — `zoho_so_cache` (lean open-SO sync, `syncSalesOrders`), manual
  orders (`manual_order_*`), `pick_list`/`_line`/`_source` (max ONE OPEN list via partial
  unique index; an order feeds exactly one non-cancelled list). Gate rule: ≥1 list generated
  today (IST) AND none open. Empty generation auto-completes ("no orders" satisfies the mandate).
- **Dispatch & Delivery** — dispatch pre-lists the completed pick list; `markDelivered` sets
  per-line delivered qty + PENDING/PARTIAL/DELIVERED header status (no stock movement).
- **Zoho writes** — `lib/zoho/write-guard.ts` is now a REGISTRY (`assertZohoWrite`: method +
  path-pattern allowlist, sole PUT = `purchaseorders/{id}`); `zohoWrite` in write.ts; builders
  in `lib/zoho/drafts.ts` (purchase receive, bill, bundle-per-line with composite pre-flight,
  wastage/adjustment → inventory adjustments, PO draft create); `pushToZoho` (MANAGER-only,
  per-request idempotent via `ZOHO_PUSH:<kind>:<subKey>` audit rows, failures audited);
  `/review` queue + "Push all pending"; PO screens (`/purchase-orders/new`, `[id]/edit` → live
  PUT + single-PO cache refresh); `combinedZohoStock` (Zoho + unpushed local Δ).
  Labels in `lib/zoho/labels.ts` (client-safe) state exactly where each push lands.
- **Sync cadence** — `.github/workflows/zoho-sync.yml` pings `/api/cron/sync` at 08:30, 12:00,
  13:00, 15:00, 17:00, 19:00 IST (Vercel daily cron stays as baseline). SO sync included.
- **UI v2** — EAT brand tokens (`--color-brand #BFDA3D`, cream, ink) in globals.css; desktop
  sidebar + mobile bottom-tab nav (`components/MobileNav.tsx`, shared `nav-links.ts` with
  role-gated groups); EntryForm renders cards below `md` (same ColDef/renderCell), sticky Save,
  16px inputs; PWA manifest + icons; `/summary` daily sheets (+ `sheet=summary` CSV).
- **Tests** — `tests/workflow.test.ts` runs the REAL server actions against in-memory PGlite
  (mocked session/next-cache): bay flow, PO-only, variance, gate, dispatch/delivery, cascade
  void, reconciliation. (Also fixed a v1 bug: voiding docs with negative ledger rows crashed
  on `"-" + qty` double-negation — now `neg()`.)

## 14. Still deliberately out of scope

- **Alerts** on Aniket's dashboard (owner: later version).
- **Grade-based stock** — A/B/C remain line data, not separate balances.
- **Offline queue** — idempotency tokens only; PWA is install + app-shell, no service-worker sync.
- **RETURN push to Zoho** — returns are recorded locally; credit-note mapping unspecified.
- Zoho staging checks before enabling pushes in prod: S1 PO PUT below received qty on a
  throwaway PO; pack SKUs exist as composite items; re-provision the token with the new write
  scopes (`purchaseorders.CREATE/UPDATE`, `purchasereceives.CREATE`, `salesorders.READ`,
  `compositeitems.ALL`, Books `bills.CREATE`) via `scripts/zoho-exchange.ts`.
