"use server";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoCustomerCache } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/rbac";
import { zohoConfig } from "@/lib/zoho/config";
import { fetchCustomerInvoices, getInvoiceDetail } from "@/lib/zoho/reads";
import { allActiveSkus } from "@/lib/queries";
import { normalizeCode } from "@/lib/sku";

export type ReturnInvoiceOption = {
  zohoInvoiceId: string;
  invoiceNumber: string | null;
  hint: string | null; // invoice date, shown beside the number
};

/** Recent invoices for the chosen customer (live, on-demand). Empty if Zoho off. */
export async function customerInvoices(
  customerId: number,
): Promise<ReturnInvoiceOption[]> {
  await requireUser();
  if (!zohoConfig.enabled || !customerId) return [];
  const rows = await db
    .select({ zid: zohoCustomerCache.zohoContactId })
    .from(zohoCustomerCache)
    .where(eq(zohoCustomerCache.id, customerId));
  if (!rows[0]) return [];
  try {
    const invs = await fetchCustomerInvoices(rows[0].zid);
    return invs.map((i) => ({
      zohoInvoiceId: i.zohoInvoiceId,
      invoiceNumber: i.invoiceNumber,
      hint: i.date,
    }));
  } catch {
    return [];
  }
}

export type ReturnLineSeed = {
  skuId: number | null;
  skuCode: string | null;
  itemName: string;
  uom: string | null;
  invoiceQty: string | null;
};

/**
 * Line items for ONE invoice, each resolved to a local pack SKU (by normalized
 * code). Pre-fills the returns sheet so staff only enter qty returned / weight
 * / disposition. Unmatched lines come back with skuId=null (name shown, staff
 * picks the SKU). Empty if Zoho is off.
 */
export async function invoiceLines(zohoInvoiceId: string): Promise<ReturnLineSeed[]> {
  await requireUser();
  if (!zohoConfig.enabled || !zohoInvoiceId) return [];
  try {
    const [detail, skuList] = await Promise.all([
      getInvoiceDetail(zohoInvoiceId),
      allActiveSkus(),
    ]);
    const byNorm = new Map(skuList.map((s) => [normalizeCode(s.code), s]));
    return detail.lines.map((li) => {
      const match = li.sku ? byNorm.get(normalizeCode(li.sku)) : undefined;
      return {
        skuId: match?.id ?? null,
        skuCode: match?.code ?? null,
        itemName: li.name ?? "",
        uom: match?.uom ?? null,
        invoiceQty: li.qty != null ? String(li.qty) : null,
      };
    });
  } catch {
    return [];
  }
}
