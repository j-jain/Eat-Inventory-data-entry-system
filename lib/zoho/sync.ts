import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  zohoItemCache,
  zohoVendorCache,
  zohoCustomerCache,
  zohoPoCache,
  zohoSoCache,
  syncLog,
  skus,
} from "@/lib/db/schema";
import { zohoConfig } from "./config";
import { zohoGet, zohoPaged } from "./client";
import { normalizeCode } from "@/lib/sku";

/**
 * Watermark for incremental sync: the start time of the last successful sync of
 * this entity, minus a 10-min overlap buffer (so records modified mid-run aren't
 * missed). Returns null on the first run → caller does a full pull. This is the
 * "memory" — no extra table, the sync_log IS the state.
 */
export async function lastSyncAt(entity: string): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: syncLog.startedAt })
    .from(syncLog)
    .where(and(eq(syncLog.entity, entity), eq(syncLog.status, "DONE")))
    .orderBy(desc(syncLog.id))
    .limit(1);
  if (!rows[0]) return null;
  return new Date(rows[0].startedAt.getTime() - 10 * 60_000);
}

/** Zoho `last_modified_time` filter — only records changed at/after `since`. */
function sinceParam(since?: Date): Record<string, string> {
  if (!since) return {};
  // Zoho rejects a bare "Z" suffix — it wants an explicit UTC offset, e.g.
  // 2024-01-15T10:30:00+00:00.
  return { last_modified_time: since.toISOString().replace(/\.\d{3}Z$/, "+00:00") };
}

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

/**
 * Items + stock-on-hand — v3: cache EVERY active Zoho item (the Live
 * Inventory "all items" view needs the full catalog), and additionally link
 * the ones whose sku matches an EAT SKU (by normalized code). Whether an
 * item is "matched" is derivable via skus.zoho_item_id — no extra column.
 */
export function syncItems(since?: Date) {
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
    // preload EAT sku codes once (in-memory match → no per-item DB lookup)
    const local = await db
      .select({ id: skus.id, norm: skus.normalizedCode })
      .from(skus);
    const idByNorm = new Map(local.map((r) => [r.norm, r.id]));

    const items = await zohoPaged<Item>(`${zohoConfig.inventoryBase}/items`, "items", {
      status: "active",
      ...sinceParam(since),
    });
    let pulled = 0;
    for (const it of items) {
      const rawSku = it.sku ?? "";
      const norm = normalizeCode(rawSku);
      const skuId = norm ? idByNorm.get(norm) : undefined;

      const stock = String(it.actual_available_stock ?? it.stock_on_hand ?? 0);
      await db
        .insert(zohoItemCache)
        .values({
          zohoItemId: String(it.item_id),
          itemName: it.name ?? "",
          skuText: skuId ? norm : rawSku,
          stockOnHand: stock,
          rate: it.rate != null ? String(it.rate) : null,
          lastModifiedTime: it.last_modified_time,
        })
        .onConflictDoUpdate({
          target: zohoItemCache.zohoItemId,
          set: {
            itemName: it.name ?? "",
            skuText: skuId ? norm : rawSku,
            stockOnHand: stock,
            rate: it.rate != null ? String(it.rate) : null,
            lastModifiedTime: it.last_modified_time,
            fetchedAt: new Date(),
          },
        });
      if (skuId) {
        await db
          .update(skus)
          .set({ zohoItemId: String(it.item_id) })
          .where(eq(skus.id, skuId));
      }
      pulled++;
    }
    return pulled;
  });
}

