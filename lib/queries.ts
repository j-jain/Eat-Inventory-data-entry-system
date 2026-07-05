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
  pickList,
  pickListLine,
  pickListLineSource,
  pickListSource,
  manualOrderDoc,
  manualOrderLine,
  dispatchDoc,
  dispatchLine,
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
  /** set once the Items sync matched this SKU to a Zoho item */
  zohoItemId: string | null;
};

const skuCols = {
  id: skus.id,
  code: skus.code,
  name: skus.name,
  channel: skus.channel,
  uom: skus.uom,
  packSizeText: skus.packSizeText,
  motherSkuId: skus.motherSkuId,
  zohoItemId: skus.zohoItemId,
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
    .select({
      id: zohoVendorCache.id,
      name: zohoVendorCache.name,
      vendorZohoId: zohoVendorCache.zohoContactId,
    })
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
  /** Original PO line qty (as ordered in Zoho). */
  expectedQty: string;
  /** Cumulative accepted across all POSTED receipts of this (PO, SKU). */
  alreadyReceivedQty: string;
  /** expected − alreadyReceived — what staff receive against today. */
  remainingQty: string;
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
    // Cumulative accepted per (PO, sku) over POSTED docs. A line stays on the
    // sheet until fully received (supports partial deliveries, Situation 3);
    // voided receipts drop out of the SUM so their remaining reappears.
    db
      .select({
        zohoPoId: receivingDoc.zohoPoId,
        skuId: receivingLine.skuId,
        received: sql<string>`SUM(${receivingLine.acceptedQty})`,
      })
      .from(receivingLine)
      .innerJoin(receivingDoc, eq(receivingDoc.id, receivingLine.docId))
      .where(
        and(eq(receivingDoc.docStatus, "POSTED"), isNotNull(receivingDoc.zohoPoId)),
      )
      .groupBy(receivingDoc.zohoPoId, receivingLine.skuId),
  ]);
  const byNorm = new Map<string, SkuOption>();
  for (const s of skuList) byNorm.set(normalizeCode(s.code), s);
  const cumulative = new Map<string, string>(
    received
      .filter((r) => r.zohoPoId)
      .map((r) => [`${r.zohoPoId}::${r.skuId}`, String(r.received)]),
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
          const got = match
            ? (cumulative.get(`${po.zohoPoId}::${match.id}`) ?? "0")
            : "0";
          const remaining = D(String(expected ?? 0)).minus(D(got));
          return {
            skuText,
            name: String(li.name ?? li.description ?? ""),
            expectedQty: String(expected ?? 0),
            alreadyReceivedQty: D(got).toFixed(3),
            remainingQty: remaining.toFixed(3),
            skuId: match?.id ?? null,
            code: match?.code ?? null,
            uom: match?.uom ?? null,
          };
        })
        // keep a line while anything remains to receive (matched SKUs only)
        .filter((ln) => !(ln.skuId && D(ln.remainingQty).lte(0)));
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
 * Sorting — whatever sits in the Receiving Bay. Since v2, receipts land in
 * the Bay and sorting is the only path into the Cold Room, so "received but
 * unsorted" IS the Bay balance — one indexed lookup, no reconciliation math.
 * Vendor context comes from the latest POSTED receiving of each SKU.
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
    SELECT k.id AS sku_id, k.code, k.name, k.uom, b.qty AS remaining,
           (
             SELECT COALESCE(pc.vendor_name, vc.name)
             FROM receiving_line rl
             JOIN receiving_doc rd ON rd.id = rl.doc_id AND rd.doc_status = 'POSTED'
             LEFT JOIN zoho_po_cache pc ON pc.zoho_po_id = rd.zoho_po_id
             LEFT JOIN zoho_vendor_cache vc ON vc.id = rd.vendor_id
             WHERE rl.sku_id = k.id
             ORDER BY rd.id DESC
             LIMIT 1
           ) AS vendor
    FROM stock_balance b
    JOIN locations l ON l.id = b.location_id AND l.code = 'RECEIVING_BAY'
    JOIN skus k ON k.id = b.sku_id
    WHERE b.qty > 0
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
    vendor: row.vendor ? String(row.vendor) : null,
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

