import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { stockBalance, stockLedger, skus, locations } from "@/lib/db/schema";
import { add, qtyStr } from "@/lib/money";

/** Current cached balance for a (sku, location). Returns "0.000" if none. */
export async function currentBalance(
  skuId: number,
  locationId: number,
): Promise<string> {
  const rows = await db
    .select({ qty: stockBalance.qty })
    .from(stockBalance)
    .where(and(eq(stockBalance.skuId, skuId), eq(stockBalance.locationId, locationId)));
  return rows[0]?.qty ?? "0.000";
}

export type LiveStockRow = {
  skuId: number;
  code: string;
  name: string;
  channel: string;
  locationId: number;
  locationCode: string;
  qty: string;
  uom: string;
  updatedAt: Date;
};

/** Live inventory snapshot — everything with non-zero stock. */
export async function liveStock(): Promise<LiveStockRow[]> {
  return db
    .select({
      skuId: stockBalance.skuId,
      code: skus.code,
      name: skus.name,
      channel: skus.channel,
      locationId: stockBalance.locationId,
      locationCode: locations.code,
      qty: stockBalance.qty,
      uom: stockBalance.uom,
      updatedAt: stockBalance.updatedAt,
    })
    .from(stockBalance)
    .innerJoin(skus, eq(skus.id, stockBalance.skuId))
    .innerJoin(locations, eq(locations.id, stockBalance.locationId))
    .where(sql`${stockBalance.qty} <> 0`)
    .orderBy(skus.code);
}

/** Full immutable ledger for one SKU (newest first) — the audit drill-down. */
export async function skuLedger(skuId: number, limit = 500) {
  return db
    .select({
      id: stockLedger.id,
      movementType: stockLedger.movementType,
      qtySigned: stockLedger.qtySigned,
      balanceAfter: stockLedger.balanceAfter,
      locationCode: locations.code,
      docType: stockLedger.docType,
      docId: stockLedger.docId,
      businessDate: stockLedger.businessDate,
      userId: stockLedger.userId,
      note: stockLedger.note,
      createdAt: stockLedger.createdAt,
    })
    .from(stockLedger)
    .innerJoin(locations, eq(locations.id, stockLedger.locationId))
    .where(eq(stockLedger.skuId, skuId))
    .orderBy(desc(stockLedger.id))
    .limit(limit);
}

/**
 * Reconcile: SUM(ledger.qty_signed) per (sku, location) must equal the cached
 * stock_balance.qty. Returns any drift rows (should always be empty).
 */
export async function reconcile() {
  const rows = await db.execute(sql`
    SELECT b.sku_id, b.location_id, b.qty AS balance_qty,
           COALESCE(l.sum_qty, 0) AS ledger_qty
    FROM stock_balance b
    LEFT JOIN (
      SELECT sku_id, location_id, SUM(qty_signed) AS sum_qty
      FROM stock_ledger GROUP BY sku_id, location_id
    ) l ON l.sku_id = b.sku_id AND l.location_id = b.location_id
    WHERE b.qty <> COALESCE(l.sum_qty, 0)
  `);
  // drizzle returns { rows } for neon, array-like for pglite — normalize
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = (rows as any).rows ?? (rows as any) ?? [];
  return out;
}

export type CombinedStockRow = {
  skuId: number;
  code: string;
  name: string;
  uom: string;
  zohoQty: string;
  unpushedDelta: string;
  combinedQty: string;
};

/**
 * Aniket's complete picture: Zoho stock-on-hand (as of the last Items sync)
 * plus every LOCAL movement whose document hasn't been pushed to Zoho yet.
 * v3: "pushed" = a CONFIRMED zoho_push SUCCESS of an inventory-affecting kind
 * (a Books bill doesn't move stock, and UNKNOWN/FAILED keep the delta visible
 * until reconciled). OPENING docs are excluded — they were seeded FROM Zoho.
 */
export async function combinedZohoStock(): Promise<CombinedStockRow[]> {
  const res = await db.execute(sql`
    SELECT k.id AS sku_id, k.code, k.name, k.uom,
           COALESCE(z.stock_on_hand, 0) AS zoho_qty,
           COALESCE(d.delta, 0) AS unpushed_delta
    FROM skus k
    LEFT JOIN zoho_item_cache z ON z.zoho_item_id = k.zoho_item_id
    LEFT JOIN (
      SELECT l.sku_id, SUM(l.qty_signed) AS delta
      FROM stock_ledger l
      WHERE l.doc_type <> 'OPENING'
        AND NOT EXISTS (
          SELECT 1 FROM zoho_push z
          WHERE z.doc_type = l.doc_type::text
            AND z.doc_id = l.doc_id
            AND z.status = 'SUCCESS'
            AND z.kind IN ('receiving.receive', 'wastage.adj', 'adjustment.adj', 'assembly.bundle')
        )
      GROUP BY l.sku_id
    ) d ON d.sku_id = k.id
    WHERE k.is_active = true
      AND (COALESCE(z.stock_on_hand, 0) <> 0 OR COALESCE(d.delta, 0) <> 0)
    ORDER BY k.code
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = (res as any).rows ?? (res as any) ?? [];
  return rows.map((r) => {
    const zoho = String(r.zoho_qty ?? "0");
    const delta = String(r.unpushed_delta ?? "0");
    return {
      skuId: Number(r.sku_id),
      code: String(r.code),
      name: String(r.name),
      uom: String(r.uom),
      zohoQty: qtyStr(zoho),
      unpushedDelta: qtyStr(delta),
      combinedQty: qtyStr(add(zoho, delta)),
    };
  });
}

/** Grade-composition report (informational): A/B/C totals from sorting events. */
export async function gradeComposition(from?: string, to?: string) {
  const conds = [];
  if (from) conds.push(sql`s.business_date >= ${from}`);
  if (to) conds.push(sql`s.business_date <= ${to}`);
  const where = conds.length
    ? sql`WHERE ${sql.join(conds, sql` AND `)}`
    : sql``;
  const rows = await db.execute(sql`
    SELECT k.code, k.name,
           SUM(sl.qty_a) AS grade_a,
           SUM(sl.qty_b) AS grade_b,
           SUM(sl.qty_c) AS grade_c,
           SUM(sl.qty_waste) AS waste
    FROM sorting_line sl
    JOIN sorting_doc s ON s.id = sl.doc_id AND s.doc_status = 'POSTED'
    JOIN skus k ON k.id = sl.sku_id
    ${where}
    GROUP BY k.code, k.name
    ORDER BY k.code
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((rows as any).rows ?? (rows as any) ?? []) as any[];
}
