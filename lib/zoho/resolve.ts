import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { receivingDoc } from "@/lib/db/schema";
import { zohoConfig } from "./config";
import { zohoGet, zohoPaged } from "./client";
import type { PushRow } from "./push-state";

/**
 * UNKNOWN-outcome reconciler: search Zoho (read-only) for the idem_ref that
 * was stamped into the payload, per kind. Returns found+ids when the write
 * actually landed, found:false when Zoho provably doesn't have it. Throws on
 * lookup trouble — the row then stays UNKNOWN rather than guessing.
 */
export type ResolveOutcome =
  | { found: true; zohoId: string; zohoNumber?: string }
  | { found: false };

export async function resolveInZoho(row: PushRow): Promise<ResolveOutcome> {
  const ref = row.idemRef;
  if (!ref) throw new Error("No idem_ref recorded on this push — cannot reconcile automatically.");
  switch (row.kind) {
    case "receiving.receive":
      return resolveReceive(row.docId, ref);
    case "receiving.bill":
      return resolveBill(ref);
    case "wastage.adj":
    case "adjustment.adj":
      return resolveAdjustment(ref);
    case "assembly.bundle":
      return resolveBundle(ref);
    case "podraft.create":
      return resolvePoDraft(ref);
    default:
      throw new Error(`No reconciler wired for push kind "${row.kind}".`);
  }
}

/** The PO detail carries its receives; notes hold our token. Summary entries
 *  may omit notes, so fetch each receive's detail (a PO has very few). */
async function resolveReceive(docId: number, ref: string): Promise<ResolveOutcome> {
  const [doc] = await db
    .select({ zohoPoId: receivingDoc.zohoPoId })
    .from(receivingDoc)
    .where(eq(receivingDoc.id, docId));
  if (!doc?.zohoPoId) throw new Error("Receiving doc has no Zoho PO — cannot reconcile.");
  const detail = await zohoGet<{
    purchaseorder?: {
      purchasereceives?: { receive_id?: string; purchasereceive_id?: string; receive_number?: string; notes?: string }[];
    };
  }>(`${zohoConfig.inventoryBase}/purchaseorders/${doc.zohoPoId}`);
  const receives = detail.purchaseorder?.purchasereceives ?? [];
  for (const r of receives.slice(0, 10)) {
    const id = String(r.purchasereceive_id ?? r.receive_id ?? "");
    if (!id) continue;
    let notes = r.notes;
    if (notes == null) {
      try {
        const rd = await zohoGet<{ purchasereceive?: { notes?: string } }>(
          `${zohoConfig.inventoryBase}/purchasereceives/${id}`,
        );
        notes = rd.purchasereceive?.notes ?? "";
      } catch {
        notes = "";
      }
    }
    if (notes.includes(ref)) {
      return { found: true, zohoId: id, zohoNumber: r.receive_number };
    }
  }
  return { found: false };
}

async function resolveBill(ref: string): Promise<ResolveOutcome> {
  const res = await zohoGet<{
    bills?: { bill_id: string; bill_number?: string; reference_number?: string }[];
  }>(`${zohoConfig.booksBase}/bills?reference_number=${encodeURIComponent(ref)}`);
  const hit = (res.bills ?? []).find((b) => b.reference_number === ref);
  return hit ? { found: true, zohoId: String(hit.bill_id), zohoNumber: hit.bill_number } : { found: false };
}

async function resolveAdjustment(ref: string): Promise<ResolveOutcome> {
  // The list endpoint may ignore an unknown filter param — always verify
  // client-side; scan up to 3 pages of the most recent adjustments.
  const rows = await zohoPaged<{
    inventory_adjustment_id: string;
    reference_number?: string;
  }>(
    `${zohoConfig.inventoryBase}/inventoryadjustments`,
    "inventory_adjustments",
    { reference_number: ref, sort_column: "date", sort_order: "D" },
    3,
  );
  const hit = rows.find((a) => a.reference_number === ref);
  return hit
    ? { found: true, zohoId: String(hit.inventory_adjustment_id), zohoNumber: hit.reference_number }
    : { found: false };
}

async function resolveBundle(ref: string): Promise<ResolveOutcome> {
  const rows = await zohoPaged<{
    bundle_id: string;
    reference_number?: string;
    bundle_number?: string;
  }>(
    `${zohoConfig.inventoryBase}/bundles`,
    "bundles",
    { sort_column: "date", sort_order: "D" },
    3,
  );
  const hit = rows.find((b) => b.reference_number === ref);
  return hit
    ? { found: true, zohoId: String(hit.bundle_id), zohoNumber: hit.bundle_number ?? hit.reference_number }
    : { found: false };
}

async function resolvePoDraft(ref: string): Promise<ResolveOutcome> {
  const rows = await zohoPaged<{
    purchaseorder_id: string;
    purchaseorder_number?: string;
    reference_number?: string;
  }>(
    `${zohoConfig.inventoryBase}/purchaseorders`,
    "purchaseorders",
    { reference_number: ref, sort_column: "date", sort_order: "D" },
    3,
  );
  const hit = rows.find((p) => p.reference_number === ref);
  return hit
    ? { found: true, zohoId: String(hit.purchaseorder_id), zohoNumber: hit.purchaseorder_number }
    : { found: false };
}