/* =========================================================================
 * Pick List + Orders + Dispatch reads (v2)
 * =======================================================================*/
export type PickListLineRow = {
  lineId: number;
  skuId: number;
  code: string;
  name: string;
  uom: string;
  motherCode: string | null;
  qtyToPick: string;
  qtyPicked: string;
  /** which order(s) this line came from + how much each contributed */
  from: { orderNo: string; qty: string; sourceType: string }[];
};
export type PickListDetail = {
  id: number;
  businessDate: string;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  note: string | null;
  shortCompleteReason: string | null;
  createdBy: string | null;
  completedAt: string | null;
  lines: PickListLineRow[];
  sources: { soCount: number; manualCount: number };
  /** orders consumed by this list whose lines matched NO local SKU */
  unmatchedOrders: string[];
};

/** The OPEN list if any, else the latest COMPLETED list for `date` (IST today by default). */
export async function currentPickList(date?: string): Promise<PickListDetail | null> {
  const mother = sql<string | null>`(SELECT m.code FROM skus m WHERE m.id = ${skus.motherSkuId})`;
  const open = await db
    .select({
      id: pickList.id,
      businessDate: pickList.businessDate,
      status: pickList.status,
      note: pickList.note,
      shortCompleteReason: pickList.shortCompleteReason,
      createdBy: users.fullName,
      completedAt: pickList.completedAt,
    })
    .from(pickList)
    .leftJoin(users, eq(users.id, pickList.createdByUserId))
    .where(eq(pickList.status, "OPEN"))
    .limit(1);
  let head = open[0];
  if (!head && date) {
    const done = await db
      .select({
        id: pickList.id,
        businessDate: pickList.businessDate,
        status: pickList.status,
        note: pickList.note,
        shortCompleteReason: pickList.shortCompleteReason,
        createdBy: users.fullName,
        completedAt: pickList.completedAt,
      })
      .from(pickList)
      .leftJoin(users, eq(users.id, pickList.createdByUserId))
      .where(and(eq(pickList.businessDate, date), eq(pickList.status, "COMPLETED")))
      .orderBy(desc(pickList.id))
      .limit(1);
    head = done[0];
  }
  if (!head) return null;

  const [lines, sources] = await Promise.all([
    db
      .select({
        lineId: pickListLine.id,
        skuId: pickListLine.skuId,
        code: skus.code,
        name: skus.name,
        uom: pickListLine.uom,
        motherCode: mother,
        qtyToPick: pickListLine.qtyToPick,
        qtyPicked: pickListLine.qtyPicked,
      })
      .from(pickListLine)
      .innerJoin(skus, eq(skus.id, pickListLine.skuId))
      .where(eq(pickListLine.pickListId, head.id))
      .orderBy(skus.code),
    db
      .select({
        sourceType: pickListSource.sourceType,
        orderNo: pickListSource.orderNo,
        matched: pickListSource.matched,
      })
      .from(pickListSource)
      .where(eq(pickListSource.pickListId, head.id)),
  ]);
  const lineIds = lines.map((l) => l.lineId);
  const provenance = lineIds.length
    ? await db
        .select({
          pickListLineId: pickListLineSource.pickListLineId,
          orderNo: pickListLineSource.orderNo,
          qty: pickListLineSource.qty,
          sourceType: pickListLineSource.sourceType,
        })
        .from(pickListLineSource)
        .where(inArray(pickListLineSource.pickListLineId, lineIds))
    : [];
  const fromByLine = new Map<number, PickListLineRow["from"]>();
  for (const p of provenance) {
    const arr = fromByLine.get(p.pickListLineId) ?? [];
    arr.push({
      orderNo: p.orderNo ?? "?",
      qty: String(p.qty),
      sourceType: String(p.sourceType),
    });
    fromByLine.set(p.pickListLineId, arr);
  }
  return {
    id: head.id,
    businessDate: String(head.businessDate),
    status: head.status as PickListDetail["status"],
    note: head.note,
    shortCompleteReason: head.shortCompleteReason,
    createdBy: head.createdBy,
    completedAt: head.completedAt ? new Date(head.completedAt).toISOString() : null,
    lines: lines.map((l) => ({
      ...l,
      uom: String(l.uom),
      qtyToPick: String(l.qtyToPick),
      qtyPicked: String(l.qtyPicked),
      from: fromByLine.get(l.lineId) ?? [],
    })),
    sources: {
      soCount: sources.filter((s) => s.sourceType === "ZOHO_SO").length,
      manualCount: sources.filter((s) => s.sourceType === "MANUAL_ORDER").length,
    },
    unmatchedOrders: sources
      .filter((s) => !s.matched)
      .map((s) => s.orderNo ?? "unknown order"),
  };
}

