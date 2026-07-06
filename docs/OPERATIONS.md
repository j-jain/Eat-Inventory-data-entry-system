# EAT Inventory — Operations Guide (v3)

Written for the owner. Every question from the v2 feedback round is answered
here: where each push lands in Zoho, what goes to Books, API limits, users &
PINs, the "blue tick", Supabase capacity, reset, and how to debug problems.

---

## 1. Every Zoho push — what, where, when

Nothing reaches Zoho automatically. Data is entered on the floor, stays local,
and goes to Zoho only when **Aniket (MANAGER)** presses a push button on
**Review & Push**. Each card there shows the exact payload before sending
("What will be sent →").

| What you did in the app | Zoho API call | Where it lands in Zoho | Live or draft? |
|---|---|---|---|
| Receiving saved (against a PO) | `POST /inventory/v1/purchasereceives?purchaseorder_id=…` | **Zoho Inventory** → Purchase Orders → that PO → *Receives* | LIVE (stock moves) |
| "Create Bill" for a receiving | `POST /books/v3/bills` | **Zoho Books** → Purchases → *Bills* | LIVE bill |
| Wastage saved | `POST /inventory/v1/inventoryadjustments` (negative qty) | **Zoho Inventory** → *Inventory Adjustments* | LIVE |
| Inventory adjustment (tie-out / manual ±) | `POST /inventory/v1/inventoryadjustments` | **Zoho Inventory** → *Inventory Adjustments* | LIVE |
| DC Assembly (packs made) | `POST /inventory/v1/bundles` — one per pack line | **Zoho Inventory** → *Bundles* (composite items) | LIVE |
| New PO created by Aniket | `POST /inventory/v1/purchaseorders` | **Zoho Inventory** → *Purchase Orders* | **DRAFT** — never issued automatically |
| PO quantities edited | `PUT /inventory/v1/purchaseorders/{id}` | The live PO itself is changed | LIVE edit (confirm dialog first) |
| "Close remainder" (receive X, cancel rest) | receive push, then `PUT` the PO lines down to the received totals | Zoho sees the PO fully received and closes it | LIVE |
| Returns | — | **Not pushed** (no Zoho mapping yet; recorded locally only) | — |
| Dispatch / delivery | — | **Not pushed** (local record only) | — |

**What goes to Zoho Books: bills, and nothing else.** A bill carries the
vendor, the linked PO, and the *accepted* quantities × the PO's rates.
Everything else (receives, adjustments, bundles, POs) goes to **Zoho
Inventory**. Customers are *read* from Books for the Returns screen — never
written.

### Why pushes can't create duplicates (v3)

Every push is tracked in a state table (`zoho_push`):

- A push must first **claim** its row — two clicks (or a bulk push racing an
  individual one) can never send twice.
- Every payload carries a **reference number** (`EAT-RCV-12`, `EAT-ADJ-7`,
  `EAT-ASM-3-L9`, …).
- If the outcome is **unclear** (network died mid-request, Zoho 5xx), the push
  is marked **NEEDS CHECK** and is *never retried blindly*. The **Reconcile**
  button searches Zoho for the reference: found → recorded as pushed with the
  Zoho id; not found → safely retryable.
- A clear rejection from Zoho (4xx) shows as FAILED with Zoho's message and can
  be retried after fixing the cause.
- Voiding a document that was already pushed is **blocked** with the list of
  Zoho records that must be corrected manually first (ADMIN can override; the
  override is audited).

## 2. Zoho API limits and our budget

- Zoho allows **100 API calls/minute** per organisation and, on the
  **Standard plan (ours): 2,000 calls/day**. Exceeding either returns HTTP 429.
- Our typical day: 6–7 scheduled syncs (~20–60 calls each) plus pushes
  (1–3 calls each) ≈ **200–400 calls/day** — roughly 10–20 % of the budget.
- The live meter is on **Admin → Developer** (calls today, writes, % of
  budget). If it ever runs hot, space out manual "Pull Everything" clicks —
  the scheduled syncs are already incremental.

## 3. Sync schedule (Zoho → app)

| Trigger | When (IST) | What |
|---|---|---|
| Vercel Cron | 06:30 daily | items+stock, vendors, customers, open POs, open SOs |
| GitHub Actions | 08:30, 12:00, 13:00, 15:00, 17:00, 19:00 | same |
| Admin → Zoho Sync buttons | manual | per entity or everything |

Each run is incremental (only records modified since the last successful run).
The two schedulers can fire at the same time — a mutex makes the loser skip
cleanly. Only **ADMIN** sees or triggers sync; nobody else has the option.

