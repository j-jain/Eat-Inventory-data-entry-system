"use server";

import { z } from "zod";
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  manualOrderDoc,
  manualOrderLine,
  pickList,
  pickListLine,
  pickListSource,
  skus,
  zohoSoCache,
} from "@/lib/db/schema";
import type { Tx } from "@/lib/ledger/post";
import { requireUser, requireSupervisor } from "@/lib/auth/rbac";
import { istToday } from "@/lib/workflow";
import { normalizeCode } from "@/lib/sku";
import { D, gte, qtyStr, sumQty } from "@/lib/money";

export type PickActionResult =
  | { ok: true; pickListId: number; lineCount: number; empty?: boolean }
  | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("uq_pick_list_single_open")) {
    return {
      ok: false,
      error: "A pick list is already open. Complete (or cancel) it before generating a new one.",
    };
  }
  return { ok: false, error: msg };
}

/**
 * Generate the Pick List: aggregate every open order that hasn't fed a pick
 * list yet — open Zoho Sales Orders (cache) + posted manual orders — into one
 * list of pack SKUs with qty to pick. If there is nothing to pick, an empty
 * COMPLETED list is created: the mandate is "generate first", and generating
 * is exactly what proves there are no orders today.
 */
export async function generatePickList(clientToken?: string): Promise<PickActionResult> {
  const s = await requireUser();
  const businessDate = istToday();
  try {
    return await db.transaction(async (tx: Tx) => {
      if (clientToken) {
        const ex = await tx
          .select({ id: pickList.id })
          .from(pickList)
          .where(eq(pickList.clientToken, clientToken));
        if (ex[0]) {
          const n = await tx
            .select({ id: pickListLine.id })
            .from(pickListLine)
            .where(eq(pickListLine.pickListId, ex[0].id));
          return { ok: true as const, pickListId: ex[0].id as number, lineCount: n.length };
        }
      }

      // One list at a time, full stop — even if there are no new orders
      // (otherwise an empty COMPLETED list would slip past the OPEN-only
      // unique index and confuse the operator).
      const openNow = await tx
        .select({ id: pickList.id })
        .from(pickList)
        .where(eq(pickList.status, "OPEN"))
        .limit(1);
      if (openNow[0]) {
        throw new Error(
          "A pick list is already open. Complete (or cancel) it before generating a new one.",
        );
      }

      // Orders already consumed by any non-cancelled pick list.
      const usedSo = await tx
        .selectDistinct({ zohoSoId: pickListSource.zohoSoId })
        .from(pickListSource)
        .innerJoin(pickList, eq(pickList.id, pickListSource.pickListId))
        .where(and(isNotNull(pickListSource.zohoSoId), inArray(pickList.status, ["OPEN", "COMPLETED"])));
      const usedManual = await tx
        .selectDistinct({ docId: pickListSource.manualOrderDocId })
        .from(pickListSource)
        .innerJoin(pickList, eq(pickList.id, pickListSource.pickListId))
        .where(
          and(isNotNull(pickListSource.manualOrderDocId), inArray(pickList.status, ["OPEN", "COMPLETED"])),
        );
      const usedSoIds = usedSo.map((r: { zohoSoId: string | null }) => r.zohoSoId!).filter(Boolean);
      const usedManualIds = usedManual
        .map((r: { docId: number | null }) => r.docId!)
        .filter((v: number | null) => v != null);

      // Unsourced open Zoho SOs
      const sos = await tx
        .select()
        .from(zohoSoCache)
        .where(usedSoIds.length ? notInArray(zohoSoCache.zohoSoId, usedSoIds) : undefined);

      // Unsourced posted manual orders
      const manuals = await tx
        .select({ id: manualOrderDoc.id })
        .from(manualOrderDoc)
        .where(
          and(
            eq(manualOrderDoc.docStatus, "POSTED"),
            usedManualIds.length ? notInArray(manualOrderDoc.id, usedManualIds) : undefined,
          ),
        );
      const manualIds = manuals.map((m: { id: number }) => m.id);
      const manualLines = manualIds.length
        ? await tx
            .select({
              skuId: manualOrderLine.skuId,
              qty: manualOrderLine.qty,
              uom: manualOrderLine.uom,
            })
            .from(manualOrderLine)
            .where(inArray(manualOrderLine.docId, manualIds))
        : [];

      // SKU match map for SO jsonb lines (same normalized-code match as POs).
      const skuList = await tx
        .select({ id: skus.id, code: skus.code, uom: skus.uom })
        .from(skus)
        .where(eq(skus.isActive, true));
      const byNorm = new Map<string, { id: number; uom: string }>();
      for (const k of skuList) byNorm.set(normalizeCode(k.code), { id: k.id, uom: k.uom });

      // Aggregate qty per pack SKU.
      const agg = new Map<number, { qty: ReturnType<typeof D>; uom: string }>();
      const bump = (skuId: number, qty: string | number, uom: string) => {
        const cur = agg.get(skuId);
        agg.set(skuId, { qty: (cur?.qty ?? D(0)).plus(D(qty)), uom: cur?.uom ?? uom });
      };
      const matchedSoIds: string[] = [];
      for (const so of sos) {
        const raw = Array.isArray(so.lineItems)
          ? (so.lineItems as Record<string, unknown>[])
          : [];
        let matchedAny = false;
        for (const li of raw) {
          const m = byNorm.get(normalizeCode(String(li.sku ?? "")));
          if (!m) continue;
          const q = Number(li.quantity ?? 0);
          if (!(q > 0)) continue;
          bump(m.id, q, m.uom);
          matchedAny = true;
        }
        // Consume the SO either way once seen — an SO with zero matchable
        // lines would otherwise re-appear on every Generate forever.
        matchedSoIds.push(String(so.zohoSoId));
        void matchedAny;
      }
      for (const ml of manualLines) bump(ml.skuId, ml.qty, ml.uom);

      const lines = [...agg.entries()];
      const isEmpty = lines.length === 0;

      const [list] = await tx
        .insert(pickList)
        .values({
          businessDate,
          status: isEmpty ? "COMPLETED" : "OPEN",
          createdByUserId: s.uid,
          clientToken,
          note: isEmpty ? "No open orders to pick" : null,
          completedAt: isEmpty ? new Date() : null,
          completedByUserId: isEmpty ? s.uid : null,
        })
        .returning({ id: pickList.id });

      for (const [skuId, v] of lines) {
        await tx.insert(pickListLine).values({
          pickListId: list.id,
          skuId,
          qtyToPick: qtyStr(v.qty),
          uom: v.uom as never,
        });
      }
      for (const soId of matchedSoIds) {
        await tx
          .insert(pickListSource)
          .values({ pickListId: list.id, sourceType: "ZOHO_SO", zohoSoId: soId });
      }
      for (const mId of manualIds) {
        await tx
          .insert(pickListSource)
          .values({ pickListId: list.id, sourceType: "MANUAL_ORDER", manualOrderDocId: mId });
      }

      revalidatePath("/pick-list");
      revalidatePath("/assembly");
      revalidatePath("/dispatch");
      return {
        ok: true as const,
        pickListId: list.id as number,
        lineCount: lines.length,
        empty: isEmpty,
      };
    });
  } catch (e) {
    return fail(e);
  }
}

