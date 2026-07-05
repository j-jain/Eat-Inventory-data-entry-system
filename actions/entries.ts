"use server";

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  skus,
  receivingDoc,
  receivingLine,
  sortingDoc,
  sortingLine,
  assemblyDoc,
  assemblyLine,
  wastageDoc,
  wastageLine,
  returnDoc,
  returnLine,
  invAdjustmentDoc,
  invAdjustmentLine,
  dispatchDoc,
  dispatchLine,
  zohoPush,
  appAuditLog,
} from "@/lib/db/schema";
import {
  applyMovements,
  voidDocumentLedger,
  HardBlockError,
  type MovementInput,
  type Tx,
  type Uom,
} from "@/lib/ledger/post";
import { requireUser, requireSupervisor, requireManager, hasRole } from "@/lib/auth/rbac";
import { locationId } from "@/lib/locations";
import { COLD_ROOM, DC_FLOOR_FG, RECEIVING_BAY } from "@/lib/constants";
import { assertPickListComplete } from "@/lib/workflow";
import { sub, qtyStr, gt, gte, lt, sumQty, isZero } from "@/lib/money";

export type ActionResult =
  | { ok: true; docId: number; count?: number }
  | { ok: false; error: string };

function istToday(): string {
  // 'YYYY-MM-DD' in Asia/Kolkata
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function fail(e: unknown): ActionResult {
  if (e instanceof HardBlockError) {
    return {
      ok: false,
      error: `Not enough stock: only ${e.available} available, you tried to use ${e.requested}. Fix with a receiving/adjustment first (or ask a supervisor to override).`,
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { ok: false, error: msg };
}

const qtyField = z
  .union([z.string(), z.number()])
  .transform((v) => qtyStr(v))
  .refine((v) => !Number.isNaN(Number(v)), "invalid number");

const baseHeader = z.object({
  businessDate: z.string().optional(),
  clientToken: z.string().min(8).optional(),
  note: z.string().optional(),
});

/* ------------------------------------------------------- shared helpers */

/**
 * Where a SKU's receipts land: the Receiving Bay if it must be sorted first
 * (the structural workflow gate), else straight into the Cold Room.
 */
async function receiptDestinations(
  tx: Tx,
  skuIds: number[],
): Promise<Map<number, boolean>> {
  if (!skuIds.length) return new Map();
  const rows = await tx
    .select({ id: skus.id, requiresSorting: skus.requiresSorting })
    .from(skus)
    .where(inArray(skus.id, skuIds));
  return new Map(rows.map((r: { id: number; requiresSorting: boolean }) => [r.id, r.requiresSorting]));
}

type TxWastageLine = {
  skuId: number;
  locationId: number;
  qty: string;
  uom: Uom;
  reason: string;
  source: "RECEIVING" | "SORTING" | "REGRADE" | "ASSEMBLY" | "RETURN" | "EXPIRY" | "GENERAL";
  sourceDocType?: "RECEIVING" | "ASSEMBLY";
  sourceDocId?: number;
};

/**
 * Create a POSTED wastage doc inside an existing transaction (used by the
 * receiving S4 flow and assembly waste). `postMovements=false` records the
 * waste without touching stock (when another document already carried the
 * stock effect, e.g. assembly consume).
 */
async function createWastageDocInTx(
  tx: Tx,
  args: {
    userId: number;
    businessDate: string;
    note?: string;
    lines: TxWastageLine[];
    postMovements: boolean;
  },
): Promise<number> {
  const [doc] = await tx
    .insert(wastageDoc)
    .values({
      businessDate: args.businessDate,
      note: args.note,
      createdByUserId: args.userId,
    })
    .returning({ id: wastageDoc.id });

  const movements: MovementInput[] = [];
  for (const ln of args.lines) {
    const [line] = await tx
      .insert(wastageLine)
      .values({
        docId: doc.id,
        skuId: ln.skuId,
        locationId: ln.locationId,
        qty: ln.qty,
        uom: ln.uom,
        reason: ln.reason,
        source: ln.source,
        sourceDocType: ln.sourceDocType ?? null,
        sourceDocId: ln.sourceDocId ?? null,
      })
      .returning({ id: wastageLine.id });
    if (args.postMovements) {
      movements.push({
        skuId: ln.skuId,
        locationId: ln.locationId,
        qtySigned: qtyStr(sub(0, ln.qty)),
        uom: ln.uom,
        movementType: "WASTAGE",
        docLineId: line.id,
        note: ln.reason,
      });
    }
  }
  if (movements.length)
    await applyMovements(tx, movements, {
      docType: "WASTAGE",
      docId: doc.id,
      businessDate: args.businessDate,
      userId: args.userId,
    });
  await tx
    .update(wastageDoc)
    .set({ docStatus: "POSTED" })
    .where(eq(wastageDoc.id, doc.id));
  return doc.id as number;
}

type TxAdjustmentLine = {
  skuId: number;
  locationId: number;
  qtyAsPerPo?: string;
  actualReceived?: string;
  qtyAsPerBill?: string;
  qtyToAdjust: string;
  unitCost?: string;
  reason: string;
};

/**
 * Create a POSTED TIE_OUT adjustment doc inside an existing transaction.
 * `against` back-links the causing document (e.g. "RECEIVING:123") so voids
 * can cascade. `postMovements=false` = record-only (the stock effect already
 * lives on another doc's ledger rows).
 */
async function createAdjustmentDocInTx(
  tx: Tx,
  args: {
    userId: number;
    businessDate: string;
    against: string;
    note?: string;
    lines: TxAdjustmentLine[];
    postMovements: boolean;
  },
): Promise<number> {
  const [doc] = await tx
    .insert(invAdjustmentDoc)
    .values({
      against: args.against,
      businessDate: args.businessDate,
      note: args.note,
      createdByUserId: args.userId,
    })
    .returning({ id: invAdjustmentDoc.id });

  const movements: MovementInput[] = [];
  for (const ln of args.lines) {
    const [line] = await tx
      .insert(invAdjustmentLine)
      .values({
        docId: doc.id,
        skuId: ln.skuId,
        locationId: ln.locationId,
        qtyAsPerPo: ln.qtyAsPerPo ?? null,
        actualReceived: ln.actualReceived ?? null,
        qtyAsPerBill: ln.qtyAsPerBill ?? null,
        qtyToAdjust: ln.qtyToAdjust,
        adjKind: "TIE_OUT",
        unitCost: ln.unitCost ?? "0",
        reason: ln.reason,
      })
      .returning({ id: invAdjustmentLine.id });
    if (args.postMovements && !isZero(ln.qtyToAdjust)) {
      movements.push({
        skuId: ln.skuId,
        locationId: ln.locationId,
        qtySigned: ln.qtyToAdjust,
        uom: "kg",
        movementType: gt(ln.qtyToAdjust, 0) ? "ADJUSTMENT_PLUS" : "ADJUSTMENT_MINUS",
        docLineId: line.id,
        note: ln.reason,
      });
    }
  }
  if (movements.length)
    await applyMovements(tx, movements, {
      docType: "INV_ADJUSTMENT",
      docId: doc.id,
      businessDate: args.businessDate,
      userId: args.userId,
    });
  await tx
    .update(invAdjustmentDoc)
    .set({ docStatus: "POSTED" })
    .where(eq(invAdjustmentDoc.id, doc.id));
  return doc.id as number;
}

/* ---------------------------------------------------------------- Receiving */
const ReceivingSchema = baseHeader.extend({
  vendorId: z.number().int().nullable().optional(),
  poNo: z.string().optional(),
  prNo: z.string().optional(),
  zohoPoId: z.string().optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int(),
        acceptedQty: qtyField,
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("kg"),
        poExpectedQty: qtyField.optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * Unplanned (off-PO) receipt. Staff receiving is PO-only via
 * submitReceivingBatch — this escape hatch is MANAGER+ and audited by the
 * doc's creator + note.
 */
export async function submitReceiving(
  input: z.input<typeof ReceivingSchema>,
): Promise<ActionResult> {
  const s = await requireManager();
  const p = ReceivingSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const cr = await locationId(COLD_ROOM);
  const bay = await locationId(RECEIVING_BAY);
  try {
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: receivingDoc.id })
          .from(receivingDoc)
          .where(eq(receivingDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(receivingDoc)
        .values({
          vendorId: p.vendorId ?? null,
          poNo: p.poNo,
          prNo: p.prNo,
          zohoPoId: p.zohoPoId,
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
        })
        .returning({ id: receivingDoc.id });

      const needsSort = await receiptDestinations(
        tx,
        p.lines.map((l) => l.skuId),
      );
      const movements: MovementInput[] = [];
      for (const ln of p.lines) {
        const [line] = await tx
          .insert(receivingLine)
          .values({
            docId: doc.id,
            skuId: ln.skuId,
            acceptedQty: ln.acceptedQty,
            poExpectedQty: ln.poExpectedQty ?? null,
            uom: ln.uom,
            notes: ln.notes,
          })
          .returning({ id: receivingLine.id });
        movements.push({
          skuId: ln.skuId,
          locationId: (needsSort.get(ln.skuId) ?? true) ? bay : cr,
          qtySigned: ln.acceptedQty,
          uom: ln.uom,
          movementType: "RECEIPT",
          docLineId: line.id,
        });
      }
      await applyMovements(tx, movements, {
        docType: "RECEIVING",
        docId: doc.id,
        businessDate,
        userId: s.uid,
      });
      await tx
        .update(receivingDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(receivingDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/receiving");
    revalidatePath("/sorting");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}

/* ---- Receiving (batch: one sheet covering many open POs) ---- */
const VarianceSchema = z.discriminatedUnion("type", [
  // short receipt; vendor leaves the missing part free of charge (₹0)
  z.object({ type: z.literal("S1_FREE_LEFTOVER"), freeQty: qtyField }),
  // vendor supplied more than the PO remaining — everything is billable
  z.object({ type: z.literal("S2_OVER_RECEIPT") }),
  // short receipt but the vendor bills the full remaining — missing → wastage
  z.object({ type: z.literal("S4_SHORT_BILLED_FULL"), wasteReason: z.string().min(1) }),
]);

const ReceivingBatchSchema = z.object({
  clientToken: z.string().min(8).optional(),
  pos: z
    .array(
      z.object({
        zohoPoId: z.string().optional(),
        poNo: z.string().optional(),
        lines: z
          .array(
            z.object({
              skuId: z.number().int(),
              acceptedQty: qtyField,
              /** Remaining PO qty for this line (PO qty − already received). */
              poExpectedQty: qtyField.optional(),
              uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("kg"),
              variance: VarianceSchema.optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

type BatchLine = z.output<typeof ReceivingBatchSchema>["pos"][number]["lines"][number];

/** Validate a PO line's accepted qty against its remaining + chosen scenario. */
function checkVariance(ln: BatchLine): string | null {
  const remaining = ln.poExpectedQty;
  if (remaining == null) return null; // off-PO lines have no remaining to check
  const v = ln.variance;
  if (!v) {
    if (gt(ln.acceptedQty, remaining))
      return `Accepted ${ln.acceptedQty} exceeds the remaining PO qty ${remaining}. Pick the "vendor supplied more" option to confirm the over-receipt.`;
    return null;
  }
  switch (v.type) {
    case "S1_FREE_LEFTOVER": {
      if (!gt(v.freeQty, 0)) return "Free leftover qty must be greater than 0.";
      if (gte(ln.acceptedQty, remaining))
        return "The free-leftover scenario applies only when accepted is below the remaining PO qty.";
      if (gt(sumQty([ln.acceptedQty, v.freeQty]), remaining))
        return `Accepted + free (${qtyStr(sumQty([ln.acceptedQty, v.freeQty]))}) cannot exceed the remaining PO qty ${remaining}.`;
      return null;
    }
    case "S2_OVER_RECEIPT":
      if (!gt(ln.acceptedQty, remaining))
        return "The over-receipt scenario applies only when accepted exceeds the remaining PO qty.";
      return null;
    case "S4_SHORT_BILLED_FULL":
      if (gte(ln.acceptedQty, remaining))
        return "The short-but-billed-full scenario applies only when accepted is below the remaining PO qty.";
      return null;
  }
}

/**
 * Receive against several open POs from one sheet: creates one POSTED
 * receiving doc per PO (atomic, all-or-nothing). Idempotent via a per-PO client
 * token so a retry on weak wifi can't double-post any single PO.
 *
 * Workflow rules enforced here (server-side, not just UI):
 *  - Only MANAGER+ may submit off-PO groups (no zohoPoId).
 *  - Without a variance scenario, accepted can never exceed the PO remaining.
 *  - Receipts land in the RECEIVING_BAY (unless the SKU skips sorting), so
 *    unsorted stock is structurally unusable downstream.
 *  - S1/S4 auto-create their wastage/adjustment paper trail in the same tx.
 */
export async function submitReceivingBatch(
  input: z.input<typeof ReceivingBatchSchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = ReceivingBatchSchema.parse(input);
  const businessDate = istToday();
  const cr = await locationId(COLD_ROOM);
  const bay = await locationId(RECEIVING_BAY);

  // PO-only receiving for floor staff; MANAGER+ may record unplanned receipts.
  if (p.pos.some((po) => !po.zohoPoId) && !hasRole(s.role, "MANAGER")) {
    return {
      ok: false,
      error:
        "Items not on a Purchase Order can't be received. Ask Aniket to add them to a PO (or record an unplanned receipt).",
    };
  }
  for (const po of p.pos) {
    for (const ln of po.lines) {
      const err = checkVariance(ln);
      if (err) return { ok: false, error: err };
    }
  }

  try {
    const docIds = await db.transaction(async (tx: Tx) => {
      const ids: number[] = [];
      for (let i = 0; i < p.pos.length; i++) {
        const po = p.pos[i];
        const token = p.clientToken
          ? `${p.clientToken}:${po.zohoPoId ?? "manual"}:${i}`
          : undefined;
        if (token) {
          const ex = await tx
            .select({ id: receivingDoc.id })
            .from(receivingDoc)
            .where(eq(receivingDoc.clientToken, token));
          if (ex[0]) {
            ids.push(ex[0].id as number);
            continue;
          }
        }
        const varianceTypes = [
          ...new Set(po.lines.flatMap((l) => (l.variance ? [l.variance.type] : []))),
        ];
        const [doc] = await tx
          .insert(receivingDoc)
          .values({
            vendorId: null,
            poNo: po.poNo,
            zohoPoId: po.zohoPoId,
            businessDate,
            clientToken: token,
            createdByUserId: s.uid,
            variance: varianceTypes.length === 1 ? varianceTypes[0] : "NONE",
          })
          .returning({ id: receivingDoc.id });

        const needsSort = await receiptDestinations(
          tx,
          po.lines.map((l) => l.skuId),
        );
        const movements: MovementInput[] = [];
        const s1AdjLines: TxAdjustmentLine[] = [];
        const s4WasteLines: TxWastageLine[] = [];
        const varianceNotes: string[] = [];

        for (const ln of po.lines) {
          const dest = (needsSort.get(ln.skuId) ?? true) ? bay : cr;
          const v = ln.variance;

          if (v?.type === "S4_SHORT_BILLED_FULL") {
            // Billed for the full remaining: receive the bill qty, then waste
            // the missing part (source RECEIVING) → net stock = accepted.
            const billQty = ln.poExpectedQty!;
            const missing = qtyStr(sub(billQty, ln.acceptedQty));
            const [line] = await tx
              .insert(receivingLine)
              .values({
                docId: doc.id,
                skuId: ln.skuId,
                acceptedQty: billQty,
                poExpectedQty: ln.poExpectedQty ?? null,
                uom: ln.uom,
                notes: `S4: physically received ${ln.acceptedQty}, ${missing} missing → wastage (${v.wasteReason})`,
              })
              .returning({ id: receivingLine.id });
            movements.push({
              skuId: ln.skuId,
              locationId: dest,
              qtySigned: billQty,
              uom: ln.uom,
              movementType: "RECEIPT",
              docLineId: line.id,
            });
            s4WasteLines.push({
              skuId: ln.skuId,
              locationId: dest,
              qty: missing,
              uom: ln.uom,
              reason: v.wasteReason,
              source: "RECEIVING",
              sourceDocType: "RECEIVING",
              sourceDocId: doc.id,
            });
            varianceNotes.push(
              `S4 sku ${ln.skuId}: billed ${billQty}, received ${ln.acceptedQty}, wasted ${missing} (${v.wasteReason})`,
            );
            continue;
          }

          // billable portion (all scenarios except S4)
          const [line] = await tx
            .insert(receivingLine)
            .values({
              docId: doc.id,
              skuId: ln.skuId,
              acceptedQty: ln.acceptedQty,
              poExpectedQty: ln.poExpectedQty ?? null,
              uom: ln.uom,
              notes:
                v?.type === "S1_FREE_LEFTOVER"
                  ? "S1: billable portion"
                  : v?.type === "S2_OVER_RECEIPT"
                    ? "S2: over-receipt — PO/bill update to actual"
                    : undefined,
            })
            .returning({ id: receivingLine.id });
          movements.push({
            skuId: ln.skuId,
            locationId: dest,
            qtySigned: ln.acceptedQty,
            uom: ln.uom,
            movementType: "RECEIPT",
            docLineId: line.id,
          });

          if (v?.type === "S1_FREE_LEFTOVER") {
            // Second receiving line so the free qty counts toward the PO's
            // cumulative received (the sheet line closes immediately).
            const [freeLine] = await tx
              .insert(receivingLine)
              .values({
                docId: doc.id,
                skuId: ln.skuId,
                acceptedQty: v.freeQty,
                poExpectedQty: null,
                uom: ln.uom,
                notes: "S1: free leftover from vendor (₹0)",
              })
              .returning({ id: receivingLine.id });
            movements.push({
              skuId: ln.skuId,
              locationId: dest,
              qtySigned: v.freeQty,
              uom: ln.uom,
              movementType: "RECEIPT",
              docLineId: freeLine.id,
            });
            // Record-only ₹0 adjustment: documents the tie-out and is what
            // Aniket pushes to Zoho as the +qty zero-cost adjustment.
            s1AdjLines.push({
              skuId: ln.skuId,
              locationId: dest,
              qtyAsPerPo: ln.poExpectedQty,
              actualReceived: qtyStr(sumQty([ln.acceptedQty, v.freeQty])),
              qtyAsPerBill: ln.acceptedQty,
              qtyToAdjust: v.freeQty,
              unitCost: "0",
              reason: `S1: vendor left ${v.freeQty} free of charge (₹0); bill only ${ln.acceptedQty}`,
            });
            varianceNotes.push(
              `S1 sku ${ln.skuId}: billable ${ln.acceptedQty} + free ${v.freeQty}`,
            );
          } else if (v?.type === "S2_OVER_RECEIPT") {
            varianceNotes.push(
              `S2 sku ${ln.skuId}: PO remaining ${ln.poExpectedQty}, received ${ln.acceptedQty} — update PO + bill to actual`,
            );
          }
        }

        await applyMovements(tx, movements, {
          docType: "RECEIVING",
          docId: doc.id,
          businessDate,
          userId: s.uid,
        });
        if (s4WasteLines.length) {
          await createWastageDocInTx(tx, {
            userId: s.uid,
            businessDate,
            note: `auto: receiving #${doc.id} S4 short-billed-full`,
            lines: s4WasteLines,
            postMovements: true,
          });
        }
        if (s1AdjLines.length) {
          await createAdjustmentDocInTx(tx, {
            userId: s.uid,
            businessDate,
            against: `RECEIVING:${doc.id}`,
            note: `auto: receiving #${doc.id} S1 free leftover (₹0) — qty already counted by the receipt lines`,
            lines: s1AdjLines,
            postMovements: false, // receipt lines already carried the stock in
          });
        }
        await tx
          .update(receivingDoc)
          .set({
            docStatus: "POSTED",
            varianceNote: varianceNotes.length ? varianceNotes.join("; ") : null,
          })
          .where(eq(receivingDoc.id, doc.id));
        ids.push(doc.id as number);
      }
      return ids;
    });
    revalidatePath("/dashboard");
    revalidatePath("/receiving");
    revalidatePath("/sorting");
    revalidatePath("/wastage");
    revalidatePath("/adjustment");
    return { ok: true, docId: docIds[0] ?? 0, count: docIds.length };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------ Sorting */
const SortingSchema = baseHeader.extend({
  isRecheck: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        skuId: z.number().int(),
        sortedQty: qtyField,
        qtyA: qtyField.default("0"),
        qtyB: qtyField.default("0"),
        qtyC: qtyField.default("0"),
      }),
    )
    .min(1),
});

/**
 * Sorting (isRecheck=false) is the ONLY path from the Receiving Bay into the
 * Cold Room: bay −(A+B+C) −waste, cold room +(A+B+C). Sorting more than the
 * bay holds hard-blocks — the ledger itself enforces receive-before-sort.
 *
 * Regrade (isRecheck=true) re-grades stock already IN the Cold Room: only the
 * waste leaves (REGRADE_WASTE), exactly as v1.
 */
export async function submitSorting(
  input: z.input<typeof SortingSchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = SortingSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const cr = await locationId(COLD_ROOM);
  const bay = await locationId(RECEIVING_BAY);
  try {
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: sortingDoc.id })
          .from(sortingDoc)
          .where(eq(sortingDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(sortingDoc)
        .values({
          isRecheck: p.isRecheck,
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
        })
        .returning({ id: sortingDoc.id });

      const movements: MovementInput[] = [];
      for (const ln of p.lines) {
        // waste auto = sorted - (a+b+c); enforced by DB CHECK + generated col.
        // Decimal sum (not native floats) so it can't drift by ~0.001.
        const good = sumQty([ln.qtyA, ln.qtyB, ln.qtyC]);
        const waste = sub(ln.sortedQty, good);
        if (lt(waste, 0)) throw new Error("A + B + C cannot exceed the sorted qty.");
        const [line] = await tx
          .insert(sortingLine)
          .values({
            docId: doc.id,
            skuId: ln.skuId,
            sortedQty: ln.sortedQty,
            qtyA: ln.qtyA,
            qtyB: ln.qtyB,
            qtyC: ln.qtyC,
          })
          .returning({ id: sortingLine.id });

        if (p.isRecheck) {
          // regrade: stock stays in the cold room; only waste leaves
          if (gt(waste, 0)) {
            movements.push({
              skuId: ln.skuId,
              locationId: cr,
              qtySigned: qtyStr(sub(0, waste)),
              uom: "kg",
              movementType: "REGRADE_WASTE",
              docLineId: line.id,
              note: "regrade waste",
            });
          }
        } else {
          // sorting: transfer bay → cold room, waste out of the bay
          if (gt(good, 0)) {
            movements.push({
              skuId: ln.skuId,
              locationId: bay,
              qtySigned: qtyStr(sub(0, good)),
              uom: "kg",
              movementType: "SORT_OUT",
              docLineId: line.id,
            });
            movements.push({
              skuId: ln.skuId,
              locationId: cr,
              qtySigned: qtyStr(good),
              uom: "kg",
              movementType: "SORT_IN",
              docLineId: line.id,
            });
          }
          if (gt(waste, 0)) {
            movements.push({
              skuId: ln.skuId,
              locationId: bay,
              qtySigned: qtyStr(sub(0, waste)),
              uom: "kg",
              movementType: "SORT_WASTE",
              docLineId: line.id,
              note: "sorting waste",
            });
          }
        }
      }
      if (movements.length)
        await applyMovements(tx, movements, {
          docType: "SORTING",
          docId: doc.id,
          businessDate,
          userId: s.uid,
        });
      await tx
        .update(sortingDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(sortingDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/sorting");
    revalidatePath("/regrade");
    revalidatePath("/wastage");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}

/* ----------------------------------------------------------------- Assembly */
const AssemblySchema = baseHeader.extend({
  channel: z.enum(["BULK_FRUIT", "BLINKIT", "SPENCERS"]),
  lines: z
    .array(
      z.object({
        motherSkuId: z.number().int(),
        packSkuId: z.number().int(),
        qtyOut: qtyField,
        qtyIn: qtyField.default("0"),
        packsMade: qtyField,
        packSizeText: z.string().optional(),
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("pc"),
        /** Part of `used` that didn't make it into packs (trim, damage). */
        qtyWaste: qtyField.default("0"),
        wasteReason: z.string().optional(),
      }),
    )
    .min(1),
});

export async function submitAssembly(
  input: z.input<typeof AssemblySchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = AssemblySchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const cr = await locationId(COLD_ROOM);
  const fg = await locationId(DC_FLOOR_FG);
  try {
    await assertPickListComplete(); // mandatory Pick List gate — no bypass
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: assemblyDoc.id })
          .from(assemblyDoc)
          .where(eq(assemblyDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(assemblyDoc)
        .values({
          channel: p.channel,
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
        })
        .returning({ id: assemblyDoc.id });

      const movements: MovementInput[] = [];
      const wasteLines: TxWastageLine[] = [];
      for (const ln of p.lines) {
        if (lt(ln.qtyIn, 0) || gt(ln.qtyIn, ln.qtyOut))
          throw new Error("Returned-to-CR qty must be between 0 and qty out.");
        const used = sub(ln.qtyOut, ln.qtyIn);
        if (lt(used, ln.qtyWaste))
          throw new Error("Assembly waste cannot exceed the quantity used.");
        const [line] = await tx
          .insert(assemblyLine)
          .values({
            docId: doc.id,
            motherSkuId: ln.motherSkuId,
            packSkuId: ln.packSkuId,
            qtyOut: ln.qtyOut,
            qtyIn: ln.qtyIn,
            totalUsed: qtyStr(used),
            packsMade: ln.packsMade,
            packSizeText: ln.packSizeText,
            qtyWaste: ln.qtyWaste,
          })
          .returning({ id: assemblyLine.id });
        movements.push({
          skuId: ln.motherSkuId,
          locationId: cr,
          qtySigned: qtyStr(sub(0, used)),
          uom: "kg",
          movementType: "ASSEMBLY_CONSUME",
          docLineId: line.id,
        });
        movements.push({
          skuId: ln.packSkuId,
          locationId: fg,
          qtySigned: ln.packsMade,
          uom: ln.uom,
          movementType: "PACK_PRODUCE",
          docLineId: line.id,
        });
        if (gt(ln.qtyWaste, 0)) {
          // Record-only: ASSEMBLY_CONSUME already took the full `used` from
          // the cold room; this tags the wasted share for per-stage reporting.
          wasteLines.push({
            skuId: ln.motherSkuId,
            locationId: cr,
            qty: ln.qtyWaste,
            uom: "kg",
            reason: ln.wasteReason || "Assembly trim/damage",
            source: "ASSEMBLY",
            sourceDocType: "ASSEMBLY",
            sourceDocId: doc.id,
          });
        }
      }
      await applyMovements(tx, movements, {
        docType: "ASSEMBLY",
        docId: doc.id,
        businessDate,
        userId: s.uid,
      });
      if (wasteLines.length) {
        await createWastageDocInTx(tx, {
          userId: s.uid,
          businessDate,
          note: `auto: assembly #${doc.id} waste`,
          lines: wasteLines,
          postMovements: false, // consume already removed the stock
        });
      }
      await tx
        .update(assemblyDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(assemblyDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/assembly");
    revalidatePath("/wastage");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------ Wastage */
const WastageSchema = baseHeader.extend({
  lines: z
    .array(
      z.object({
        skuId: z.number().int(),
        locationCode: z.enum([COLD_ROOM, DC_FLOOR_FG, RECEIVING_BAY]).default(COLD_ROOM),
        qty: qtyField,
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("kg"),
        reason: z.string().min(1),
        source: z
          .enum(["RECEIVING", "SORTING", "REGRADE", "ASSEMBLY", "RETURN", "EXPIRY", "GENERAL"])
          .default("GENERAL"),
      }),
    )
    .min(1),
});

export async function submitWastage(
  input: z.input<typeof WastageSchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = WastageSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  try {
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: wastageDoc.id })
          .from(wastageDoc)
          .where(eq(wastageDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(wastageDoc)
        .values({
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
        })
        .returning({ id: wastageDoc.id });

      const movements: MovementInput[] = [];
      for (const ln of p.lines) {
        const loc = await locationId(ln.locationCode);
        const [line] = await tx
          .insert(wastageLine)
          .values({
            docId: doc.id,
            skuId: ln.skuId,
            locationId: loc,
            qty: ln.qty,
            uom: ln.uom,
            reason: ln.reason,
            source: ln.source,
          })
          .returning({ id: wastageLine.id });
        movements.push({
          skuId: ln.skuId,
          locationId: loc,
          qtySigned: qtyStr(sub(0, ln.qty)),
          uom: ln.uom,
          movementType: "WASTAGE",
          docLineId: line.id,
          note: ln.reason,
        });
      }
      await applyMovements(tx, movements, {
        docType: "WASTAGE",
        docId: doc.id,
        businessDate,
        userId: s.uid,
      });
      await tx
        .update(wastageDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(wastageDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/wastage");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}

/* ------------------------------------------------------------------- Return */
const ReturnSchema = baseHeader.extend({
  customerId: z.number().int().nullable().optional(),
  zohoInvoiceId: z.string().optional(),
  invNo: z.string().optional(),
  matchStatus: z.enum(["MATCHED", "PENDING_MATCH"]).default("PENDING_MATCH"),
  lines: z
    .array(
      z.object({
        skuId: z.number().int(),
        qtyReturn: qtyField,
        qtyWeight: qtyField.default("0"),
        backToMotherSkuId: z.number().int().nullable().optional(),
        disposition: z.enum(["RESALABLE", "WASTE"]),
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("pc"),
      }),
    )
    .min(1),
});

export async function submitReturn(
  input: z.input<typeof ReturnSchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = ReturnSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const cr = await locationId(COLD_ROOM);
  try {
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: returnDoc.id })
          .from(returnDoc)
          .where(eq(returnDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(returnDoc)
        .values({
          customerId: p.customerId ?? null,
          zohoInvoiceId: p.zohoInvoiceId,
          invNo: p.invNo,
          matchStatus: p.matchStatus,
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
        })
        .returning({ id: returnDoc.id });

      const movements: MovementInput[] = [];
      for (const ln of p.lines) {
        const [line] = await tx
          .insert(returnLine)
          .values({
            docId: doc.id,
            skuId: ln.skuId,
            qtyReturn: ln.qtyReturn,
            qtyWeight: ln.qtyWeight,
            backToMotherSkuId: ln.backToMotherSkuId ?? null,
            disposition: ln.disposition,
            uom: ln.uom,
          })
          .returning({ id: returnLine.id });
        // RESALABLE → re-enters cold room as mother by weighed kg.
        // WASTE → goods were already dispatched/out; recorded, no stock effect.
        if (ln.disposition === "RESALABLE" && ln.backToMotherSkuId && gt(ln.qtyWeight, 0)) {
          movements.push({
            skuId: ln.backToMotherSkuId,
            locationId: cr,
            qtySigned: ln.qtyWeight,
            uom: "kg",
            movementType: "RETURN_TO_MOTHER",
            docLineId: line.id,
            note: "customer return → mother",
          });
        }
      }
      if (movements.length)
        await applyMovements(tx, movements, {
          docType: "RETURN",
          docId: doc.id,
          businessDate,
          userId: s.uid,
        });
      await tx
        .update(returnDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(returnDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/return");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}

/* -------------------------------------------------------------- Adjustment */
const AdjustmentSchema = baseHeader.extend({
  vendorId: z.number().int().nullable().optional(),
  against: z.string().optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int(),
        locationCode: z.enum([COLD_ROOM, DC_FLOOR_FG, RECEIVING_BAY]).default(COLD_ROOM),
        qtyAsPerPo: qtyField.optional(),
        actualReceived: qtyField.optional(),
        qtyAsPerBill: qtyField.optional(),
        qtyToAdjust: qtyField,
        adjKind: z.enum(["TIE_OUT", "OVERRIDE", "MANUAL"]).default("MANUAL"),
        unitCost: z.union([z.string(), z.number()]).optional(),
        reason: z.string().optional(),
      }),
    )
    .min(1),
});

export async function submitAdjustment(
  input: z.input<typeof AdjustmentSchema>,
): Promise<ActionResult> {
  const s = await requireSupervisor();
  const p = AdjustmentSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const isAdmin = s.role === "ADMIN";
  try {
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: invAdjustmentDoc.id })
          .from(invAdjustmentDoc)
          .where(eq(invAdjustmentDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(invAdjustmentDoc)
        .values({
          vendorId: p.vendorId ?? null,
          against: p.against,
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
        })
        .returning({ id: invAdjustmentDoc.id });

      const movements: MovementInput[] = [];
      for (const ln of p.lines) {
        const loc = await locationId(ln.locationCode);
        const [line] = await tx
          .insert(invAdjustmentLine)
          .values({
            docId: doc.id,
            skuId: ln.skuId,
            locationId: loc,
            qtyAsPerPo: ln.qtyAsPerPo ?? null,
            actualReceived: ln.actualReceived ?? null,
            qtyAsPerBill: ln.qtyAsPerBill ?? null,
            qtyToAdjust: ln.qtyToAdjust,
            adjKind: ln.adjKind,
            unitCost: ln.unitCost != null ? String(ln.unitCost) : "0",
            reason: ln.reason,
          })
          .returning({ id: invAdjustmentLine.id });
        if (!gt(ln.qtyToAdjust, 0) && !lt(ln.qtyToAdjust, 0)) continue; // zero
        movements.push({
          skuId: ln.skuId,
          locationId: loc,
          qtySigned: ln.qtyToAdjust,
          uom: "kg",
          movementType: gt(ln.qtyToAdjust, 0) ? "ADJUSTMENT_PLUS" : "ADJUSTMENT_MINUS",
          docLineId: line.id,
          note: ln.reason ?? ln.adjKind,
          allowNegative: isAdmin, // ADMIN may correct below zero
        });
      }
      if (movements.length)
        await applyMovements(tx, movements, {
          docType: "INV_ADJUSTMENT",
          docId: doc.id,
          businessDate,
          userId: s.uid,
        });
      await tx
        .update(invAdjustmentDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(invAdjustmentDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/adjustment");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}

/* -------------------------------------------------------------- Dispatch */
const DispatchSchema = baseHeader.extend({
  customerId: z.number().int().nullable().optional(),
  channel: z.enum(["BULK_FRUIT", "BLINKIT", "SPENCERS"]).nullable().optional(),
  dispatchRef: z.string().optional(),
  lines: z
    .array(
      z.object({
        packSkuId: z.number().int(),
        qty: qtyField,
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("pc"),
      }),
    )
    .min(1),
});

export async function submitDispatch(
  input: z.input<typeof DispatchSchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = DispatchSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const fg = await locationId(DC_FLOOR_FG);
  try {
    const gatePickListId = await assertPickListComplete(); // mandatory Pick List gate
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: dispatchDoc.id })
          .from(dispatchDoc)
          .where(eq(dispatchDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(dispatchDoc)
        .values({
          customerId: p.customerId ?? null,
          channel: p.channel ?? null,
          dispatchRef: p.dispatchRef,
          pickListId: gatePickListId,
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
        })
        .returning({ id: dispatchDoc.id });

      const movements: MovementInput[] = [];
      for (const ln of p.lines) {
        const [line] = await tx
          .insert(dispatchLine)
          .values({ docId: doc.id, packSkuId: ln.packSkuId, qty: ln.qty, uom: ln.uom })
          .returning({ id: dispatchLine.id });
        movements.push({
          skuId: ln.packSkuId,
          locationId: fg,
          qtySigned: qtyStr(sub(0, ln.qty)),
          uom: ln.uom,
          movementType: "DISPATCH",
          docLineId: line.id,
        });
      }
      await applyMovements(tx, movements, {
        docType: "DISPATCH",
        docId: doc.id,
        businessDate,
        userId: s.uid,
      });
      await tx
        .update(dispatchDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(dispatchDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/dispatch");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}

/* --------------------------------------------------------------------- Void */
const docTables = {
  RECEIVING: receivingDoc,
  SORTING: sortingDoc,
  ASSEMBLY: assemblyDoc,
  WASTAGE: wastageDoc,
  RETURN: returnDoc,
  INV_ADJUSTMENT: invAdjustmentDoc,
  DISPATCH: dispatchDoc,
} as const;

export async function voidDocument(
  docType: keyof typeof docTables,
  docId: number,
  reason: string,
  opts?: { overridePushed?: boolean },
): Promise<ActionResult> {
  const s = await requireSupervisor();
  if (!reason || reason.trim().length < 3)
    return { ok: false, error: "A void reason is required." };
  const businessDate = istToday();
  const table = docTables[docType];

  // Zoho guard: voiding here never un-pushes anything. If this doc (or a
  // cascade companion) already reached Zoho, block — the operator must fix
  // Zoho manually first. ADMIN can override explicitly, which is audited.
  const pushedKeys: { docType: string; docId: number }[] = [{ docType, docId }];
  if (docType === "RECEIVING" || docType === "ASSEMBLY") {
    const linkedWaste = await db
      .selectDistinct({ docId: wastageLine.docId })
      .from(wastageLine)
      .where(and(eq(wastageLine.sourceDocType, docType), eq(wastageLine.sourceDocId, docId)));
    for (const w of linkedWaste) pushedKeys.push({ docType: "WASTAGE", docId: w.docId });
  }
  if (docType === "RECEIVING") {
    const linkedAdj = await db
      .select({ id: invAdjustmentDoc.id })
      .from(invAdjustmentDoc)
      .where(eq(invAdjustmentDoc.against, `RECEIVING:${docId}`));
    for (const a of linkedAdj) pushedKeys.push({ docType: "INV_ADJUSTMENT", docId: a.id });
  }
  const pushedRows = await db
    .select({
      kind: zohoPush.kind,
      docType: zohoPush.docType,
      docId: zohoPush.docId,
      zohoId: zohoPush.zohoId,
    })
    .from(zohoPush)
    .where(
      and(
        eq(zohoPush.status, "SUCCESS"),
        inArray(zohoPush.docType, [...new Set(pushedKeys.map((k) => k.docType))]),
        inArray(zohoPush.docId, [...new Set(pushedKeys.map((k) => k.docId))]),
      ),
    );
  const actuallyPushed = pushedRows.filter((r) =>
    pushedKeys.some((k) => k.docType === r.docType && k.docId === r.docId),
  );
  if (actuallyPushed.length) {
    const list = actuallyPushed
      .map((r) => `${r.kind} → Zoho ${r.zohoId ?? "(id not recorded)"}`)
      .join("; ");
    if (!(opts?.overridePushed && hasRole(s.role, "ADMIN"))) {
      return {
        ok: false,
        error: `Already pushed to Zoho (${list}). Voiding here will NOT remove it from Zoho — correct Zoho manually first; then an ADMIN can void with override.`,
      };
    }
  }

  try {
    await db.transaction(async (tx: Tx) => {
      // Cascade: receiving/assembly may have auto-created companion docs
      // (S4 wastage, S1 record-only adjustment, assembly waste). Void those
      // first — the S4 wastage reversal restores bay stock so the receipt
      // reversal that follows can't hard-block.
      if (docType === "RECEIVING" || docType === "ASSEMBLY") {
        const linkedWaste = await tx
          .selectDistinct({ docId: wastageLine.docId })
          .from(wastageLine)
          .innerJoin(wastageDoc, eq(wastageDoc.id, wastageLine.docId))
          .where(
            and(
              eq(wastageLine.sourceDocType, docType),
              eq(wastageLine.sourceDocId, docId),
              eq(wastageDoc.docStatus, "POSTED"),
            ),
          );
        for (const w of linkedWaste) {
          await voidDocumentLedger(tx, "WASTAGE", w.docId, {
            userId: s.uid,
            businessDate,
            reason: `cascade: void of ${docType} #${docId} — ${reason}`,
          });
          await tx
            .update(wastageDoc)
            .set({
              docStatus: "VOIDED",
              voidedByUserId: s.uid,
              voidedAt: new Date(),
              voidReason: `cascade: void of ${docType} #${docId} — ${reason}`,
            })
            .where(eq(wastageDoc.id, w.docId));
        }
      }
      if (docType === "RECEIVING") {
        const linkedAdj = await tx
          .select({ id: invAdjustmentDoc.id })
          .from(invAdjustmentDoc)
          .where(
            and(
              eq(invAdjustmentDoc.against, `RECEIVING:${docId}`),
              eq(invAdjustmentDoc.docStatus, "POSTED"),
            ),
          );
        for (const a of linkedAdj) {
          await voidDocumentLedger(tx, "INV_ADJUSTMENT", a.id, {
            userId: s.uid,
            businessDate,
            reason: `cascade: void of RECEIVING #${docId} — ${reason}`,
          });
          await tx
            .update(invAdjustmentDoc)
            .set({
              docStatus: "VOIDED",
              voidedByUserId: s.uid,
              voidedAt: new Date(),
              voidReason: `cascade: void of RECEIVING #${docId} — ${reason}`,
            })
            .where(eq(invAdjustmentDoc.id, a.id));
        }
      }

      await voidDocumentLedger(tx, docType, docId, {
        userId: s.uid,
        businessDate,
        reason,
      });
      await tx
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(table as any)
        .set({ docStatus: "VOIDED", voidedByUserId: s.uid, voidedAt: new Date(), voidReason: reason })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(eq((table as any).id, docId));
      if (actuallyPushed.length) {
        // ADMIN chose to void despite Zoho records existing — leave a loud trail.
        await tx.insert(appAuditLog).values({
          userId: s.uid,
          action: "VOID_PUSHED_OVERRIDE",
          docType,
          docId,
          payload: { reason, zohoRecords: actuallyPushed },
        });
      }
    });
    revalidatePath("/dashboard");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}
