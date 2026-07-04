/**
 * Dev/preview-only seed: a fake open Zoho PO + sales order so the receiving
 * sheet and pick list have data without touching Zoho. PGlite only — refuses
 * to run when DATABASE_URL is set. Run: npx tsx scripts/preview-seed.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

async function main() {
  if (process.env.DATABASE_URL) {
    console.error("refusing: DATABASE_URL is set (this seed is PGlite-only)");
    process.exit(1);
  }
  const { db } = await import("../lib/db");
  const schema = await import("../lib/db/schema");
  const { eq, inArray } = await import("drizzle-orm");

  // two real mother SKUs + one pack for a plausible demo
  const skus = await db
    .select({ id: schema.skus.id, code: schema.skus.code, kind: schema.skus.skuKind })
    .from(schema.skus)
    .where(inArray(schema.skus.code, ["EAT001", "EAT002", "EAT001-BZ", "EAT002-BZ"]));
  const mothers = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name })
    .from(schema.skus)
    .where(eq(schema.skus.skuKind, "MOTHER"))
    .limit(2);
  const packs = await db
    .select({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name })
    .from(schema.skus)
    .where(eq(schema.skus.channel, "BLINKIT"))
    .limit(2);
  void skus;
  if (mothers.length < 2 || packs.length < 1) {
    console.error("need seeded SKUs first (npm run db:seed)");
    process.exit(1);
  }

  await db
    .insert(schema.zohoPoCache)
    .values({
      zohoPoId: "PREVIEW-PO-1",
      poNumber: "PO-PREVIEW-1",
      vendorName: "Demo Vendor (preview)",
      status: "open",
      poDate: new Date().toISOString().slice(0, 10),
      lineItems: [
        { sku: mothers[0].code, name: mothers[0].name, quantity: 50 },
        { sku: mothers[1].code, name: mothers[1].name, quantity: 35 },
      ],
    })
    .onConflictDoNothing({ target: schema.zohoPoCache.zohoPoId });

  await db
    .insert(schema.zohoSoCache)
    .values({
      zohoSoId: "PREVIEW-SO-1",
      soNumber: "SO-PREVIEW-1",
      customerName: "Demo Customer (preview)",
      status: "confirmed",
      soDate: new Date().toISOString().slice(0, 10),
      lineItems: [{ sku: packs[0].code, name: packs[0].name, quantity: 12 }],
    })
    .onConflictDoNothing({ target: schema.zohoSoCache.zohoSoId });

  console.log(
    `✓ preview data: PO PREVIEW-PO-1 (${mothers[0].code} 50, ${mothers[1].code} 35), SO PREVIEW-SO-1 (${packs[0].code} ×12)`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