const ProgressSchema = z.object({
  pickListId: z.number().int(),
  lineId: z.number().int(),
  qtyPicked: z.union([z.string(), z.number()]).transform((v) => qtyStr(v)),
});

/** Update one line's picked qty (bounded 0..toPick). Only while OPEN. */
export async function updatePickProgress(
  input: z.input<typeof ProgressSchema>,
): Promise<PickActionResult> {
  await requireUser();
  const p = ProgressSchema.parse(input);
  try {
    return await db.transaction(async (tx: Tx) => {
      const [list] = await tx
        .select({ status: pickList.status })
        .from(pickList)
        .where(eq(pickList.id, p.pickListId));
      if (!list) throw new Error("Pick list not found.");
      if (list.status !== "OPEN") throw new Error("This pick list is no longer open.");
      const [line] = await tx
        .select({ toPick: pickListLine.qtyToPick })
        .from(pickListLine)
        .where(and(eq(pickListLine.id, p.lineId), eq(pickListLine.pickListId, p.pickListId)));
      if (!line) throw new Error("Pick list line not found.");
      if (D(p.qtyPicked).lt(0) || D(p.qtyPicked).gt(D(line.toPick)))
        throw new Error(`Picked qty must be between 0 and ${line.toPick}.`);
      await tx
        .update(pickListLine)
        .set({ qtyPicked: p.qtyPicked })
        .where(eq(pickListLine.id, p.lineId));
      revalidatePath("/pick-list");
      return { ok: true as const, pickListId: p.pickListId, lineCount: 1 };
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Complete the pick list. Fully picked → any role. Short (any line under its
 * target) → SUPERVISOR+ with a mandatory reason that surfaces on the Summary.
 */
export async function completePickList(
  pickListId: number,
  opts?: { shortReason?: string },
): Promise<PickActionResult> {
  const s = await requireUser();
  try {
    return await db.transaction(async (tx: Tx) => {
      const [list] = await tx
        .select({ status: pickList.status })
        .from(pickList)
        .where(eq(pickList.id, pickListId));
      if (!list) throw new Error("Pick list not found.");
      if (list.status !== "OPEN") throw new Error("This pick list is not open.");
      const lines = await tx
        .select({ toPick: pickListLine.qtyToPick, picked: pickListLine.qtyPicked })
        .from(pickListLine)
        .where(eq(pickListLine.pickListId, pickListId));
      const fullyPicked = lines.every(
        (l: { toPick: string; picked: string }) => gte(l.picked, l.toPick),
      );
      let shortReason: string | null = null;
      if (!fullyPicked) {
        await requireSupervisor(); // escalate: short-complete is supervised
        const left = sumQty(
          lines.map((l: { toPick: string; picked: string }) => {
            const d = D(l.toPick).minus(D(l.picked));
            return d.gt(0) ? d : D(0);
          }),
        );
        if (!opts?.shortReason || opts.shortReason.trim().length < 3)
          throw new Error(
            `Still ${qtyStr(left)} left to pick. A supervisor must give a reason to complete short.`,
          );
        shortReason = opts.shortReason.trim();
      }
      await tx
        .update(pickList)
        .set({
          status: "COMPLETED",
          completedAt: new Date(),
          completedByUserId: s.uid,
          shortCompleteReason: shortReason,
        })
        .where(eq(pickList.id, pickListId));
      revalidatePath("/pick-list");
      revalidatePath("/assembly");
      revalidatePath("/dispatch");
      return { ok: true as const, pickListId, lineCount: lines.length };
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Cancel an open pick list (SUPERVISOR+). Its source orders are released so
 * the next Generate picks them up again.
 */
export async function cancelPickList(
  pickListId: number,
  reason: string,
): Promise<PickActionResult> {
  await requireSupervisor();
  if (!reason || reason.trim().length < 3)
    return { ok: false, error: "A cancel reason is required." };
  try {
    return await db.transaction(async (tx: Tx) => {
      const [list] = await tx
        .select({ status: pickList.status })
        .from(pickList)
        .where(eq(pickList.id, pickListId));
      if (!list) throw new Error("Pick list not found.");
      if (list.status !== "OPEN") throw new Error("Only an open pick list can be cancelled.");
      // release sources so the orders feed the next generation
      await tx.delete(pickListSource).where(eq(pickListSource.pickListId, pickListId));
      await tx
        .update(pickList)
        .set({ status: "CANCELLED", note: `cancelled: ${reason.trim()}` })
        .where(eq(pickList.id, pickListId));
      revalidatePath("/pick-list");
      revalidatePath("/assembly");
      revalidatePath("/dispatch");
      return { ok: true as const, pickListId, lineCount: 0 };
    });
  } catch (e) {
    return fail(e);
  }
}
