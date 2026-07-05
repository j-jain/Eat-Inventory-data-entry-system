import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  locations,
  skus,
  sortingDoc,
  sortingLine,
  stockBalance,
  syncLog,
  zohoItemCache,
} from "@/lib/db/schema";
import { motherCore, normalizeCode } from "@/lib/sku";
import { D } from "@/lib/money";

/**
 * Live Inventory v3 — everything the dashboard subtabs need in one shot:
 *
 *  Receiving   → what sits in the RECEIVING_BAY (local truth)
 *  Cold Storage→ mother SKUs: local cold-room qty + Zoho figure + A/B/C
 *                split graded over the last 7 days (informational — grades
 *                are line data, not stock buckets)
 *  Finished    → pack SKUs grouped under their mother (local FG qty + Zoho)
 *  Zoho-only   → active Zoho items with no local SKU/movement, so the whole
 *                catalog is visible (marked with the last-sync time)
 */
export type BayRow = { skuId: number; code: string; name: string; uom: string; qty: string };

export type GradeSplit = { a: string; b: string; c: string; waste: string };

export type MotherRow = {
  skuId: number;
  code: string;
  name: string;
  uom: string;
  coldQty: string;
  zohoQty: string | null; // null = not linked to Zoho
  grade7d: GradeSplit | null; // null = nothing graded in the window
};

export type PackRow = {
  skuId: number;
  code: string;
  name: string;
  packSize: string | null;
  channel: string;
  fgQty: string;
  zohoQty: string | null;
};

export type MotherGroup = {
  motherSkuId: number | null;
  motherCode: string;
  motherName: string;
  packs: PackRow[];
  totalUnits: string;
};

export type ZohoOnlyRow = {
  zohoItemId: string;
  name: string;
  skuText: string;
  stock: string;
};

export type DashboardInventory = {
  bay: BayRow[];
  mothers: MotherRow[];
  finished: MotherGroup[];
  zohoOnly: ZohoOnlyRow[];
  summary: {
    bayKg: string;
    coldKg: string;
    packUnits: string;
    zohoItemCount: number;
    lastItemSync: string | null; // ISO
  };
};

