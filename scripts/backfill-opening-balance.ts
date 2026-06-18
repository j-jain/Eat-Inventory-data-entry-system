/**
 * Seed opening balances from the latest Zoho stock-on-hand (run AFTER a Zoho
 * item sync). Mother SKUs → Cold Room, pack SKUs → Finished Goods.
 * Idempotent: the uq_ledger_one_opening index prevents double-seeding.
 * Run: npx tsx scripts/backfill-opening-balance.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { and, eq, sql } from "drizzle-orm";

function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

async function main() {
  const { db } = await import("../lib/db");
  const schema = await import("../lib/db/schema");
  const { applyMovements } = await import("../lib/ledger/post");
  const { locationId } = await import("../lib/locations");

  const admin = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, "ADMIN"))
    .limit(1);
  if (!admin[0]) {
    console.error("No ADMIN user — run seed-users first.");
    process.exit(1);
  }
  const userId = admin[0].id;
  const cr = await locationId("COLD_ROOM");
  const fg = await locationId("DC_FLOOR_FG");

  const rows = await db
    .select({
      skuId: schema.skus.id,
      kind: schema.skus.skuKind,
      uom: schema.skus.uom,
      stock: schema.zohoItemCache.stockOnHand,
    })
    .from(schema.zohoItemCache)
    .innerJoin(schema.skus, eq(schema.skus.zohoItemId, schema.zohoItemCache.zohoItemId))
    .where(sql`${schema.zohoItemCache.stockOnHand} > 0`);

  if (rows.length === 0) {
    console.log("No Zoho stock to seed (sync items first, or Zoho not configured).");
    process.exit(0);
  }

  const [doc] = await db
    .insert(schema.openingDoc)
    .values({ businessDate: istToday(), createdByUserId: userId, note: "opening backfill" })
    .returning({ id: schema.openingDoc.id });

  let count = 0;
  for (const r of rows) {
    const loc = r.kind === "MOTHER" ? cr : fg;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.transaction(async (tx: any) => {
        await applyMovements(
          tx,
          [
            {
              skuId: r.skuId,
              locationId: loc,
              qtySigned: String(r.stock),
              uom: r.uom,
              movementType: "OPENING_BALANCE",
            },
          ],
          { docType: "OPENING", docId: doc.id, businessDate: istToday(), userId },
        );
      });
      count++;
    } catch {
      /* already seeded for this key — skip */
    }
  }
  console.log(`✓ opening balance seeded for ${count}/${rows.length} skus`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