## 4. Users, roles, PINs

Login = tap your name → 4-digit PIN. A device stays signed in for **30 days**,
but blocking a user / changing pages applies **immediately** on their next
click (permissions are checked live on every request, not from the login
cookie).

Seeded users (change PINs in **Admin → Users** — they're visible and editable
there):

| User | Role | First PIN |
|---|---|---|
| Admin | ADMIN | 1234 |
| Aniket | MANAGER | 2222 |
| Supervisor | SUPERVISOR | 1111 |
| Ramesh (Floor) | FLOOR | 0000 |

PIN storage: login checks a bcrypt hash; the admin-visible copy is
**encrypted at rest** (key derived from the server's `SESSION_SECRET`), so a
database leak alone cannot reveal PINs. Treat the combination of DB +
server env as fully secret.

### Default pages per role

- **FLOOR**: Live Inventory, Receiving, Sorting/Grading, Regrade, Pick List,
  DC Assembly, Dispatch, Returns, Wastage. *No* Orders, Summary, Purchase
  Orders, Adjustments, Review, CSV downloads, or admin anything.
- **SUPERVISOR**: floor set + Orders, Adjustments, Purchase Orders, Summary.
- **MANAGER (Aniket)**: supervisor set + Review & Push, New PO, PO editing,
  CSV downloads.
- **ADMIN**: everything, including SKUs, Users, Zoho Sync, Developer, reset.

Per-user overrides: **Admin → Users → Pages** — tick exactly the pages a
person should see; "Reset to role default" reverts.

## 5. The "blue tick" in Admin → SKUs, explained

The checkbox you saw is the **Active** toggle: ticked = the SKU appears in
entry dropdowns; unticked = hidden from entry (history kept). It never meant
anything about Zoho.

What you were actually looking for now exists as its own column: **Zoho** —
`● linked` (the Items sync matched this SKU to a Zoho item; pushes will work)
or `○ not linked` (no match yet — run Items sync, or fix the SKU spelling in
Zoho; pushes for this SKU would be refused with a clear message).

## 6. Is Supabase enough for a year+ of data? Yes.

Volumes are tiny: even at a busy ~1,000 ledger rows/day, a year is ~365k rows
— tens of MB. The free tier holds 500 MB, but it **pauses after ~1 week of
inactivity** and has weaker backups. For production use the **Pro tier
(~$25/mo)**: no pausing, daily backups, point-in-time recovery. Nothing in
the app ever auto-deletes operational data (only `system_log` is trimmed
after 60 days) — the full ledger stays exportable (Ledger CSV) for future
analysis.

## 7. Reset (testing phase)

**Admin → Zoho Sync → danger zone**, ADMIN-only, requires typing `RESET`.
It deletes all operational data — entries, ledger, balances, pick lists, PO
drafts, push state, system logs, API counters, Zoho caches — then re-pulls
fresh data from Zoho. It **keeps** users, SKUs, locations, Zoho auth, and
non-Zoho audit history (logins, past resets). While testing it is available
on every deployment; re-gate or remove it before going live with real data
(see DEPLOY.md).

## 8. When something goes wrong

1. **Admin → Developer**: error stream (every server error with context),
   pushes needing attention, sync health, API budget.
2. Each error row has **"Copy for Claude"** — paste that into a Claude chat
   and it contains everything needed to diagnose (time, source, message, full
   context).
3. A push shows **NEEDS CHECK**? Press **Reconcile** on its card in Review &
   Push — never re-enter the data.
4. An SO vanished from picking? The pick list shows a warning naming orders
   whose items matched no EAT SKU — fix the SKU in Zoho or add it in Admin →
   SKUs, then have a supervisor cancel & regenerate the list.

## 9. Grades on the Live Inventory

The Cold Storage tab shows each fruit's A/B/C/waste split **graded over the
last 7 days** (blank = nothing graded). It is informational: stock itself is
tracked per SKU per location, not per grade — tracking true per-grade
balances would require every consuming entry (assembly, wastage, dispatch) to
also ask "which grade?", which slows the floor down. If that trade-off ever
becomes worth it, it's a schema change we've deliberately parked.

## 10. Environment variables (names only)

`DATABASE_URL`, `SESSION_SECRET`, `PIN_PEPPER`, `CRON_SECRET`,
`ZOHO_ENABLED`, `ZOHO_DC`, `ZOHO_ORG_ID`, `ZOHO_CLIENT_ID`,
`ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `DB_POOL_MAX` (optional, keep
small on serverless, e.g. `3`).
Set in Vercel → Project → Settings → Environment Variables. Never commit
values to git (`.env*` is ignored).