export async function dashboardInventory(): Promise<DashboardInventory> {
  const gradeCutoff = sql`CURRENT_DATE - 7`;
  const [balances, allSkus, cache, grades, lastSync] = await Promise.all([
    db
      .select({
        skuId: stockBalance.skuId,
        qty: stockBalance.qty,
        locationCode: locations.code,
      })
      .from(stockBalance)
      .innerJoin(locations, eq(locations.id, stockBalance.locationId))
      .where(ne(stockBalance.qty, "0")),
    db
      .select({
        id: skus.id,
        code: skus.code,
        name: skus.name,
        uom: skus.uom,
        skuKind: skus.skuKind,
        channel: skus.channel,
        motherSkuId: skus.motherSkuId,
        packSizeText: skus.packSizeText,
        zohoItemId: skus.zohoItemId,
        isActive: skus.isActive,
      })
      .from(skus)
      .where(eq(skus.isActive, true)),
    db
      .select({
        zohoItemId: zohoItemCache.zohoItemId,
        itemName: zohoItemCache.itemName,
        skuText: zohoItemCache.skuText,
        stockOnHand: zohoItemCache.stockOnHand,
        fetchedAt: zohoItemCache.fetchedAt,
      })
      .from(zohoItemCache),
    db
      .select({
        skuId: sortingLine.skuId,
        a: sql<string>`COALESCE(SUM(${sortingLine.qtyA}), 0)`,
        b: sql<string>`COALESCE(SUM(${sortingLine.qtyB}), 0)`,
        c: sql<string>`COALESCE(SUM(${sortingLine.qtyC}), 0)`,
        waste: sql<string>`COALESCE(SUM(${sortingLine.qtyWaste}), 0)`,
      })
      .from(sortingLine)
      .innerJoin(sortingDoc, eq(sortingDoc.id, sortingLine.docId))
      .where(and(eq(sortingDoc.docStatus, "POSTED"), gte(sortingDoc.businessDate, gradeCutoff)))
      .groupBy(sortingLine.skuId),
    db
      .select({ finishedAt: syncLog.finishedAt })
      .from(syncLog)
      .where(and(eq(syncLog.entity, "ITEM"), eq(syncLog.status, "DONE")))
      .orderBy(desc(syncLog.id))
      .limit(1),
  ]);

  const balBy = (loc: string) => {
    const m = new Map<number, ReturnType<typeof D>>();
    for (const b of balances)
      if (b.locationCode === loc)
        m.set(b.skuId, (m.get(b.skuId) ?? D(0)).plus(D(b.qty)));
    return m;
  };
  const bayBal = balBy("RECEIVING_BAY");
  const coldBal = balBy("COLD_ROOM");
  const fgBal = balBy("DC_FLOOR_FG");

  const zohoByItemId = new Map(cache.map((c) => [c.zohoItemId, c]));
  const gradeBySku = new Map(grades.map((g) => [g.skuId, g]));
  const skuById = new Map(allSkus.map((s) => [s.id, s]));

  // ---- Receiving bay
  const bay: BayRow[] = [...bayBal.entries()]
    .flatMap(([skuId, qty]): BayRow[] => {
      const s = skuById.get(skuId);
      if (!s || qty.lte(0)) return [];
      return [{ skuId, code: s.code, name: s.name, uom: String(s.uom), qty: qty.toFixed(3) }];
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  // ---- Cold storage (mothers) — every active mother appears, even at 0,
  // so "how much of each mother SKU is there" is answerable at a glance.
  const mothers: MotherRow[] = allSkus
    .filter((s) => s.skuKind === "MOTHER")
    .map((s) => {
      const cold = coldBal.get(s.id) ?? D(0);
      const z = s.zohoItemId ? zohoByItemId.get(s.zohoItemId) : undefined;
      const g = gradeBySku.get(s.id);
      return {
        skuId: s.id,
        code: s.code,
        name: s.name,
        uom: s.uom,
        coldQty: cold.toFixed(3),
        zohoQty: z ? D(String(z.stockOnHand ?? 0)).toFixed(3) : null,
        grade7d: g
          ? {
              a: D(g.a).toFixed(3),
              b: D(g.b).toFixed(3),
              c: D(g.c).toFixed(3),
              waste: D(g.waste).toFixed(3),
            }
          : null,
      };
    })
    // stocked first (by qty desc), then the rest alphabetically
    .sort((a, b) => D(b.coldQty).minus(D(a.coldQty)).toNumber() || a.code.localeCompare(b.code));

  // ---- Finished goods: packs nested under their mother
  const groupsByMother = new Map<number | null, MotherGroup>();
  for (const s of allSkus) {
    if (s.skuKind !== "DERIVATIVE") continue;
    const fg = fgBal.get(s.id) ?? D(0);
    const z = s.zohoItemId ? zohoByItemId.get(s.zohoItemId) : undefined;
    const mother = s.motherSkuId ? skuById.get(s.motherSkuId) : undefined;
    const key = mother?.id ?? null;
    if (!groupsByMother.has(key)) {
      groupsByMother.set(key, {
        motherSkuId: key,
        motherCode: mother?.code ?? "—",
        motherName: mother?.name ?? "No mother SKU",
        packs: [],
        totalUnits: "0",
      });
    }
    groupsByMother.get(key)!.packs.push({
      skuId: s.id,
      code: s.code,
      name: s.name,
      packSize: s.packSizeText,
      channel: s.channel,
      fgQty: fg.toFixed(3),
      zohoQty: z ? D(String(z.stockOnHand ?? 0)).toFixed(3) : null,
    });
  }
  const finished: MotherGroup[] = [...groupsByMother.values()]
    .map((g) => {
      g.packs.sort((a, b) => a.code.localeCompare(b.code));
      g.totalUnits = g.packs.reduce((acc, p) => acc.plus(D(p.fgQty)), D(0)).toFixed(3);
      return g;
    })
    // groups with stock first
    .sort(
      (a, b) =>
        D(b.totalUnits).minus(D(a.totalUnits)).toNumber() ||
        a.motherCode.localeCompare(b.motherCode),
    );

  // ---- Zoho items with no local SKU (full-catalog visibility)
  const linkedItemIds = new Set(allSkus.map((s) => s.zohoItemId).filter(Boolean) as string[]);
  const localNorms = new Set(allSkus.map((s) => normalizeCode(s.code)));
  const zohoOnly: ZohoOnlyRow[] = cache
    .filter(
      (c) =>
        !linkedItemIds.has(c.zohoItemId) &&
        !(c.skuText && localNorms.has(normalizeCode(c.skuText))),
    )
    .map((c) => ({
      zohoItemId: c.zohoItemId,
      name: c.itemName ?? "",
      skuText: c.skuText ?? "",
      stock: D(String(c.stockOnHand ?? 0)).toFixed(3),
    }))
    .sort(
      (a, b) =>
        D(b.stock).minus(D(a.stock)).toNumber() ||
        (motherCore(a.skuText) || a.name).localeCompare(motherCore(b.skuText) || b.name),
    );

  const sumMap = (m: Map<number, ReturnType<typeof D>>) =>
    [...m.values()].reduce((a, v) => a.plus(v), D(0)).toFixed(3);

  return {
    bay,
    mothers,
    finished,
    zohoOnly,
    summary: {
      bayKg: sumMap(bayBal),
      coldKg: sumMap(coldBal),
      packUnits: sumMap(fgBal),
      zohoItemCount: cache.length,
      lastItemSync: lastSync[0]?.finishedAt ? new Date(lastSync[0].finishedAt).toISOString() : null,
    },
  };
}
