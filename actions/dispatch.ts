"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { dispatchDoc, dispatchLine } from "@/lib/db/schema";
import type { Tx } from "@/lib/ledger/post";
import { requireUser } from "@/lib/auth/rbac";
import { D, gte, qtyStr } from "@/lib/money";

export type DeliveryResult =
  | { ok: true; docId: number; status: "PENDING" | "PARTIAL" | "DELIVERED" }
  | { ok: false; error: string };

const DeliverSchema = z.object({
  docId: z.number().int(),
  note: z.string().optional(),
  lines: z
    .array(
      z.object({
        lineId: z.number().int(),
        deliveredQty: z.union([z.string(), z.number()]).transform((v) => qtyStr(v)),
      }),
    )
    .min(1),
});

/**
 * Delivery confirmation for a dispatched shipment. Sets per-line delivered
 * qty (0 ≤ delivered ≤ dispatched) and derives the header status:
 * DELIVERED (all full) / PARTIAL (some) / PENDING (none). No stock movement —
 * the goods left Finished Goods at dispatch; shortfalls come back through the
 * Returns sheet.
 */
export async function markDelivered(
  input: z.input<typeof DeliverSchema>,
): Promise<DeliveryResult> {
  const s = await requireUser();
  const p = DeliverSchema.parse(input);
  try {
    const status = await db.transaction(async (tx: Tx) => {
      const [doc] = await tx
        .select({ status: dispatchDoc.docStatus })
        .from(dispatchDoc)
        .where(eq(dispatchDoc.id, p.docId));
      if (!doc) throw new Error("Dispatch not found.");
      if (doc.status !== "POSTED") throw new Error("Dispatch is not posted.");

      const lines = await tx
        .select({ id: dispatchLine.id, qty: dispatchLine.qty })
        .from(dispatchLine)
        .where(eq(dispatchLine.docId, p.docId));
      const qtyByLine = new Map<number, string>(
        lines.map((l: { id: number; qty: string }) => [l.id, l.qty]),
      );

      for (const ln of p.lines) {
        const dispatched = qtyByLine.get(ln.lineId);
        if (dispatched == null)
          throw new Error(`Line ${ln.lineId} does not belong to this dispatch.`);
        if (D(ln.deliveredQty).lt(0) || D(ln.deliveredQty).gt(D(dispatched)))
          throw new Error(
            `Delivered qty must be between 0 and the dispatched ${dispatched}.`,
          );
        await tx
          .update(dispatchLine)
          .set({ deliveredQty: ln.deliveredQty })
          .where(and(eq(dispatchLine.id, ln.lineId), eq(dispatchLine.docId, p.docId)));
      }

      // derive header status from ALL lines (not only the ones updated now)
      const after = await tx
        .select({ qty: dispatchLine.qty, delivered: dispatchLine.deliveredQty })
        .from(dispatchLine)
        .where(eq(dispatchLine.docId, p.docId));
      const allFull = after.every(
        (l: { qty: string; delivered: string }) => gte(l.delivered, l.qty),
      );
      const anyDelivered = after.some((l: { delivered: string }) => D(l.delivered).gt(0));
      const status: "PENDING" | "PARTIAL" | "DELIVERED" = allFull
        ? "DELIVERED"
        : anyDelivered
          ? "PARTIAL"
          : "PENDING";

      await tx
        .update(dispatchDoc)
        .set({
          deliveryStatus: status,
          deliveredAt: status === "PENDING" ? null : new Date(),
          deliveredByUserId: status === "PENDING" ? null : s.uid,
          deliveryNote: p.note ?? null,
        })
        .where(eq(dispatchDoc.id, p.docId));
      return status;
    });
    revalidatePath("/dispatch");
    revalidatePath("/dashboard");
    return { ok: true, docId: p.docId, status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
