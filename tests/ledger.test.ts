import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  applyMovements,
  voidDocumentLedger,
  HardBlockError,
  type Tx,
} from "@/lib/ledger/post";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let locId: number;
let userId: number;
let skuSeq = 0;

const BIZ = "2026-06-18";

async function freshSku(): Promise<number> {
  skuSeq++;
  const code = `TEST${String(skuSeq).padStart(3, "0")}`;
  const [row] = await db
    .insert(schema.skus)
    .values({
      code,
      normalizedCode: code,
      name: `Test ${code}`,
      family: "EAT",
      skuKind: "MOTHER",
      channel: "MOTHER",
      motherCore: code,
      uom: "kg",
    })
    .returning({ id: schema.skus.id });
  return row.id;
}

async function balance(skuId: number): Promise<string> {
  const rows = await db
    .select({ qty: schema.stockBalance.qty })
    .from(schema.stockBalance)
    .where(
      and(
        eq(schema.stockBalance.skuId, skuId),
        eq(schema.stockBalance.locationId, locId),
      ),
    );
  return rows[0]?.qty ?? "0.000";
}

beforeAll(async () => {
  const client = new PGlite(); // in-memory
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  const [loc] = await db
    .insert(schema.locations)
    .values({ code: "COLD_ROOM", name: "CR", kind: "COLD_ROOM" })
    .returning({ id: schema.locations.id });
  locId = loc.id;
  const [u] = await db
    .insert(schema.users)
    .values({ fullName: "Tester", role: "ADMIN", pinHash: "x" })
    .returning({ id: schema.users.id });
  userId = u.id;
});

