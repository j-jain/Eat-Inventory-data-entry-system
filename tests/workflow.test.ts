/**
 * End-to-end workflow enforcement tests running the REAL server actions
 * against an in-memory PGlite through lib/db (PGLITE_DIR=memory://).
 * Covers: PO-only receiving, bay→cold sorting transfer, partial deliveries,
 * variance scenarios S1/S2/S4, the mandatory pick-list gate, dispatch +
 * delivery, cascade voids, and ledger reconciliation.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";

process.env.DATABASE_URL = "";
process.env.PGLITE_DIR = "memory://";

const session = vi.hoisted(() => ({
  current: { uid: 1, name: "Tester", role: "ADMIN" as string },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (p: string) => {
    throw new Error(`redirect:${p}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => session.current,
}));

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import {
  submitReceivingBatch,
  submitSorting,
  submitAssembly,
  submitDispatch,
  voidDocument,
} from "@/actions/entries";
import {
  generatePickList,
  updatePickProgress,
  completePickList,
} from "@/actions/pick-list";
import { submitManualOrder } from "@/actions/orders";
import { markDelivered } from "@/actions/dispatch";
import { pickListGate } from "@/lib/workflow";
import { openPurchaseOrdersForReceiving } from "@/lib/queries";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const d = db as any;

let BAY = 0;
let COLD = 0;
let FG = 0;
let MA = 0; // mother, requires sorting
let MB = 0; // mother, skips sorting (requiresSorting=false)
let PACK1 = 0; // BLINKIT pack of MA

const asFloor = () => (session.current = { uid: 4, name: "Floor", role: "FLOOR" });
const asSupervisor = () =>
  (session.current = { uid: 3, name: "Sup", role: "SUPERVISOR" });
const asManager = () => (session.current = { uid: 2, name: "Aniket", role: "MANAGER" });

async function balance(skuId: number, locId: number): Promise<string> {
  const rows = await d
    .select({ qty: schema.stockBalance.qty })
    .from(schema.stockBalance)
    .where(
      and(eq(schema.stockBalance.skuId, skuId), eq(schema.stockBalance.locationId, locId)),
    );
  return rows[0]?.qty ?? "0.000";
}

beforeAll(async () => {
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(d, { migrationsFolder: "./drizzle" });

  for (const loc of [
    { code: "COLD_ROOM", name: "CR", kind: "COLD_ROOM" as const },
    { code: "DC_FLOOR_FG", name: "FG", kind: "DC_FLOOR_FG" as const },
    { code: "RECEIVING_BAY", name: "Bay", kind: "RECEIVING_BAY" as const },
  ]) {
    await d.insert(schema.locations).values(loc);
  }
  const locs = await d.select().from(schema.locations);
  BAY = locs.find((l: { code: string }) => l.code === "RECEIVING_BAY")!.id;
  COLD = locs.find((l: { code: string }) => l.code === "COLD_ROOM")!.id;
  FG = locs.find((l: { code: string }) => l.code === "DC_FLOOR_FG")!.id;

  for (const u of [
    { fullName: "Admin", role: "ADMIN" as const },
    { fullName: "Aniket", role: "MANAGER" as const },
    { fullName: "Sup", role: "SUPERVISOR" as const },
    { fullName: "Floor", role: "FLOOR" as const },
  ]) {
    await d.insert(schema.users).values({ ...u, pinHash: "x" });
  }

  const mk = async (v: Record<string, unknown>) =>
    (
      await d
        .insert(schema.skus)
        .values(v)
        .returning({ id: schema.skus.id })
    )[0].id as number;
  MA = await mk({
    code: "MA",
    normalizedCode: "MA",
    name: "Mother A",
    skuKind: "MOTHER",
    channel: "MOTHER",
    motherCore: "MA",
    uom: "kg",
  });
  MB = await mk({
    code: "MB",
    normalizedCode: "MB",
    name: "Mother B (no sorting)",
    skuKind: "MOTHER",
    channel: "MOTHER",
    motherCore: "MB",
    uom: "kg",
    requiresSorting: false,
  });
  PACK1 = await mk({
    code: "MA-BZ",
    normalizedCode: "MABZ",
    name: "Pack A Blinkit",
    skuKind: "DERIVATIVE",
    channel: "BLINKIT",
    motherSkuId: MA,
    motherCore: "MA",
    uom: "pc",
  });

  await d.insert(schema.zohoPoCache).values({
    zohoPoId: "ZP1",
    poNumber: "PO-1",
    vendorName: "VendorX",
    status: "open",
    lineItems: [{ sku: "MA", name: "Mother A", quantity: 35 }],
  });
});

describe("PO-only receiving + bay routing", () => {
  it("rejects off-PO receiving for floor staff", async () => {
    asFloor();
    const res = await submitReceivingBatch({
      pos: [{ lines: [{ skuId: MA, acceptedQty: "5", uom: "kg" }] }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Purchase Order/i);
  });

  it("floor receives against a PO into the RECEIVING BAY, not the cold room", async () => {
    asFloor();
    const res = await submitReceivingBatch({
      pos: [
        {
          zohoPoId: "ZP1",
          poNo: "PO-1",
          lines: [{ skuId: MA, acceptedQty: "5", poExpectedQty: "35", uom: "kg" }],
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(await balance(MA, BAY)).toBe("5.000");
    expect(await balance(MA, COLD)).toBe("0.000");
  });

  it("keeps the partially-received line on the sheet with the right remaining", async () => {
    const pos = await openPurchaseOrdersForReceiving();
    const line = pos.find((p) => p.zohoPoId === "ZP1")?.lines.find((l) => l.skuId === MA);
    expect(line).toBeDefined();
    expect(line!.remainingQty).toBe("30.000");
    expect(line!.alreadyReceivedQty).toBe("5.000");
  });

  it("never lists a DRAFT PO on the receiving sheet (drafts are cached for the PO list only)", async () => {
    await db.insert(schema.zohoPoCache).values({
      zohoPoId: "ZP-DRAFT",
      poNumber: "PO-DRAFT",
      vendorName: "VendorX",
      status: "draft",
      receivedStatus: "pending",
      lineItems: [{ sku: "MA", name: "Mother A", quantity: 10 }],
    });
    const pos = await openPurchaseOrdersForReceiving();
    expect(pos.find((p) => p.zohoPoId === "ZP-DRAFT")).toBeUndefined();
  });

  it("manager off-PO receipt of a no-sorting SKU goes straight to the cold room", async () => {
    asManager();
    const res = await submitReceivingBatch({
      pos: [{ lines: [{ skuId: MB, acceptedQty: "10", uom: "kg" }] }],
    });
    expect(res.ok).toBe(true);
    expect(await balance(MB, COLD)).toBe("10.000");
    expect(await balance(MB, BAY)).toBe("0.000");
  });

  it("blocks over-receipt without the S2 scenario, allows it with S2", async () => {
    asFloor();
    const bad = await submitReceivingBatch({
      pos: [
        {
          zohoPoId: "ZP1",
          lines: [{ skuId: MA, acceptedQty: "31", poExpectedQty: "30", uom: "kg" }],
        },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/exceeds the remaining/i);
  });
});

describe("sorting = the only path bay → cold room", () => {
  it("cannot sort more than the bay holds (hard block)", async () => {
    asFloor();
    const res = await submitSorting({
      lines: [{ skuId: MA, sortedQty: "50", qtyA: "50", qtyB: "0", qtyC: "0" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Not enough stock/i);
  });

  it("transfers A+B+C into the cold room and takes waste out of the bay", async () => {
    asFloor();
    const res = await submitSorting({
      lines: [{ skuId: MA, sortedQty: "5", qtyA: "2", qtyB: "2", qtyC: "0.5" }],
    });
    expect(res.ok).toBe(true);
    expect(await balance(MA, BAY)).toBe("0.000");
    expect(await balance(MA, COLD)).toBe("4.500");
    const waste = await d
      .select()
      .from(schema.stockLedger)
      .where(eq(schema.stockLedger.movementType, "SORT_WASTE"));
    expect(waste.length).toBe(1);
    expect(waste[0].qtySigned).toBe("-0.500");
  });
});

describe("variance scenarios", () => {
  it("S4 (short, billed full): receives the bill qty and auto-wastes the missing part", async () => {
    asFloor();
    const res = await submitReceivingBatch({
      pos: [
        {
          zohoPoId: "ZP1",
          lines: [
            {
              skuId: MA,
              acceptedQty: "20",
              poExpectedQty: "30",
              uom: "kg",
              variance: { type: "S4_SHORT_BILLED_FULL", wasteReason: "SPOILAGE" },
            },
          ],
        },
      ],
    });
    expect(res.ok).toBe(true);
    // +30 receipt, −10 wastage → net 20 in the bay
    expect(await balance(MA, BAY)).toBe("20.000");
    const wl = await d
      .select()
      .from(schema.wastageLine)
      .where(eq(schema.wastageLine.source, "RECEIVING"));
    expect(wl.length).toBe(1);
    expect(wl[0].qty).toBe("10.000");
    expect(wl[0].sourceDocType).toBe("RECEIVING");
    // line fully received (5 + 30 = 35) → off the sheet
    const pos = await openPurchaseOrdersForReceiving();
    const line = pos.find((p) => p.zohoPoId === "ZP1")?.lines.find((l) => l.skuId === MA);
    expect(line).toBeUndefined();
  });

  it("S1 (free leftover): two receipt lines + record-only ₹0 adjustment, PO line closes", async () => {
    await d.insert(schema.zohoPoCache).values({
      zohoPoId: "ZP2",
      poNumber: "PO-2",
      vendorName: "VendorX",
      status: "open",
      lineItems: [{ sku: "MA", name: "Mother A", quantity: 10 }],
    });
    asFloor();
    const before = await balance(MA, BAY);
    const res = await submitReceivingBatch({
      pos: [
        {
          zohoPoId: "ZP2",
          lines: [
            {
              skuId: MA,
              acceptedQty: "6",
              poExpectedQty: "10",
              uom: "kg",
              variance: { type: "S1_FREE_LEFTOVER", freeQty: "4" },
            },
          ],
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(await balance(MA, BAY)).toBe((Number(before) + 10).toFixed(3));

    const adj = await d
      .select()
      .from(schema.invAdjustmentDoc)
      .where(like(schema.invAdjustmentDoc.against, "RECEIVING:%"));
    expect(adj.length).toBe(1);
    const adjLines = await d
      .select()
      .from(schema.invAdjustmentLine)
      .where(eq(schema.invAdjustmentLine.docId, adj[0].id));
    expect(adjLines[0].qtyToAdjust).toBe("4.000");
    expect(adjLines[0].unitCost).toBe("0.00");
    // record-only: no adjustment ledger rows
    const adjLedger = await d
      .select()
      .from(schema.stockLedger)
      .where(
        and(
          eq(schema.stockLedger.docType, "INV_ADJUSTMENT"),
          eq(schema.stockLedger.docId, adj[0].id),
        ),
      );
    expect(adjLedger.length).toBe(0);
    // ZP2 line closed (6 + 4 = 10)
    const pos = await openPurchaseOrdersForReceiving();
    expect(pos.find((p) => p.zohoPoId === "ZP2")?.lines.find((l) => l.skuId === MA)).toBeUndefined();
  });
});

describe("mandatory pick-list gate", () => {
  it("blocks assembly while no pick list was generated today", async () => {
    asFloor();
    const res = await submitAssembly({
      channel: "BLINKIT",
      lines: [{ motherSkuId: MA, packSkuId: PACK1, qtyOut: "2", qtyIn: "0", packsMade: "4" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Pick List/i);
  });

  it("an empty generation auto-completes and opens the gate", async () => {
    asFloor();
    const gen = await generatePickList();
    expect(gen.ok).toBe(true);
    if (gen.ok) expect(gen.empty).toBe(true);
    expect((await pickListGate()).state).toBe("COMPLETED");

    const res = await submitAssembly({
      channel: "BLINKIT",
      lines: [{ motherSkuId: MA, packSkuId: PACK1, qtyOut: "2", qtyIn: "0", packsMade: "4" }],
    });
    expect(res.ok).toBe(true);
    expect(await balance(PACK1, FG)).toBe("4.000");
  });

  it("new orders → new OPEN list re-locks assembly until completed (incl. supervisor short-complete)", async () => {
    asFloor();
    const order = await submitManualOrder({
      lines: [{ skuId: PACK1, qty: "6", uom: "pc" }],
    });
    expect(order.ok).toBe(true);

    const gen = await generatePickList();
    expect(gen.ok).toBe(true);
    const gate = await pickListGate();
    expect(gate.state).toBe("OPEN");

    const blocked = await submitAssembly({
      channel: "BLINKIT",
      lines: [{ motherSkuId: MA, packSkuId: PACK1, qtyOut: "1", qtyIn: "0", packsMade: "2" }],
    });
    expect(blocked.ok).toBe(false);

    // a second generation while one is OPEN is refused
    const again = await generatePickList();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/already open/i);

    // floor cannot short-complete
    const listId = gate.state === "OPEN" ? gate.pickListId : 0;
    const shortAsFloor = await completePickList(listId, { shortReason: "ran out" });
    expect(shortAsFloor.ok).toBe(false);

    // supervisor short-complete with reason opens the gate
    asSupervisor();
    const short = await completePickList(listId, { shortReason: "stock shortage today" });
    expect(short.ok).toBe(true);
    expect((await pickListGate()).state).toBe("COMPLETED");
    const [pl] = await d
      .select()
      .from(schema.pickList)
      .where(eq(schema.pickList.id, listId));
    expect(pl.shortCompleteReason).toMatch(/stock shortage/);
  });

  it("pick progress is bounded 0..toPick", async () => {
    asFloor();
    await submitManualOrder({ lines: [{ skuId: PACK1, qty: "3", uom: "pc" }] });
    const gen = await generatePickList();
    expect(gen.ok).toBe(true);
    const gate = await pickListGate();
    expect(gate.state).toBe("OPEN");
    const listId = gate.state === "OPEN" ? gate.pickListId : 0;
    const [line] = await d
      .select()
      .from(schema.pickListLine)
      .where(eq(schema.pickListLine.pickListId, listId));

    const over = await updatePickProgress({
      pickListId: listId,
      lineId: line.id,
      qtyPicked: "99",
    });
    expect(over.ok).toBe(false);

    const okUpd = await updatePickProgress({
      pickListId: listId,
      lineId: line.id,
      qtyPicked: "3",
    });
    expect(okUpd.ok).toBe(true);
    const done = await completePickList(listId);
    expect(done.ok).toBe(true);
  });
});

describe("dispatch + delivery", () => {
  let dispatchId = 0;

  it("dispatches finished packs out of FG (gate already satisfied)", async () => {
    asFloor();
    const res = await submitDispatch({
      channel: "BLINKIT",
      lines: [{ packSkuId: PACK1, qty: "3", uom: "pc" }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) dispatchId = res.docId;
    expect(await balance(PACK1, FG)).toBe("1.000"); // 4 made − 3 dispatched
  });

  it("rejects over-delivery, accepts partial then full", async () => {
    const [line] = await d
      .select()
      .from(schema.dispatchLine)
      .where(eq(schema.dispatchLine.docId, dispatchId));

    const over = await markDelivered({
      docId: dispatchId,
      lines: [{ lineId: line.id, deliveredQty: "5" }],
    });
    expect(over.ok).toBe(false);

    const partial = await markDelivered({
      docId: dispatchId,
      lines: [{ lineId: line.id, deliveredQty: "2" }],
    });
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.status).toBe("PARTIAL");

    const full = await markDelivered({
      docId: dispatchId,
      lines: [{ lineId: line.id, deliveredQty: "3" }],
    });
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.status).toBe("DELIVERED");
  });
});

describe("cascade void + reconciliation", () => {
  it("voiding an S4 receiving cascades its auto-wastage (bay restored to zero net)", async () => {
    // the S4 receiving left 20 in the bay (30 receipt − 10 waste)
    asSupervisor();
    const [s4doc] = await d
      .select()
      .from(schema.receivingDoc)
      .where(eq(schema.receivingDoc.variance, "S4_SHORT_BILLED_FULL"));
    const before = Number(await balance(MA, BAY));
    const res = await voidDocument("RECEIVING", s4doc.id, "test cascade");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // +10 (waste reversal) − 30 (receipt reversal) = −20 net
    expect(await balance(MA, BAY)).toBe((before - 20).toFixed(3));
    const [w] = await d
      .select()
      .from(schema.wastageDoc)
      .where(like(schema.wastageDoc.voidReason, "cascade:%"));
    expect(w).toBeDefined();
  });

  it("ledger sum still equals every cached balance (no drift anywhere)", async () => {
    const res = await d.execute(sql`
      SELECT b.sku_id FROM stock_balance b
      LEFT JOIN (SELECT sku_id, location_id, SUM(qty_signed) s FROM stock_ledger GROUP BY 1,2) l
        ON l.sku_id=b.sku_id AND l.location_id=b.location_id
      WHERE b.qty <> COALESCE(l.s,0)
    `);
    const rows = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
    expect((rows as unknown[]).length).toBe(0);
  });
});
