"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
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
} from "@/lib/db/schema";
import {
  applyMovements,
  voidDocumentLedger,
  HardBlockError,
  type MovementInput,
  type Tx,
} from "@/lib/ledger/post";
import { requireUser, requireSupervisor } from "@/lib/auth/rbac";
import { locationId } from "@/lib/locations";
import { COLD_ROOM, DC_FLOOR_FG } from "@/lib/constants";
import { sub, qtyStr, gt, lt } from "@/lib/money";

export type ActionResult =
  | { ok: true; docId: number }
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

export async function submitReceiving(
  input: z.input<typeof ReceivingSchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = ReceivingSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const cr = await locationId(COLD_ROOM);
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
          locationId: cr,
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
    return { ok: true, docId };
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

export async function submitSorting(
  input: z.input<typeof SortingSchema>,
): Promise<ActionResult> {
  const s = await requireUser();
  const p = SortingSchema.parse(input);
  const businessDate = p.businessDate ?? istToday();
  const cr = await locationId(COLD_ROOM);
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
        // waste auto = sorted - (a+b+c); enforced by DB CHECK + generated col
        const waste = sub(ln.sortedQty, qtyStr(Number(ln.qtyA) + Number(ln.qtyB) + Number(ln.qtyC)));
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
        if (gt(waste, 0)) {
          movements.push({
            skuId: ln.skuId,
            locationId: cr,
            qtySigned: qtyStr(sub(0, waste)),
            uom: "kg",
            movementType: p.isRecheck ? "REGRADE_WASTE" : "SORT_WASTE",
            docLineId: line.id,
            note: "sorting waste",
          });
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
      for (const ln of p.lines) {
        if (lt(ln.qtyIn, 0) || gt(ln.qtyIn, ln.qtyOut))
          throw new Error("Returned-to-CR qty must be between 0 and qty out.");
        const used = sub(ln.qtyOut, ln.qtyIn);
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
          uom: "pc",
          movementType: "PACK_PRODUCE",
          docLineId: line.id,
        });
      }
      await applyMovements(tx, movements, {
        docType: "ASSEMBLY",
        docId: doc.id,
        businessDate,
        userId: s.uid,
      });
      await tx
        .update(assemblyDoc)
        .set({ docStatus: "POSTED" })
        .where(eq(assemblyDoc.id, doc.id));
      return doc.id as number;
    });
    revalidatePath("/dashboard");
    revalidatePath("/assembly");
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
        locationCode: z.enum([COLD_ROOM, DC_FLOOR_FG]).default(COLD_ROOM),
        qty: qtyField,
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("kg"),
        reason: z.string().min(1),
        source: z
          .enum(["SORTING", "REGRADE", "ASSEMBLY", "RETURN", "EXPIRY", "GENERAL"])
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
        locationCode: z.enum([COLD_ROOM, DC_FLOOR_FG]).default(COLD_ROOM),
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
): Promise<ActionResult> {
  const s = await requireSupervisor();
  if (!reason || reason.trim().length < 3)
    return { ok: false, error: "A void reason is required." };
  const businessDate = istToday();
  const table = docTables[docType];
  try {
    await db.transaction(async (tx: Tx) => {
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
    });
    revalidatePath("/dashboard");
    return { ok: true, docId };
  } catch (e) {
    return fail(e);
  }
}