export function syncVendors(since?: Date) {
  return runSync("VENDOR", async () => {
    type V = { contact_id: string; contact_name?: string; vendor_name?: string };
    const vs = await zohoPaged<V>(
      `${zohoConfig.inventoryBase}/vendors`,
      "contacts",
      sinceParam(since),
    );
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

export function syncCustomers(since?: Date) {
  return runSync("CUSTOMER", async () => {
    type C = { contact_id: string; contact_name?: string };
    const cs = await zohoPaged<C>(`${zohoConfig.booksBase}/contacts`, "contacts", {
      contact_type: "customer",
      ...sinceParam(since),
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

type PO = {
  purchaseorder_id: string;
  purchaseorder_number?: string;
  vendor_id?: string;
  vendor_name?: string;
  date?: string;
  status?: string;
  received_status?: string;
  last_modified_time?: string;
};

/** A PO stays cached until it's fully received / closed. Drafts ARE kept (the
 *  PO list filters on them); receiving + the review workspace exclude drafts
 *  themselves — a draft must never be receivable. */
function isOpenPO(p: PO): boolean {
  const s = (p.status || "").toLowerCase();
  const rs = (p.received_status || "").toLowerCase();
  if (["closed", "cancelled", "canceled", "void", "rejected"].includes(s))
    return false;
  if (rs === "received") return false;
  return true;
}

type SO = {
  salesorder_id: string;
  salesorder_number?: string;
  customer_id?: string;
  customer_name?: string;
  date?: string;
  status?: string;
  order_status?: string;
  invoiced_status?: string;
  shipped_status?: string;
  last_modified_time?: string;
};

/**
 * An SO feeds the Pick List only while it still needs fulfilment. Zoho's SO
 * status vocabulary varies by module version, so exclusion is defensive:
 * anything drafted/void/closed/fully-shipped drops out.
 */
function isOpenSO(so: SO): boolean {
  const s = (so.status || "").toLowerCase();
  const os = (so.order_status || "").toLowerCase();
  const CLOSED = ["draft", "void", "closed", "cancelled", "canceled", "onhold", "on_hold"];
  if (CLOSED.includes(s) || CLOSED.includes(os)) return false;
  if ((so.shipped_status || "").toLowerCase() === "shipped") return false;
  if (s === "fulfilled" || os === "fulfilled") return false;
  return true;
}

/**
 * Sales Orders — LEAN, mirrors the PO sync: only OPEN (to-be-fulfilled) SOs are
 * cached; they are the Zoho source of the Pick List. Closed/shipped SOs in the
 * window are deleted from cache so completed orders drop out of picking.
 */
export function syncSalesOrders(since?: Date) {
  return runSync("SO", async () => {
    const summaries = await zohoPaged<SO>(
      `${zohoConfig.inventoryBase}/salesorders`,
      "salesorders",
      { sort_column: "date", sort_order: "D", ...sinceParam(since) },
      10,
    );
    const closed = summaries.filter((so) => !isOpenSO(so));
    for (const so of closed) {
      await db
        .delete(zohoSoCache)
        .where(eq(zohoSoCache.zohoSoId, String(so.salesorder_id)));
    }
    const open = summaries.filter(isOpenSO);
    for (const so of open) {
      let lineItems: unknown = null;
      try {
        const detail = await zohoGet<{ salesorder?: { line_items?: unknown } }>(
          `${zohoConfig.inventoryBase}/salesorders/${so.salesorder_id}`,
        );
        lineItems = detail.salesorder?.line_items ?? null;
      } catch {
        /* keep summary even if detail fails */
      }
      await db
        .insert(zohoSoCache)
        .values({
          zohoSoId: String(so.salesorder_id),
          soNumber: so.salesorder_number,
          customerZohoId: so.customer_id,
          customerName: so.customer_name,
          soDate: so.date ?? null,
          status: so.status,
          lineItems,
          lastModifiedTime: so.last_modified_time,
        })
        .onConflictDoUpdate({
          target: zohoSoCache.zohoSoId,
          set: {
            soNumber: so.salesorder_number,
            customerName: so.customer_name,
            status: so.status,
            lineItems,
            lastModifiedTime: so.last_modified_time,
            fetchedAt: new Date(),
          },
        });
    }
    return open.length;
  });
}

/**
 * Purchase Orders — LEAN: only OPEN / not-fully-received POs (the ones receiving
 * checks against). Fetches recent summaries (newest first), keeps open ones, and
 * pulls line-item detail only for those.
 */
export function syncPurchaseOrders(since?: Date) {
  return runSync("PO", async () => {
    const summaries = await zohoPaged<PO>(
      `${zohoConfig.inventoryBase}/purchaseorders`,
      "purchaseorders",
      { sort_column: "date", sort_order: "D", ...sinceParam(since) },
      10,
    );
    // Any PO in this window that's no longer open (closed / fully received /
    // cancelled) is removed from cache so it stops showing on the receiving sheet.
    const closed = summaries.filter((p) => !isOpenPO(p));
    for (const po of closed) {
      await db
        .delete(zohoPoCache)
        .where(eq(zohoPoCache.zohoPoId, String(po.purchaseorder_id)));
    }
    const open = summaries.filter(isOpenPO);
    for (const po of open) {
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
          receivedStatus: po.received_status ?? null,
          lineItems,
          lastModifiedTime: po.last_modified_time,
        })
        .onConflictDoUpdate({
          target: zohoPoCache.zohoPoId,
          set: {
            poNumber: po.purchaseorder_number,
            vendorName: po.vendor_name,
            status: po.status,
            receivedStatus: po.received_status ?? null,
            lineItems,
            lastModifiedTime: po.last_modified_time,
            fetchedAt: new Date(),
          },
        });
    }
    return open.length;
  });
}