export type ManualOrderRow = {
  id: number;
  businessDate: string;
  customerName: string | null;
  channel: string | null;
  orderRef: string | null;
  createdBy: string | null;
  picked: boolean;
  lines: { code: string; name: string; qty: string; uom: string }[];
};

/** POSTED manual orders, newest first; `picked` = already fed a pick list. */
export async function recentManualOrders(limit = 50): Promise<ManualOrderRow[]> {
  const docs = await db
    .select({
      id: manualOrderDoc.id,
      businessDate: manualOrderDoc.businessDate,
      customerName: zohoCustomerCache.name,
      channel: manualOrderDoc.channel,
      orderRef: manualOrderDoc.orderRef,
      createdBy: users.fullName,
    })
    .from(manualOrderDoc)
    .leftJoin(zohoCustomerCache, eq(zohoCustomerCache.id, manualOrderDoc.customerId))
    .leftJoin(users, eq(users.id, manualOrderDoc.createdByUserId))
    .where(eq(manualOrderDoc.docStatus, "POSTED"))
    .orderBy(desc(manualOrderDoc.id))
    .limit(limit);
  if (!docs.length) return [];
  const ids = docs.map((d) => d.id);
  const [lines, sourced] = await Promise.all([
    db
      .select({
        docId: manualOrderLine.docId,
        code: skus.code,
        name: skus.name,
        qty: manualOrderLine.qty,
        uom: manualOrderLine.uom,
      })
      .from(manualOrderLine)
      .innerJoin(skus, eq(skus.id, manualOrderLine.skuId))
      .where(inArray(manualOrderLine.docId, ids)),
    db
      .select({ docId: pickListSource.manualOrderDocId })
      .from(pickListSource)
      .where(
        and(
          isNotNull(pickListSource.manualOrderDocId),
          inArray(pickListSource.manualOrderDocId, ids),
        ),
      ),
  ]);
  const pickedSet = new Set(sourced.map((s) => s.docId));
  return docs.map((d) => ({
    id: d.id,
    businessDate: String(d.businessDate),
    customerName: d.customerName,
    channel: d.channel ? String(d.channel) : null,
    orderRef: d.orderRef,
    createdBy: d.createdBy,
    picked: pickedSet.has(d.id),
    lines: lines
      .filter((l) => l.docId === d.id)
      .map((l) => ({ code: l.code, name: l.name, qty: String(l.qty), uom: String(l.uom) })),
  }));
}

export type DispatchPrelistRow = {
  skuId: number;
  code: string;
  name: string;
  uom: string;
  pickedQty: string;
  dispatchedToday: string;
  remainingQty: string; // picked − already dispatched today
};

/**
 * Dispatch prelist: the completed pick list's packs, minus what's already
 * been dispatched today (all POSTED dispatch docs of `date`).
 */
