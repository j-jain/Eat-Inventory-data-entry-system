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
} from "@/lib/zoho/sync";

/** Transactional tables wiped by a reset (mirrors scripts/reset.ts). */
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
  "dispatch_line",
  "dispatch_doc",
  "opening_doc",
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
  "zoho_invoice_cache",
  "sync_log",
];

export type ResetResult =
  | { ok: true; tables: number; pulled: number; zoho: "done" | "skipped" | "partial"; zohoError?: string }
  | { ok: false; error: string };

/**
 * Full reset: clear ALL operational data (entries + ledger + balances) AND the
 * Zoho cache, then re-pull Items/Vendors/Customers/POs fresh from Zoho. Keeps
 * SKUs, users and locations. Testing-only: disabled unless ALLOW_RESET=true (so
 * it cannot run on the production deploy), ADMIN-only, and requires the literal
 * "RESET" confirmation string.
 */
export async function resetOperationalData(confirm: string): Promise<ResetResult> {
  const s = await requireAdmin();
  if (process.env.ALLOW_RESET !== "true")
    return { ok: false, error: "Reset is disabled on this deployment." };
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
      for (const fn of [syncItems, syncVendors, syncCustomers, syncPurchaseOrders]) {
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