describe("ledger post-service", () => {
  it("receipt then consume updates balance correctly", async () => {
    const sku = await freshSku();
    await db.transaction(async (tx: Tx) => {
      await applyMovements(
        tx,
        [
          {
            skuId: sku,
            locationId: locId,
            qtySigned: "100",
            uom: "kg",
            movementType: "RECEIPT",
          },
        ],
        { docType: "RECEIVING", docId: 1, businessDate: BIZ, userId },
      );
    });
    expect(await balance(sku)).toBe("100.000");

    await db.transaction(async (tx: Tx) => {
      await applyMovements(
        tx,
        [
          {
            skuId: sku,
            locationId: locId,
            qtySigned: "-80",
            uom: "kg",
            movementType: "ASSEMBLY_CONSUME",
          },
        ],
        { docType: "ASSEMBLY", docId: 2, businessDate: BIZ, userId },
      );
    });
    expect(await balance(sku)).toBe("20.000");
  });

  it("hard-blocks an over-draw and leaves balance unchanged", async () => {
    const sku = await freshSku();
    await db.transaction(async (tx: Tx) => {
      await applyMovements(
        tx,
        [{ skuId: sku, locationId: locId, qtySigned: "10", uom: "kg", movementType: "RECEIPT" }],
        { docType: "RECEIVING", docId: 3, businessDate: BIZ, userId },
      );
    });

    await expect(
      db.transaction(async (tx: Tx) => {
        await applyMovements(
          tx,
          [{ skuId: sku, locationId: locId, qtySigned: "-25", uom: "kg", movementType: "ASSEMBLY_CONSUME" }],
          { docType: "ASSEMBLY", docId: 4, businessDate: BIZ, userId },
        );
      }),
    ).rejects.toBeInstanceOf(HardBlockError);

    expect(await balance(sku)).toBe("10.000"); // rolled back
  });

  it("supervisor-style override (ADJUSTMENT_PLUS) then draw succeeds", async () => {
    const sku = await freshSku();
    await db.transaction(async (tx: Tx) => {
      // override path: top up via adjustment, then draw — ends non-negative
      await applyMovements(
        tx,
        [
          { skuId: sku, locationId: locId, qtySigned: "15", uom: "kg", movementType: "ADJUSTMENT_PLUS", note: "override: physical exists" },
          { skuId: sku, locationId: locId, qtySigned: "-15", uom: "kg", movementType: "ASSEMBLY_CONSUME" },
        ],
        { docType: "INV_ADJUSTMENT", docId: 5, businessDate: BIZ, userId },
      );
    });
    expect(await balance(sku)).toBe("0.000");
  });

  it("void posts exact reversing entries and restores balance", async () => {
    const sku = await freshSku();
    await db.transaction(async (tx: Tx) => {
      await applyMovements(
        tx,
        [{ skuId: sku, locationId: locId, qtySigned: "50", uom: "kg", movementType: "RECEIPT" }],
        { docType: "RECEIVING", docId: 10, businessDate: BIZ, userId },
      );
    });
    expect(await balance(sku)).toBe("50.000");

    await db.transaction(async (tx: Tx) => {
      await voidDocumentLedger(tx, "RECEIVING", 10, {
        userId,
        businessDate: BIZ,
        reason: "entered wrong qty",
      });
    });
    expect(await balance(sku)).toBe("0.000");
  });

  it("refuses to void a receipt whose stock was already consumed", async () => {
    const sku = await freshSku();
    await db.transaction(async (tx: Tx) => {
      await applyMovements(
        tx,
        [{ skuId: sku, locationId: locId, qtySigned: "100", uom: "kg", movementType: "RECEIPT" }],
        { docType: "RECEIVING", docId: 20, businessDate: BIZ, userId },
      );
    });
    await db.transaction(async (tx: Tx) => {
      await applyMovements(
        tx,
        [{ skuId: sku, locationId: locId, qtySigned: "-80", uom: "kg", movementType: "ASSEMBLY_CONSUME" }],
        { docType: "ASSEMBLY", docId: 21, businessDate: BIZ, userId },
      );
    });
    // balance is 20; reversing the +100 receipt would make it -80 → blocked
    await expect(
      db.transaction(async (tx: Tx) => {
        await voidDocumentLedger(tx, "RECEIVING", 20, {
          userId,
          businessDate: BIZ,
          reason: "too late",
        });
      }),
    ).rejects.toBeInstanceOf(HardBlockError);
    expect(await balance(sku)).toBe("20.000"); // unchanged
  });

  it("reconcile: ledger sum equals cached balance", async () => {
    const res = await db.execute(sql`
      SELECT b.sku_id, b.qty AS bal, COALESCE(l.s,0) AS led
      FROM stock_balance b
      LEFT JOIN (SELECT sku_id, location_id, SUM(qty_signed) s FROM stock_ledger GROUP BY 1,2) l
        ON l.sku_id=b.sku_id AND l.location_id=b.location_id
      WHERE b.qty <> COALESCE(l.s,0)
    `);
    const rows = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
    expect((rows as unknown[]).length).toBe(0);
  });
});

describe("schema guarantees", () => {
  it("computes qty_waste = sorted - (a+b+c)", async () => {
    const sku = await freshSku();
    const [doc] = await db
      .insert(schema.sortingDoc)
      .values({ businessDate: BIZ, createdByUserId: userId })
      .returning({ id: schema.sortingDoc.id });
    await db.insert(schema.sortingLine).values({
      docId: doc.id,
      skuId: sku,
      sortedQty: "80",
      qtyA: "60",
      qtyB: "12",
      qtyC: "5",
    });
    const [line] = await db
      .select({ w: schema.sortingLine.qtyWaste })
      .from(schema.sortingLine)
      .where(eq(schema.sortingLine.docId, doc.id));
    expect(line.w).toBe("3.000"); // 80 - 77
  });

  it("stock_ledger is append-only (UPDATE blocked by trigger)", async () => {
    const sku = await freshSku();
    await db.transaction(async (tx: Tx) => {
      await applyMovements(
        tx,
        [{ skuId: sku, locationId: locId, qtySigned: "5", uom: "kg", movementType: "RECEIPT" }],
        { docType: "RECEIVING", docId: 30, businessDate: BIZ, userId },
      );
    });
    // A syntactically-valid UPDATE only fails because the append-only trigger
    // raises. (Reason text lives in PGlite's error.cause; the rejection is proof.)
    await expect(
      db.execute(sql`UPDATE stock_ledger SET note = 'hack' WHERE doc_id = 30`),
    ).rejects.toThrow();
  });
});
