import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  zohoItemCache,
  zohoVendorCache,
  zohoCustomerCache,
  zohoPoCache,
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
  // Zoho expects e.g. 2024-01-15T10:30:00+0530; we send ISO (UTC, no millis).
  return { last_modified_time: since.toISOString().replace(/\.\d{3}Z$/, "Z") };
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
 * Items + stock-on-hand — LEAN: only keep/link Zoho items that match an
 * existing EAT SKU (by normalized code). Non-produce items are skipped entirely
 * (no catalog bloat). Sets zoho_item_id on the SKU + caches stock for the
 * opening-balance backfill.
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
    let matched = 0;
    for (const it of items) {
      const norm = normalizeCode(it.sku ?? "");
      if (!norm) continue;
      const skuId = idByNorm.get(norm);
      if (!skuId) continue; // skip non-EAT / unknown items (lean scope)

      const stock = String(it.actual_available_stock ?? it.stock_on_hand ?? 0);
      await db
        .insert(zohoItemCache)
        .values({
          zohoItemId: String(it.item_id),
          itemName: it.name ?? "",
          skuText: norm,
          stockOnHand: stock,
          rate: it.rate != null ? String(it.rate) : null,
          lastModifiedTime: it.last_modified_time,
        })
        .onConflictDoUpdate({
          target: zohoItemCache.zohoItemId,
          set: {
            itemName: it.name ?? "",
            skuText: norm,
            stockOnHand: stock,
            rate: it.rate != null ? String(it.rate) : null,
            lastModifiedTime: it.last_modified_time,
            fetchedAt: new Date(),
          },
        });
      await db
        .update(skus)
        .set({ zohoItemId: String(it.item_id) })
        .where(eq(skus.id, skuId));
      matched++;
    }
    return matched;
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

/** A PO still matters to receiving only until it's fully received / closed. */
function isOpenPO(p: PO): boolean {
  const s = (p.status || "").toLowerCase();
  const rs = (p.received_status || "").toLowerCase();
  if (["closed", "cancelled", "canceled", "void", "rejected", "draft"].includes(s))
    return false;
  if (rs === "received") return false;
  return true;
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
    return open.length;
  });
}