export async function dispatchPrelist(
  pickListId: number,
  date: string,
): Promise<DispatchPrelistRow[]> {
  const [lines, dispatched] = await Promise.all([
    db
      .select({
        skuId: pickListLine.skuId,
        code: skus.code,
        name: skus.name,
        uom: pickListLine.uom,
        picked: pickListLine.qtyPicked,
      })
      .from(pickListLine)
      .innerJoin(skus, eq(skus.id, pickListLine.skuId))
      .where(eq(pickListLine.pickListId, pickListId))
      .orderBy(skus.code),
    db
      .select({
        skuId: dispatchLine.packSkuId,
        qty: sql<string>`SUM(${dispatchLine.qty})`,
      })
      .from(dispatchLine)
      .innerJoin(dispatchDoc, eq(dispatchDoc.id, dispatchLine.docId))
      .where(and(eq(dispatchDoc.docStatus, "POSTED"), eq(dispatchDoc.businessDate, date)))
      .groupBy(dispatchLine.packSkuId),
  ]);
  const done = new Map(dispatched.map((d) => [d.skuId, String(d.qty)]));
  return lines
    .map((l) => {
      const already = done.get(l.skuId) ?? "0";
      const remaining = D(String(l.picked)).minus(D(already));
      return {
        skuId: l.skuId,
        code: l.code,
        name: l.name,
        uom: String(l.uom),
        pickedQty: String(l.picked),
        dispatchedToday: D(already).toFixed(3),
        remainingQty: remaining.gt(0) ? remaining.toFixed(3) : "0.000",
      };
    })
    .filter((l) => D(l.pickedQty).gt(0));
}

export type TodayDispatchRow = {
  docId: number;
  customerName: string | null;
  channel: string | null;
  dispatchRef: string | null;
  deliveryStatus: string;
  deliveryNote: string | null;
  lines: { lineId: number; code: string; name: string; qty: string; deliveredQty: string; uom: string }[];
};

/** Today's POSTED dispatches with per-line delivered state (delivery cards). */
export async function todaysDispatches(date: string): Promise<TodayDispatchRow[]> {
  const docs = await db
    .select({
      docId: dispatchDoc.id,
      customerName: zohoCustomerCache.name,
      channel: dispatchDoc.channel,
      dispatchRef: dispatchDoc.dispatchRef,
      deliveryStatus: dispatchDoc.deliveryStatus,
      deliveryNote: dispatchDoc.deliveryNote,
    })
    .from(dispatchDoc)
    .leftJoin(zohoCustomerCache, eq(zohoCustomerCache.id, dispatchDoc.customerId))
    .where(and(eq(dispatchDoc.docStatus, "POSTED"), eq(dispatchDoc.businessDate, date)))
    .orderBy(desc(dispatchDoc.id));
  if (!docs.length) return [];
  const lines = await db
    .select({
      docId: dispatchLine.docId,
      lineId: dispatchLine.id,
      code: skus.code,
      name: skus.name,
      qty: dispatchLine.qty,
      deliveredQty: dispatchLine.deliveredQty,
      uom: dispatchLine.uom,
    })
    .from(dispatchLine)
    .innerJoin(skus, eq(skus.id, dispatchLine.packSkuId))
    .where(
      inArray(
        dispatchLine.docId,
        docs.map((d) => d.docId),
      ),
    );
  return docs.map((d) => ({
    docId: d.docId,
    customerName: d.customerName,
    channel: d.channel ? String(d.channel) : null,
    dispatchRef: d.dispatchRef,
    deliveryStatus: String(d.deliveryStatus),
    deliveryNote: d.deliveryNote,
    lines: lines
      .filter((l) => l.docId === d.docId)
      .map((l) => ({
        lineId: l.lineId,
        code: l.code,
        name: l.name,
        qty: String(l.qty),
        deliveredQty: String(l.deliveredQty),
        uom: String(l.uom),
      })),
  }));
}

/* =========================================================================
 * Wastage per stage — one card per source (RECEIVING / SORTING / REGRADE /
 * ASSEMBLY / RETURN / EXPIRY / GENERAL). Combines:
 *   - wastage_line rows (manual hub + auto S4-receiving + record-only assembly)
 *   - SORT_WASTE / REGRADE_WASTE ledger rows (posted by sorting, no line rows)
 *   - return lines marked WASTE (recorded only, never stocked)
 * =======================================================================*/
export type WastageBySourceRow = { source: string; totalQty: string; entries: number };

