"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { poDraftDoc, poDraftLine, appAuditLog, zohoPoCache } from "@/lib/db/schema";
import type { Tx } from "@/lib/ledger/post";
import { requireManager } from "@/lib/auth/rbac";
import { istToday } from "@/lib/workflow";
import { qtyStr } from "@/lib/money";
import { zohoConfig } from "@/lib/zoho/config";
import { zohoGet } from "@/lib/zoho/client";
import { zohoWrite } from "@/lib/zoho/write";
import { pushToZoho } from "./zoho-drafts";

export type PoActionResult =
  | { ok: true; docId: number; zohoPoId?: string }
  | { ok: false; error: string };

const PoDraftSchema = z.object({
  docId: z.number().int().optional(), // present = update the local draft
  clientToken: z.string().min(8).optional(),
  vendorZohoId: z.string().min(1, "Pick a vendor"),
  vendorName: z.string().optional(),
  deliveryDate: z.string().optional(),
  note: z.string().optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int(),
        qty: z.union([z.string(), z.number()]).transform((v) => qtyStr(v)),
        rate: z.union([z.string(), z.number()]).optional(),
        uom: z.enum(["kg", "g", "pc", "box", "bunch", "unit"]).default("kg"),
      }),
    )
    .min(1),
});

/**
 * Save (create or update) Aniket's local PO draft. Local lines are replaced
 * wholesale — the draft is a scratchpad until pushed; once pushed to Zoho the
 * edit screen works against the live Zoho PO instead.
 */
