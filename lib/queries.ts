import { and, eq, desc, sql, isNotNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  skus,
  zohoVendorCache,
  zohoCustomerCache,
  zohoPoCache,
  zohoInvoiceCache,
  receivingDoc,
  receivingLine,
  stockLedger,
  locations,
  users,
} from "@/lib/db/schema";
import { normalizeCode } from "@/lib/sku";
import { RECEIVING_VENDOR_DENYLIST } from "@/lib/constants";
import { D } from "@/lib/money";

export type SkuOption = {
  id: number;
  code: string;
  name: string;
  channel: string;
  uom: string;
  packSizeText: string | null;
  motherSkuId: number | null;
};

const skuCols = {
  id: skus.id,
  code: skus.code,
  name: skus.name,
  channel: skus.channel,
  uom: skus.uom,
  packSizeText: skus.packSizeText,
  motherSkuId: skus.motherSkuId,
};

export async function motherSkus(): Promise<SkuOption[]> {
  return db
    .select(skuCols)
    .from(skus)
    .where(and(eq(skus.skuKind, "MOTHER"), eq(skus.isActive, true)))
    .orderBy(skus.code);
}

export async function packSkusByChannel(channel: string): Promise<SkuOption[]> {
  return db
    .select(skuCols)
    .from(skus)
    .where(
      and(
        eq(skus.skuKind, "DERIVATIVE"),
        eq(skus.channel, channel as never),
        eq(skus.isActive, true),
      ),
    )
    .orderBy(skus.code);
}

export async function allActiveSkus(): Promise<SkuOption[]> {
  return db
    .select(skuCols)
    .from(skus)
    .where(eq(skus.isActive, true))
    .orderBy(skus.code);
}

export async function vendors() {
  return db
    .select({ id: zohoVendorCache.id, name: zohoVendorCache.name })
    .from(zohoVendorCache)
    .where(eq(zohoVendorCache.isActive, true))
    .orderBy(zohoVendorCache.name);
}

export async function customers() {
  return db
    .select({ id: zohoCustomerCache.id, name: zohoCustomerCache.name })
    .from(zohoCustomerCache)
    .where(eq(zohoCustomerCache.isActive, true))
    .orderBy(zohoCustomerCache.name);
}

export async function openPurchaseOrders() {
  return db
    .select()
    .from(zohoPoCache)
    .orderBy(desc(zohoPoCache.poDate))
    .limit(200);
}

export async function recentInvoices(limit = 200) {
  return db
    .select({
      id: zohoInvoiceCache.id,
      zohoInvoiceId: zohoInvoiceCache.zohoInvoiceId,
      invoiceNumber: zohoInvoiceCache.invoiceNumber,
      customerName: zohoInvoiceCache.customerName,
      invoiceDate: zohoInvoiceCache.invoiceDate,
    })
    .from(zohoInvoiceCache)
    .orderBy(desc(zohoInvoiceCache.invoiceDate))
    .limit(limit);
}

/* =========================================================================
 * Receiving — open POs with parsed line items, each resolved to a local SKU.
 * Drives the PO-driven receiving sheet (vendor + items + expected qty
 * auto-fill; staff only enters accepted qty). Falls back to manual entry in
 * the UI when this returns nothing (e.g. Zoho not synced).
 * =======================================================================*/
export type ReceivingPoLine = {
  skuText: string;
  name: string;
  expectedQty: string;
  skuId: number | null;
  code: string | null;
  uom: string | null;
};
export type ReceivingPo = {
  zohoPoId: string;
  poNumber: string | null;
  vendorName: string | null;
  lines: ReceivingPoLine[];
};

export async function openPurchaseOrdersForReceiving(): Promise<ReceivingPo[]> {
  const [pos, skuList, received] = await Promise.all([
    db
      .select()
      .from(zohoPoCache)
      .orderBy(desc(zohoPoCache.poDate))
      .limit(200),
    allActiveSkus(),
    // (PO, sku) pairs already received — drop only those LINES from the sheet,
    // so the rest of a partially-received PO stays available for later receipt.
    db
      .select({ zohoPoId: receivingDoc.zohoPoId, skuId: receivingLine.skuId })
      .from(receivingLine)
      .innerJoin(receivingDoc, eq(receivingDoc.id, receivingLine.docId))
      .where(
        and(eq(receivingDoc.docStatus, "POSTED"), isNotNull(receivingDoc.zohoPoId)),
      ),
  ]);
  const byNorm = new Map<string, SkuOption>();
  for (const s of skuList) byNorm.set(normalizeCode(s.code), s);
  const receivedKey = new Set(
    received
      .filter((r) => r.zohoPoId)
      .map((r) => `${r.zohoPoId}::${r.skuId}`),
  );

  return pos
    .map((po) => {
      const raw = Array.isArray(po.lineItems)
        ? (po.lineItems as Record<string, unknown>[])
        : [];
      const lines: ReceivingPoLine[] = raw
        .map((li) => {
          const skuText = String(li.sku ?? "");
          const match = skuText ? byNorm.get(normalizeCode(skuText)) : undefined;
          const expected =
            li.quantity ?? li.quantity_ordered ?? li.bcy_quantity ?? 0;
          return {
            skuText,
            name: String(li.name ?? li.description ?? ""),
            expectedQty: String(expected ?? 0),
            skuId: match?.id ?? null,
            code: match?.code ?? null,
            uom: match?.uom ?? null,
          };
        })
        // drop lines already received against this PO (matched SKUs only)
        .filter((ln) => !(ln.skuId && receivedKey.has(`${po.zohoPoId}::${ln.skuId}`)));
      return {
        zohoPoId: po.zohoPoId,
        poNumber: po.poNumber,
        vendorName: po.vendorName,
        lines,
      };
    })
    // Only show produce POs: a PO must have at least one line that resolves to a
    // known EAT SKU. Non-produce vendors (e.g. "Cold Room Engineers" equipment
    // POs) match no SKU and drop off automatically. An explicit vendor denylist
    // force-hides specific vendors regardless of their lines.
    .filter((po) => {
      const vn = (po.vendorName ?? "").trim().toLowerCase();
      if (RECEIVING_VENDOR_DENYLIST.some((d) => vn.includes(d))) return false;
      return po.lines.some((ln) => ln.skuId != null);
    });
}

