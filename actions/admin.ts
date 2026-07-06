"use server";

import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { appAuditLog } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/rbac";
import type { Tx } from "@/lib/ledger/post";
import { zohoConfig } from "@/lib/zoho/config";
import {
  syncItems,
  syncVendors,
  syncCustomers,
  syncPurchaseOrders,
  syncSalesOrders,
} from "@/lib/zoho/sync";

/** Transactional tables wiped by a reset (mirrors scripts/reset.ts).
 *  Order matters: children before parents (FKs). Deliberately DELETE, never
 *  TRUNCATE — the ledger's append-only guard is a BEFORE DELETE row trigger
 *  and TRUNCATE would silently bypass it. */
const TX_TABLES = [
  "stock_ledger",
  "stock_balance",
  "receiving_line",
  "receiving_doc",
  "sorting_line",
  "sorting_doc",
  "assembly_line",
  "assembly_doc",
  "wastage_line",
  "wastage_doc",
  "return_line",
  "return_doc",
  "inv_adjustment_line",
  "inv_adjustment_doc",
  "pick_list_line_source",
  "pick_list_source",
  "pick_list_line",
  "dispatch_line",
  "dispatch_doc",
  "pick_list",
  "manual_order_line",
  "manual_order_doc",
  "po_draft_line",
  "po_draft_doc",
  "opening_doc",
  // v3 state — stale push records would mark NEW docs as already-pushed
  "zoho_push",
  "system_log",
  "zoho_call_counter",
];

/**
 * Zoho cache tables cleared so the re-pull starts fresh. `zoho_token` is kept so
 * we can still authenticate; `sync_log` is cleared to reset the incremental
 * watermark (forces a full pull on the next sync).
 */
const ZOHO_CACHE_TABLES = [
  "zoho_item_cache",
  "zoho_vendor_cache",
  "zoho_customer_cache",
  "zoho_po_cache",
  "zoho_so_cache",
  "zoho_invoice_cache",
  "sync_log",
];

export type ResetResult =
  | { ok: true; tables: number; pulled: number; zoho: "done" | "skipped" | "partial"; zohoError?: string }
  | { ok: false; error: string };

/**
 * Full reset: clear ALL operational data (entries + ledger + balances) AND the
 * Zoho cache, then re-pull Items/Vendors/Customers/POs fresh from Zoho. Keeps
 * SKUs, users and locations. ADMIN-only and requires the literal "RESET"
 * confirmation string. Available on every deployment while the system is in
 * testing — re-gate or remove before going live with real data (DEPLOY.md).
 */
export async function resetOperationalData(confirm: string): Promise<ResetResult> {
  const s = await requireAdmin();
  if (confirm !== "RESET") return { ok: false, error: 'Type "RESET" to confirm.' };

  const allTables = [...TX_TABLES, ...ZOHO_CACHE_TABLES];
  try {
    await db.transaction(async (tx: Tx) => {
      // append-only ledger has a delete-guard trigger — disable it for the wipe
      await tx.execute(sql`ALTER TABLE stock_ledger DISABLE TRIGGER trg_ledger_no_delete`);
      for (const t of allTables) {
        await tx.execute(sql.raw(`DELETE FROM ${t}`));
      }
      await tx.execute(sql`ALTER TABLE stock_ledger ENABLE TRIGGER trg_ledger_no_delete`);
      // Scoped audit wipe: ZOHO_% rows carried push state until v3 and would
      // go stale; LOGIN / RESET / USER_* history is deliberately preserved.
      await tx.execute(sql`DELETE FROM app_audit_log WHERE action LIKE 'ZOHO_%'`);
      await tx.insert(appAuditLog).values({
        userId: s.uid,
        action: "RESET",
        payload: { tables: allTables.length },
      });
    });

    // Re-pull from Zoho (outside the wipe transaction — these are network calls).
    let pulled = 0;
    let zoho: "done" | "skipped" | "partial" = "skipped";
    let zohoError: string | undefined;
    if (zohoConfig.enabled) {
      zoho = "done";
      for (const fn of [syncItems, syncVendors, syncCustomers, syncPurchaseOrders, syncSalesOrders]) {
        try {
          pulled += await fn();
        } catch (e) {
          zoho = "partial";
          zohoError = e instanceof Error ? e.message : String(e);
        }
      }
    }

    for (const p of [
      "/dashboard",
      "/receiving",
      "/sorting",
      "/regrade",
      "/wastage",
      "/purchase-orders",
      "/admin/sync",
    ])
      revalidatePath(p);

    return { ok: true, tables: allTables.length, pulled, zoho, zohoError };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
