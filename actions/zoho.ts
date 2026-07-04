"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/rbac";
import { zohoConfig } from "@/lib/zoho/config";
import {
  syncItems,
  syncVendors,
  syncCustomers,
  syncPurchaseOrders,
  syncSalesOrders,
} from "@/lib/zoho/sync";

export type SyncEntity = "items" | "vendors" | "customers" | "pos" | "sos" | "all";

export type SyncResult = { ok: true; rows: number } | { ok: false; error: string };

export async function runZohoSync(entity: SyncEntity): Promise<SyncResult> {
  await requireAdmin();
  if (!zohoConfig.enabled) {
    return {
      ok: false,
      error:
        "Zoho is not configured. Add ZOHO_ENABLED=true and ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN/ORG_ID (reuse eat-os values) to your env.",
    };
  }
  try {
    let rows = 0;
    if (entity === "items" || entity === "all") rows += await syncItems();
    if (entity === "vendors" || entity === "all") rows += await syncVendors();
    if (entity === "customers" || entity === "all") rows += await syncCustomers();
    if (entity === "pos" || entity === "all") rows += await syncPurchaseOrders();
    if (entity === "sos" || entity === "all") rows += await syncSalesOrders();
    revalidatePath("/admin/sync");
    revalidatePath("/purchase-orders");
    revalidatePath("/pick-list");
    revalidatePath("/dashboard");
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
