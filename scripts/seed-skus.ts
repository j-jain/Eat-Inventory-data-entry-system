/**
 * Seed SKUs + locations.
 *   master  = eat-os export (scripts/data/eat_os_skus.json)
 *   overlay = the 7 paper sheets (scripts/sheet-skus.ts) — WINS on channel + pack
 * Re-runnable (upsert on normalized_code). Run: npx tsx scripts/seed-skus.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { readFileSync } from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import {
  normalizeCode,
  motherCore,
  deriveChannel,
  parsePackSize,
  mapUom,
  type Channel,
} from "../lib/sku";
import { SHEET_SKUS } from "./sheet-skus";

type EatOsSku = {
  code: string;
  name: string;
  family: string;
  sku_kind: string; // BASE | DERIVATIVE
  pack_variant: string | null;
  mother_code: string | null;
  unit: string | null;
  pack_g: string | null;
  category: string | null;
  shelf_life_days: number | null;
  is_active: boolean;
};

type Row = {
  code: string;
  normalizedCode: string;
  name: string;
  family: string;
  skuKind: "MOTHER" | "DERIVATIVE";
  channel: Channel;
  motherCore: string;
  packSizeText: string | null;
  packGMin: string | null;
  packGMax: string | null;
  packPieces: string | null;
  uom: ReturnType<typeof mapUom>;
  category: string;
  shelfLifeDays: number | null;
  source: string;
  isActive: boolean;
};

async function main() {
  const { db } = await import("../lib/db");
  const schema = await import("../lib/db/schema");

  // 1. locations
  const { LOCATIONS } = await import("../lib/constants");
  for (const loc of LOCATIONS) {
    await db.insert(schema.locations).values(loc).onConflictDoNothing({
      target: schema.locations.code,
    });
  }

  // 2. master from eat-os
  const jsonPath = path.join(process.cwd(), "scripts", "data", "eat_os_skus.json");
  const eatOs: EatOsSku[] = JSON.parse(readFileSync(jsonPath, "utf-8"));

  const byNorm = new Map<string, Row>();
  for (const r of eatOs) {
    const isMother = r.sku_kind === "BASE";
    const norm = normalizeCode(r.code);
    byNorm.set(norm, {
      code: r.code.trim(),
      normalizedCode: norm,
      name: r.name,
      family: r.family || "EAT",
      skuKind: isMother ? "MOTHER" : "DERIVATIVE",
      channel: deriveChannel(r.code, isMother),
      motherCore: motherCore(r.code),
      packSizeText: null,
      packGMin: null,
      packGMax: null,
      packPieces: null,
      uom: mapUom(r.unit),
      category: r.category || "",
      shelfLifeDays: r.shelf_life_days ?? null,
      source: "ZOHO",
      isActive: !!r.is_active,
    });
  }

  // 3. overlay (sheets win)
  for (const s of SHEET_SKUS) {
    const norm = normalizeCode(s.code);
    const pack = parsePackSize(s.packText);
    const ex = byNorm.get(norm);
    if (ex) {
      ex.channel = s.channel;
      ex.skuKind = "DERIVATIVE";
      ex.packSizeText = s.packText;
      ex.packGMin = pack.packGMin;
      ex.packGMax = pack.packGMax;
      ex.packPieces = pack.packPieces;
      ex.isActive = true;
      ex.motherCore = motherCore(s.code);
    } else {
      byNorm.set(norm, {
        code: norm,
        normalizedCode: norm,
        name: s.name,
        family: norm.slice(0, norm.match(/^[A-Z]+/)?.[0].length ?? 3),
        skuKind: "DERIVATIVE",
        channel: s.channel,
        motherCore: motherCore(s.code),
        packSizeText: s.packText,
        packGMin: pack.packGMin,
        packGMax: pack.packGMax,
        packPieces: pack.packPieces,
        uom: s.channel === "BULK_FRUIT" ? "box" : "pc",
        category: "",
        shelfLifeDays: null,
        source: "LOCAL",
        isActive: true,
      });
    }
  }

  // 4. ensure every derivative's mother core exists as a MOTHER sku
  for (const row of [...byNorm.values()]) {
    if (row.skuKind === "DERIVATIVE" && !byNorm.has(row.motherCore)) {
      const fam = row.motherCore.match(/^[A-Z]+/)?.[0] ?? "EAT";
      byNorm.set(row.motherCore, {
        code: row.motherCore,
        normalizedCode: row.motherCore,
        name: row.name.replace(/\s*pack.*/i, "").replace(/\s*-?\s*B[ZF]?$/i, "").trim() || row.motherCore,
        family: fam,
        skuKind: "MOTHER",
        channel: "MOTHER",
        motherCore: row.motherCore,
        packSizeText: null,
        packGMin: null,
        packGMax: null,
        packPieces: null,
        uom: "kg",
        category: "",
        shelfLifeDays: null,
        source: "LOCAL",
        isActive: true,
      });
    }
  }

  // 5. upsert all
  const rows = [...byNorm.values()];
  for (const r of rows) {
    await db
      .insert(schema.skus)
      .values({
        code: r.code,
        normalizedCode: r.normalizedCode,
        name: r.name,
        family: r.family,
        skuKind: r.skuKind,
        channel: r.channel,
        motherCore: r.motherCore,
        packSizeText: r.packSizeText,
        packGMin: r.packGMin,
        packGMax: r.packGMax,
        packPieces: r.packPieces,
        uom: r.uom,
        category: r.category,
        shelfLifeDays: r.shelfLifeDays,
        source: r.source,
        isActive: r.isActive,
      })
      .onConflictDoUpdate({
        target: schema.skus.normalizedCode,
        set: {
          name: sql`excluded.name`,
          channel: sql`excluded.channel`,
          skuKind: sql`excluded.sku_kind`,
          packSizeText: sql`excluded.pack_size_text`,
          packGMin: sql`excluded.pack_g_min`,
          packGMax: sql`excluded.pack_g_max`,
          packPieces: sql`excluded.pack_pieces`,
          uom: sql`excluded.uom`,
          isActive: sql`excluded.is_active`,
        },
      });
  }

  // 6. link mother ids
  const all = await db
    .select({
      id: schema.skus.id,
      normalizedCode: schema.skus.normalizedCode,
      skuKind: schema.skus.skuKind,
      motherCore: schema.skus.motherCore,
    })
    .from(schema.skus);
  const idByNorm = new Map(all.map((x) => [x.normalizedCode, x.id]));
  let linked = 0;
  for (const s of all) {
    if (s.skuKind === "DERIVATIVE") {
      const mid = idByNorm.get(s.motherCore);
      if (mid && mid !== s.id) {
        await db
          .update(schema.skus)
          .set({ motherSkuId: mid })
          .where(sql`${schema.skus.id} = ${s.id}`);
        linked++;
      }
    }
  }

  const motherCount = rows.filter((r) => r.skuKind === "MOTHER").length;
  const derivCount = rows.filter((r) => r.skuKind === "DERIVATIVE").length;
  console.log(
    `✓ seeded ${rows.length} skus (${motherCount} mother, ${derivCount} derivative), linked ${linked} mothers; ${LOCATIONS.length} locations`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
