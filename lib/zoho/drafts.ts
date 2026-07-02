import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invAdjustmentDoc, invAdjustmentLine, skus } from "@/lib/db/schema";
import { zohoConfig } from "./config";

/** Doc types that have a "Push draft to Zoho" button. */
export type PushableDocType =
  | "RECEIVING"
  | "ASSEMBLY"
  | "INV_ADJUSTMENT"
  | "WASTAGE"
  | "RETURN";

/** A ready-to-send Zoho draft request: endpoint + JSON body + a module label. */
export type DraftRequest = { url: string; body: unknown; module: string };

/** Thrown when a tab's Zoho mapping hasn't been wired/verified yet. */
export class NotMappedError extends Error {
  constructor(docType: string) {
    super(
      `Zoho draft mapping for ${docType} isn't set up yet — tell me the Zoho module + fields and I'll wire it.`,
    );
    this.name = "NotMappedError";
  }
}

type Builder = (docId: number) => Promise<DraftRequest>;

/**
 * Inventory Adjustment → Zoho Inventory Adjustment (the first wired mapping).
 * NOTE: whether Zoho keeps this as a draft vs. applies it immediately is the key
 * thing to confirm during testing; field names below are a first pass and will
 * be refined against the live API.
 */
const buildInventoryAdjustment: Builder = async (docId) => {
  const [doc] = await db
    .select()
    .from(invAdjustmentDoc)
    .where(eq(invAdjustmentDoc.id, docId));
  if (!doc) throw new Error(`Inventory adjustment #${docId} not found.`);

  const lines = await db
    .select({
      qtyToAdjust: invAdjustmentLine.qtyToAdjust,
      reason: invAdjustmentLine.reason,
      zohoItemId: skus.zohoItemId,
      code: skus.code,
    })
    .from(invAdjustmentLine)
    .innerJoin(skus, eq(skus.id, invAdjustmentLine.skuId))
    .where(eq(invAdjustmentLine.docId, docId));

  const usable = lines.filter((l) => l.zohoItemId);
  if (usable.length === 0) {
    const skipped = lines.map((l) => l.code).join(", ");
    throw new Error(
      `No lines are linked to a Zoho item id (${skipped}). Sync Items from Zoho first so SKUs link up.`,
    );
  }

  const body = {
    date: doc.businessDate,
    reason: doc.against || "EAT inventory adjustment",
    description: doc.note ?? undefined,
    adjustment_type: "quantity",
    line_items: usable.map((l) => ({
      item_id: l.zohoItemId,
      quantity_adjusted: Number(l.qtyToAdjust),
      description: l.reason ?? undefined,
    })),
  };

  return {
    url: `${zohoConfig.inventoryBase}/inventoryadjustments`,
    body,
    module: "inventory_adjustment",
  };
};

/** Per-tab draft builders. Unwired tabs throw NotMappedError until specified. */
export const DRAFT_BUILDERS: Record<PushableDocType, Builder> = {
  INV_ADJUSTMENT: buildInventoryAdjustment,
  RECEIVING: async () => {
    throw new NotMappedError("RECEIVING");
  },
  ASSEMBLY: async () => {
    throw new NotMappedError("ASSEMBLY");
  },
  WASTAGE: async () => {
    throw new NotMappedError("WASTAGE");
  },
  RETURN: async () => {
    throw new NotMappedError("RETURN");
  },
};
