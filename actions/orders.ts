"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { manualOrderDoc, manualOrderLine, pickListSource } from "@/lib/db/schema";
import type { Tx } from "@/lib/ledger/post";
import { requireUser, requireSupervisor } from "@/lib/auth/rbac";
import { istToday } from "@/lib/workflow";
import { qtyStr } from "@/lib/money";

export type OrderActionResult =
  | { ok: true; docId: number }
  | { ok: false; error: string };

const qtyField = z
  .union([z.string(), z.number()])
  .transform((v) => qtyStr(v))
  .refine((v) => Number(v) > 0, "qty must be > 0");

const ManualOrderSchema = z.object({
  clientToken: z.string().min(8).optional(),
  customerId: z.number().int().nullable().optional(),
  channel: z.enum(["MOTHER", "BULK_FRUIT", "BLINKIT", "SPENCERS", "OTHER"]).nullable().optional(),
  orderRef: z.string().optional(),
  note: z.string().optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int(),
        qty: qtyField,
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("pc"),
      }),
    )
    .min(1),
});

/**
 * Record a customer order that doesn't flow through Zoho (e.g. phoned-in or
 * platform orders). No stock movement — orders only feed the Pick List.
 */
export async function submitManualOrder(
  input: z.input<typeof ManualOrderSchema>,
): Promise<OrderActionResult> {
  const s = await requireUser();
  const p = ManualOrderSchema.parse(input);
  const businessDate = istToday();
  try {
    const docId = await db.transaction(async (tx: Tx) => {
      if (p.clientToken) {
        const ex = await tx
          .select({ id: manualOrderDoc.id })
          .from(manualOrderDoc)
          .where(eq(manualOrderDoc.clientToken, p.clientToken));
        if (ex[0]) return ex[0].id as number;
      }
      const [doc] = await tx
        .insert(manualOrderDoc)
        .values({
          customerId: p.customerId ?? null,
          channel: p.channel ?? null,
          orderRef: p.orderRef,
          businessDate,
          note: p.note,
          clientToken: p.clientToken,
          createdByUserId: s.uid,
          docStatus: "POSTED",
        })
        .returning({ id: manualOrderDoc.id });
      for (const ln of p.lines) {
        await tx.insert(manualOrderLine).values({
          docId: doc.id,
          skuId: ln.skuId,
          qty: ln.qty,
          uom: ln.uom,
        });
      }
      return doc.id as number;
    });
    revalidatePath("/orders");
    revalidatePath("/pick-list");
    return { ok: true, docId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Void a manual order that hasn't fed a pick list yet (SUPERVISOR+).
 * Once picked into a list, cancel the list instead.
 */
export async function voidManualOrder(
  docId: number,
  reason: string,
): Promise<OrderActionResult> {
  const s = await requireSupervisor();
  if (!reason || reason.trim().length < 3)
    return { ok: false, error: "A void reason is required." };
  try {
    await db.transaction(async (tx: Tx) => {
      const sourced = await tx
        .select({ id: pickListSource.id })
        .from(pickListSource)
        .where(eq(pickListSource.manualOrderDocId, docId))
        .limit(1);
      if (sourced[0])
        throw new Error(
          "This order already fed a pick list. Cancel that pick list first (supervisor), then void the order.",
        );
      const [doc] = await tx
        .select({ status: manualOrderDoc.docStatus })
        .from(manualOrderDoc)
        .where(and(eq(manualOrderDoc.id, docId)));
      if (!doc) throw new Error("Order not found.");
      if (doc.status !== "POSTED") throw new Error("Order is not posted.");
      await tx
        .update(manualOrderDoc)
        .set({
          docStatus: "VOIDED",
          voidedByUserId: s.uid,
          voidedAt: new Date(),
          voidReason: reason.trim(),
        })
        .where(eq(manualOrderDoc.id, docId));
    });
    revalidatePath("/orders");
    revalidatePath("/pick-list");
    return { ok: true, docId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
