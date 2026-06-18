import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  zohoItemCache,
  zohoVendorCache,
  zohoCustomerCache,
  zohoPoCache,
  zohoInvoiceCache,
  syncLog,
  skus,
} from "@/lib/db/schema";
import { zohoConfig } from "./config";
import { zohoGet, zohoPaged } from "./client";
import { normalizeCode } from "@/lib/sku";

async function runSync(entity: string, fn: () => Promise<number>): Promise<number> {
  const [log] = await db
    .insert(syncLog)
    .values({ entity, status: "RUNNING" })
    .returning({ id: syncLog.id });
  try {
    const rows = await fn();
    await db
      .update(syncLog)
      .set({ status: "DONE", rowsPulled: rows, finishedAt: new Date() })
      .where(eq(syncLog.id, log.id));
    return rows;
  } catch (e) {
    await db
      .update(syncLog)
      .set({
        status: "ERROR",
        error: e instanceof Error ? e.message : String(e),
        finishedAt: new Date(),
      })
      .where(eq(syncLog.id, log.id));
    throw e;
  }
}

/** Items + stock-on-hand. Upserts item cache; links zoho_item_id onto our SKUs
 *  by normalized code; inserts unknown Zoho items as INACTIVE ZOHO SKUs for review.
 *  Never clobbers LOCAL channel/pack fields. */
export function syncItems() {
  return runSync("ITEM", async () => {
    type Item = {
      item_id: string;
      name?: string;
      sku?: string;
      actual_available_stock?: number;
      stock_on_hand?: number;
      rate?: number;
      last_modified_time?: string;
    };
    const items = await zohoPaged<Item>(`${zohoConfig.inventoryBase}/items`, "items", {
      status: "active",
    });
    for (const it of items) {
      const stock = String(it.actual_available_stock ?? it.stock_on_hand ?? 0);
      await db
        .insert(zohoItemCache)
        .values({
          zohoItemId: String(it.item_id),
          itemName: it.name ?? "",
          skuText: (it.sku ?? "").toUpperCase(),
          stockOnHand: stock,
          rate: it.rate != null ? String(it.rate) : null,
          lastModifiedTime: it.last_modified_time,
        })
        .onConflictDoUpdate({
          target: zohoItemCache.zohoItemId,
          set: {
            itemName: it.name ?? "",
            skuText: (it.sku ?? "").toUpperCase(),
            stockOnHand: stock,
            rate: it.rate != null ? String(it.rate) : null,
            lastModifiedTime: it.last_modified_time,
            fetchedAt: new Date(),
          },
        });

      const norm = normalizeCode(it.sku ?? "");
      if (!norm) continue;
      const existing = await db
        .select({ id: skus.id })
        .from(skus)
        .where(eq(skus.normalizedCode, norm));
      if (existing[0]) {
        // only set the Zoho link — never touch channel/pack (sheets own those)
        await db
          .update(skus)
          .set({ zohoItemId: String(it.item_id) })
          .where(eq(skus.id, existing[0].id));
      } else {
        await db
          .insert(skus)
          .values({
            code: it.sku ?? String(it.item_id),
            normalizedCode: norm,
            name: it.name ?? norm,
            family: norm.match(/^[A-Z]+/)?.[0] ?? "EAT",
            skuKind: "MOTHER",
            channel: "MOTHER",
            motherCore: norm,
            uom: "kg",
            zohoItemId: String(it.item_id),
            source: "ZOHO",
            isActive: false, // pending admin review
          })
          .onConflictDoNothing({ target: skus.normalizedCode });
      }
    }
    return items.length;
  });
}

export function syncVendors() {
  return runSync("VENDOR", async () => {
    type V = { contact_id: string; contact_name?: string; vendor_name?: string };
    const vs = await zohoPaged<V>(`${zohoConfig.inventoryBase}/vendors`, "contacts");
    for (const v of vs) {
      await db
        .insert(zohoVendorCache)
        .values({
          zohoContactId: String(v.contact_id),
          name: v.vendor_name || v.contact_name || "(unnamed)",
        })
        .onConflictDoUpdate({
          target: zohoVendorCache.zohoContactId,
          set: { name: v.vendor_name || v.contact_name || "(unnamed)", fetchedAt: new Date() },
        });
    }
    return vs.length;
  });
}

export function syncCustomers() {
  return runSync("CUSTOMER", async () => {
    type C = { contact_id: string; contact_name?: string };
    const cs = await zohoPaged<C>(`${zohoConfig.booksBase}/contacts`, "contacts", {
      contact_type: "customer",
    });
    for (const c of cs) {
      await db
        .insert(zohoCustomerCache)
        .values({ zohoContactId: String(c.contact_id), name: c.contact_name || "(unnamed)" })
        .onConflictDoUpdate({
          target: zohoCustomerCache.zohoContactId,
          set: { name: c.contact_name || "(unnamed)", fetchedAt: new Date() },
        });
    }
    return cs.length;
  });
}

export function syncPurchaseOrders() {
  return runSync("PO", async () => {
    type PO = {
      purchaseorder_id: string;
      purchaseorder_number?: string;
      vendor_id?: string;
      vendor_name?: string;
      date?: string;
      status?: string;
      last_modified_time?: string;
    };
    const pos = await zohoPaged<PO>(
      `${zohoConfig.inventoryBase}/purchaseorders`,
      "purchaseorders",
    );
    for (const po of pos) {
      // fetch detail for line items
      let lineItems: unknown = null;
      try {
        const detail = await zohoGet<{ purchaseorder?: { line_items?: unknown } }>(
          `${zohoConfig.inventoryBase}/purchaseorders/${po.purchaseorder_id}`,
        );
        lineItems = detail.purchaseorder?.line_items ?? null;
      } catch {
        /* keep summary even if detail fails */
      }
      await db
        .insert(zohoPoCache)
        .values({
          zohoPoId: String(po.purchaseorder_id),
          poNumber: po.purchaseorder_number,
          vendorZohoId: po.vendor_id,
          vendorName: po.vendor_name,
          poDate: po.date ?? null,
          status: po.status,
          lineItems,
          lastModifiedTime: po.last_modified_time,
        })
        .onConflictDoUpdate({
          target: zohoPoCache.zohoPoId,
          set: {
            poNumber: po.purchaseorder_number,
            vendorName: po.vendor_name,
            status: po.status,
            lineItems,
            lastModifiedTime: po.last_modified_time,
            fetchedAt: new Date(),
          },
        });
    }
    return pos.length;
  });
}

export function syncInvoices() {
  return runSync("INVOICE", async () => {
    type Inv = {
      invoice_id: string;
      invoice_number?: string;
      customer_id?: string;
      customer_name?: string;
      date?: string;
      last_modified_time?: string;
    };
    const invs = await zohoPaged<Inv>(`${zohoConfig.booksBase}/invoices`, "invoices");
    for (const inv of invs) {
      await db
        .insert(zohoInvoiceCache)
        .values({
          zohoInvoiceId: String(inv.invoice_id),
          invoiceNumber: inv.invoice_number,
          customerZohoId: inv.customer_id,
          customerName: inv.customer_name,
          invoiceDate: inv.date ?? null,
          lastModifiedTime: inv.last_modified_time,
        })
        .onConflictDoUpdate({
          target: zohoInvoiceCache.zohoInvoiceId,
          set: {
            invoiceNumber: inv.invoice_number,
            customerName: inv.customer_name,
            invoiceDate: inv.date ?? null,
            lastModifiedTime: inv.last_modified_time,
            fetchedAt: new Date(),
          },
        });
    }
    return invs.length;
  });
}