export async function savePoDraft(
  input: z.input<typeof PoDraftSchema>,
): Promise<PoActionResult> {
  const s = await requireManager();
  const p = PoDraftSchema.parse(input);
  try {
    const docId = await db.transaction(async (tx: Tx) => {
      let id = p.docId;
      if (id) {
        const [doc] = await tx
          .select({ zohoPoId: poDraftDoc.zohoPoId })
          .from(poDraftDoc)
          .where(eq(poDraftDoc.id, id));
        if (!doc) throw new Error("PO draft not found.");
        if (doc.zohoPoId)
          throw new Error("Already pushed to Zoho — edit the live PO instead.");
        await tx
          .update(poDraftDoc)
          .set({
            vendorZohoId: p.vendorZohoId,
            vendorName: p.vendorName,
            deliveryDate: p.deliveryDate ?? null,
            note: p.note,
          })
          .where(eq(poDraftDoc.id, id));
        await tx.delete(poDraftLine).where(eq(poDraftLine.docId, id));
      } else {
        if (p.clientToken) {
          const ex = await tx
            .select({ id: poDraftDoc.id })
            .from(poDraftDoc)
            .where(eq(poDraftDoc.clientToken, p.clientToken));
          if (ex[0]) return ex[0].id as number;
        }
        const [doc] = await tx
          .insert(poDraftDoc)
          .values({
            vendorZohoId: p.vendorZohoId,
            vendorName: p.vendorName,
            deliveryDate: p.deliveryDate ?? null,
            businessDate: istToday(),
            note: p.note,
            clientToken: p.clientToken,
            createdByUserId: s.uid,
            docStatus: "POSTED", // a saved draft is immediately reviewable/pushable
          })
          .returning({ id: poDraftDoc.id });
        id = doc.id as number;
      }
      for (const ln of p.lines) {
        await tx.insert(poDraftLine).values({
          docId: id!,
          skuId: ln.skuId,
          qty: ln.qty,
          rate: ln.rate != null ? String(ln.rate) : null,
          uom: ln.uom,
        });
      }
      return id!;
    });
    revalidatePath("/purchase-orders");
    revalidatePath("/review");
    return { ok: true, docId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Push a local PO draft to Zoho as a DRAFT Purchase Order (MANAGER). */
export async function pushPoDraft(docId: number): Promise<PoActionResult> {
  await requireManager();
  const res = await pushToZoho("podraft.create", docId);
  if (!res.ok) return res;
  const first = res.results[0];
  if (!first?.ok) return { ok: false, error: first?.error ?? "Push failed." };
  if (first.zohoId && !first.alreadyExisted) {
    await db
      .update(poDraftDoc)
      .set({ zohoPoId: first.zohoId, pushStatus: "PUSHED" })
      .where(eq(poDraftDoc.id, docId));
  }
  revalidatePath("/purchase-orders");
  revalidatePath("/review");
  return { ok: true, docId, zohoPoId: first.zohoId };
}

const PoUpdateSchema = z.object({
  zohoPoId: z.string().min(1),
  deliveryDate: z.string().optional(),
  /** line_item_id → new quantity (only changed lines need be sent) */
  lines: z
    .array(
      z.object({
        lineItemId: z.string().min(1),
        quantity: z.union([z.string(), z.number()]).transform((v) => Number(v)),
      }),
    )
    .min(0),
});

/**
 * Edit a live Zoho PO (MANAGER): quantity per line and/or delivery date.
 * Sends the FULL current line set with edits applied (a partial line_items
 * array would delete the missing lines in Zoho). Always audited with
 * before/after; never deduped — edits legitimately repeat. The local PO cache
 * row is refreshed immediately so the receiving sheet reflects the change.
 */
export async function updateZohoPo(
  input: z.input<typeof PoUpdateSchema>,
): Promise<PoActionResult> {
  const s = await requireManager();
  const p = PoUpdateSchema.parse(input);
  if (!zohoConfig.enabled) return { ok: false, error: "Zoho is not configured." };
  try {
    type PoDetail = {
      purchaseorder?: {
        line_items?: {
          line_item_id: string;
          item_id: string;
          quantity: number;
          rate?: number;
        }[];
        delivery_date?: string;
        status?: string;
      };
    };
    const before = await zohoGet<PoDetail>(
      `${zohoConfig.inventoryBase}/purchaseorders/${p.zohoPoId}`,
    );
    const current = before.purchaseorder?.line_items ?? [];
    if (!current.length) throw new Error("Zoho PO has no lines to edit.");
    const editByLine = new Map(p.lines.map((l) => [l.lineItemId, l.quantity]));
    const line_items = current.map((li) => ({
      line_item_id: li.line_item_id,
      item_id: li.item_id,
      quantity: editByLine.get(li.line_item_id) ?? li.quantity,
      ...(li.rate != null ? { rate: li.rate } : {}),
    }));

    await zohoWrite("PUT", `${zohoConfig.inventoryBase}/purchaseorders/${p.zohoPoId}`, {
      line_items,
      ...(p.deliveryDate ? { delivery_date: p.deliveryDate } : {}),
    });

    await db.insert(appAuditLog).values({
      userId: s.uid,
      action: `ZOHO_PUSH:po.update:${p.zohoPoId}`,
      docType: "PURCHASE_ORDER",
      docId: 0,
      payload: {
        zohoPoId: p.zohoPoId,
        before: current.map((l) => ({ line_item_id: l.line_item_id, quantity: l.quantity })),
        after: line_items.map((l) => ({ line_item_id: l.line_item_id, quantity: l.quantity })),
        deliveryDate: p.deliveryDate,
      },
    });

    // refresh the single PO in the local cache so Receiving sees it now
    const after = await zohoGet<PoDetail>(
      `${zohoConfig.inventoryBase}/purchaseorders/${p.zohoPoId}`,
    );
    if (after.purchaseorder) {
      await db
        .update(zohoPoCache)
        .set({ lineItems: after.purchaseorder.line_items ?? null, fetchedAt: new Date() })
        .where(eq(zohoPoCache.zohoPoId, p.zohoPoId));
    }

    revalidatePath("/purchase-orders");
    revalidatePath("/receiving");
    return { ok: true, docId: 0, zohoPoId: p.zohoPoId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