export async function wastageBySource(days = 30): Promise<WastageBySourceRow[]> {
  const res = await db.execute(sql`
    WITH all_waste AS (
      SELECT wl.source::text AS source, wl.qty AS qty
      FROM wastage_line wl
      JOIN wastage_doc wd ON wd.id = wl.doc_id AND wd.doc_status = 'POSTED'
      WHERE wd.business_date >= CURRENT_DATE - ${days}::int
      UNION ALL
      SELECT CASE sl.movement_type WHEN 'SORT_WASTE' THEN 'SORTING' ELSE 'REGRADE' END,
             ABS(sl.qty_signed)
      FROM stock_ledger sl
      WHERE sl.movement_type IN ('SORT_WASTE', 'REGRADE_WASTE')
        AND sl.business_date >= CURRENT_DATE - ${days}::int
      UNION ALL
      SELECT 'RETURN', rl.qty_return
      FROM return_line rl
      JOIN return_doc rd ON rd.id = rl.doc_id AND rd.doc_status = 'POSTED'
      WHERE rl.disposition = 'WASTE'
        AND rd.business_date >= CURRENT_DATE - ${days}::int
    )
    SELECT source, SUM(qty) AS total_qty, COUNT(*) AS entries
    FROM all_waste
    GROUP BY source
    ORDER BY SUM(qty) DESC
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = (res as any).rows ?? (res as any) ?? [];
  return rows.map((r) => ({
    source: String(r.source),
    totalQty: D(String(r.total_qty)).toFixed(3),
    entries: Number(r.entries),
  }));
}

/* =========================================================================
 * Daily Summary — the digital version of the paper summary sheets: what
 * happened today at every stage, in one place. All aggregates are keyed on
 * business_date and POSTED docs only.
 * =======================================================================*/
export type DailySummary = {
  receiving: {
    code: string;
    name: string;
    vendor: string | null;
    accepted: string;
    expected: string | null;
    variance: string;
  }[];
  sorting: { code: string; name: string; a: string; b: string; c: string; waste: string }[];
  assembly: {
    channel: string;
    packCode: string;
    packName: string;
    used: string;
    packs: string;
    waste: string;
    /** used ÷ packs — the mother→pack conversion rate (kg per pack) */
    yieldPerPack: string | null;
  }[];
  wastage: { source: string; code: string; name: string; qty: string; reason: string }[];
  dispatch: {
    customer: string | null;
    channel: string | null;
    code: string;
    name: string;
    qty: string;
    delivered: string;
    status: string;
  }[];
  pickListExceptions: { id: number; reason: string; completedBy: string | null }[];
};

export async function dailySummary(date: string): Promise<DailySummary> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const norm = (res: any): any[] => res.rows ?? res ?? [];
  const [receiving, sorting, assembly, wastage, dispatch, exceptions] = await Promise.all([
    db.execute(sql`
      SELECT k.code, k.name, COALESCE(pc.vendor_name, vc.name) AS vendor,
             SUM(rl.accepted_qty) AS accepted,
             SUM(rl.po_expected_qty) AS expected,
             rd.variance
      FROM receiving_line rl
      JOIN receiving_doc rd ON rd.id = rl.doc_id AND rd.doc_status = 'POSTED'
      JOIN skus k ON k.id = rl.sku_id
      LEFT JOIN zoho_po_cache pc ON pc.zoho_po_id = rd.zoho_po_id
      LEFT JOIN zoho_vendor_cache vc ON vc.id = rd.vendor_id
      WHERE rd.business_date = ${date}
      GROUP BY k.code, k.name, COALESCE(pc.vendor_name, vc.name), rd.variance
      ORDER BY k.code
    `),
    db.execute(sql`
      SELECT k.code, k.name, SUM(sl.qty_a) a, SUM(sl.qty_b) b, SUM(sl.qty_c) c,
             SUM(sl.qty_waste) waste
      FROM sorting_line sl
      JOIN sorting_doc sd ON sd.id = sl.doc_id AND sd.doc_status = 'POSTED' AND sd.is_recheck = false
      JOIN skus k ON k.id = sl.sku_id
      WHERE sd.business_date = ${date}
      GROUP BY k.code, k.name ORDER BY k.code
    `),
    db.execute(sql`
      SELECT ad.channel, p.code AS pack_code, p.name AS pack_name,
             SUM(al.total_used) used, SUM(al.packs_made) packs, SUM(al.qty_waste) waste
      FROM assembly_line al
      JOIN assembly_doc ad ON ad.id = al.doc_id AND ad.doc_status = 'POSTED'
      JOIN skus p ON p.id = al.pack_sku_id
      WHERE ad.business_date = ${date}
      GROUP BY ad.channel, p.code, p.name ORDER BY ad.channel, p.code
    `),
    db.execute(sql`
      SELECT wl.source, k.code, k.name, SUM(wl.qty) qty,
             string_agg(DISTINCT wl.reason, '; ') reason
      FROM wastage_line wl
      JOIN wastage_doc wd ON wd.id = wl.doc_id AND wd.doc_status = 'POSTED'
      JOIN skus k ON k.id = wl.sku_id
      WHERE wd.business_date = ${date}
      GROUP BY wl.source, k.code, k.name ORDER BY wl.source, k.code
    `),
    db.execute(sql`
      SELECT cc.name AS customer, dd.channel, k.code, k.name,
             SUM(dl.qty) qty, SUM(dl.delivered_qty) delivered, dd.delivery_status status
      FROM dispatch_line dl
      JOIN dispatch_doc dd ON dd.id = dl.doc_id AND dd.doc_status = 'POSTED'
      JOIN skus k ON k.id = dl.pack_sku_id
      LEFT JOIN zoho_customer_cache cc ON cc.id = dd.customer_id
      WHERE dd.business_date = ${date}
      GROUP BY cc.name, dd.channel, k.code, k.name, dd.delivery_status
      ORDER BY k.code
    `),
    db.execute(sql`
      SELECT pl.id, pl.short_complete_reason AS reason, u.full_name AS completed_by
      FROM pick_list pl
      LEFT JOIN users u ON u.id = pl.completed_by_user_id
      WHERE pl.business_date = ${date} AND pl.short_complete_reason IS NOT NULL
      ORDER BY pl.id
    `),
  ]);
  return {
    receiving: norm(receiving).map((r) => ({
      code: String(r.code),
      name: String(r.name),
      vendor: r.vendor ? String(r.vendor) : null,
      accepted: D(String(r.accepted ?? 0)).toFixed(3),
      expected: r.expected != null ? D(String(r.expected)).toFixed(3) : null,
      variance: String(r.variance ?? "NONE"),
    })),
    sorting: norm(sorting).map((r) => ({
      code: String(r.code),
      name: String(r.name),
      a: D(String(r.a ?? 0)).toFixed(3),
      b: D(String(r.b ?? 0)).toFixed(3),
      c: D(String(r.c ?? 0)).toFixed(3),
      waste: D(String(r.waste ?? 0)).toFixed(3),
    })),
    assembly: norm(assembly).map((r) => {
      const used = D(String(r.used ?? 0));
      const packs = D(String(r.packs ?? 0));
      return {
        channel: String(r.channel),
        packCode: String(r.pack_code),
        packName: String(r.pack_name),
        used: used.toFixed(3),
        packs: packs.toFixed(2),
        waste: D(String(r.waste ?? 0)).toFixed(3),
        yieldPerPack: packs.gt(0) ? used.div(packs).toFixed(3) : null,
      };
    }),
    wastage: norm(wastage).map((r) => ({
      source: String(r.source),
      code: String(r.code),
      name: String(r.name),
      qty: D(String(r.qty ?? 0)).toFixed(3),
      reason: String(r.reason ?? ""),
    })),
    dispatch: norm(dispatch).map((r) => ({
      customer: r.customer ? String(r.customer) : null,
      channel: r.channel ? String(r.channel) : null,
      code: String(r.code),
      name: String(r.name),
      qty: D(String(r.qty ?? 0)).toFixed(3),
      delivered: D(String(r.delivered ?? 0)).toFixed(3),
      status: String(r.status),
    })),
    pickListExceptions: norm(exceptions).map((r) => ({
      id: Number(r.id),
      reason: String(r.reason),
      completedBy: r.completed_by ? String(r.completed_by) : null,
    })),
  };
}

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