/* =========================================================================
 * Sorting — items received (POSTED receiving docs) that haven't been fully
 * sorted yet. Pre-fills the sorting sheet straight from the local receiving
 * sheet (no Zoho), so "what's been graded" is always verifiable from
 * sorting_line. `receivedQty` is the remaining-to-sort amount.
 * =======================================================================*/
export type PendingSortRow = {
  skuId: number;
  code: string;
  name: string;
  uom: string;
  receivedQty: string;
  vendor: string | null;
};

export async function receivedPendingSort(): Promise<PendingSortRow[]> {
  const res = await db.execute(sql`
    SELECT k.id AS sku_id, k.code, k.name, k.uom,
           (COALESCE(r.received, 0) - COALESCE(s.sorted, 0)) AS remaining,
           r.vendors
    FROM skus k
    JOIN (
      SELECT rl.sku_id,
             SUM(rl.accepted_qty) AS received,
             string_agg(DISTINCT COALESCE(pc.vendor_name, vc.name), ', ') AS vendors
      FROM receiving_line rl
      JOIN receiving_doc rd ON rd.id = rl.doc_id AND rd.doc_status = 'POSTED'
      LEFT JOIN zoho_po_cache pc ON pc.zoho_po_id = rd.zoho_po_id
      LEFT JOIN zoho_vendor_cache vc ON vc.id = rd.vendor_id
      GROUP BY rl.sku_id
    ) r ON r.sku_id = k.id
    LEFT JOIN (
      SELECT sl.sku_id, SUM(sl.sorted_qty) AS sorted
      FROM sorting_line sl
      JOIN sorting_doc sd ON sd.id = sl.doc_id AND sd.doc_status = 'POSTED'
      GROUP BY sl.sku_id
    ) s ON s.sku_id = k.id
    WHERE (COALESCE(r.received, 0) - COALESCE(s.sorted, 0)) > 0
    ORDER BY k.code
  `);
  // drizzle returns { rows } for neon, array-like for pglite — normalize
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = (res as any).rows ?? (res as any) ?? [];
  return rows.map((row) => ({
    skuId: Number(row.sku_id),
    code: String(row.code),
    name: String(row.name),
    uom: String(row.uom),
    receivedQty: String(row.remaining),
    vendor: row.vendors ? String(row.vendors) : null,
  }));
}

/* =========================================================================
 * Wastage — every waste movement recorded anywhere (manual hub wastage,
 * sorting waste, regrade waste, return waste). The stock_ledger is the single
 * source of truth, so this captures waste from every tab in one place.
 * =======================================================================*/
export type WastageRow = {
  id: number;
  businessDate: string;
  code: string;
  name: string;
  location: string;
  movementType: string;
  qty: string; // absolute, 3-dp
  note: string | null;
  user: string | null;
};

const WASTE_MOVEMENT_TYPES = [
  "WASTAGE",
  "SORT_WASTE",
  "REGRADE_WASTE",
  "RETURN_WASTE",
] as const;

export async function recentWastage(limit = 100): Promise<WastageRow[]> {
  const rows = await db
    .select({
      id: stockLedger.id,
      businessDate: stockLedger.businessDate,
      code: skus.code,
      name: skus.name,
      location: locations.name,
      movementType: stockLedger.movementType,
      qtySigned: stockLedger.qtySigned,
      note: stockLedger.note,
      user: users.fullName,
    })
    .from(stockLedger)
    .innerJoin(skus, eq(skus.id, stockLedger.skuId))
    .innerJoin(locations, eq(locations.id, stockLedger.locationId))
    .leftJoin(users, eq(users.id, stockLedger.userId))
    .where(inArray(stockLedger.movementType, [...WASTE_MOVEMENT_TYPES]))
    .orderBy(desc(stockLedger.id))
    .limit(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    businessDate: String(r.businessDate),
    code: r.code,
    name: r.name,
    location: r.location,
    movementType: String(r.movementType),
    qty: D(r.qtySigned).abs().toFixed(3),
    note: r.note,
    user: r.user,
  }));
}
