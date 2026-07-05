import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assemblyDoc,
  assemblyLine,
  invAdjustmentDoc,
  invAdjustmentLine,
  poDraftDoc,
  poDraftLine,
  receivingDoc,
  receivingLine,
  skus,
  wastageDoc,
  wastageLine,
  zohoPoCache,
} from "@/lib/db/schema";
import { zohoConfig } from "./config";
import { zohoGet } from "./client";
import type { ZohoPushKind } from "./labels";
import { D, qtyStr, sub } from "@/lib/money";

/** One HTTP write to perform. `subKey` makes multi-request pushes (bundles)
 *  individually idempotent in zoho_push. `idemRef` is the reference stamped
 *  into the payload so an ambiguous outcome can be reconciled by searching
 *  Zoho for it. The response contract (`responseKey`/`idKeys`/`numberKeys`)
 *  replaces the old scan-anything id heuristic. */
export type PushRequest = {
  subKey: string; // "doc" for single-request pushes, "line:<id>" for bundles
  method: "POST" | "PUT";
  url: string;
  body: unknown;
  summary: string; // human line for the Review queue / audit payload
  /** Idempotency reference embedded in the payload (reference_number or notes). */
  idemRef: string;
  /** Wrapper object key in Zoho's create response, e.g. "bill". */
  responseKey: string;
  /** Id fields to try inside the wrapper, in order. */
  idKeys: string[];
  /** Human document-number fields to try inside the wrapper, in order. */
  numberKeys: string[];
};
export type PushPlan = { kind: ZohoPushKind; requests: PushRequest[] };

/** Pull the Zoho id / human number out of a create response via the request's
 *  declared contract. Falls back to scanning the wrapper for any `*_id` only
 *  if the declared keys miss (response-shape drift shouldn't lose the id). */
export function extractByContract(
  req: Pick<PushRequest, "responseKey" | "idKeys" | "numberKeys">,
  res: Record<string, unknown>,
): { zohoId: string; zohoNumber?: string } {
  const wrapper = res[req.responseKey];
  const rec =
    wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)
      ? (wrapper as Record<string, unknown>)
      : firstObjectValue(res);
  if (!rec) return { zohoId: "" };
  let zohoId = "";
  for (const k of req.idKeys) {
    if (rec[k] != null) {
      zohoId = String(rec[k]);
      break;
    }
  }
  if (!zohoId) {
    for (const [k, v] of Object.entries(rec)) {
      if (k.endsWith("_id") && (typeof v === "string" || typeof v === "number")) {
        zohoId = String(v);
        break;
      }
    }
  }
  let zohoNumber: string | undefined;
  for (const k of req.numberKeys) {
    if (rec[k] != null) {
      zohoNumber = String(rec[k]);
      break;
    }
  }
  return { zohoId, zohoNumber };
}

function firstObjectValue(res: Record<string, unknown>): Record<string, unknown> | null {
  for (const [k, v] of Object.entries(res)) {
    if (k === "code" || k === "message") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return null;
}

export class NotMappedError extends Error {
  constructor(what: string) {
    super(`Zoho mapping for ${what} isn't wired yet.`);
    this.name = "NotMappedError";
  }
}

/** S1 free-leftover receipt lines are excluded from receives/bills — their
 *  quantity reaches Zoho via the linked ₹0 inventory adjustment instead. */
const S1_FREE_NOTE = "S1: free leftover";

async function loadPostedReceiving(docId: number) {
  const [doc] = await db.select().from(receivingDoc).where(eq(receivingDoc.id, docId));
  if (!doc) throw new Error(`Receiving #${docId} not found.`);
  if (doc.docStatus !== "POSTED") throw new Error(`Receiving #${docId} is not posted.`);
  const lines = await db
    .select({
      id: receivingLine.id,
      skuId: receivingLine.skuId,
      acceptedQty: receivingLine.acceptedQty,
      notes: receivingLine.notes,
      code: skus.code,
      zohoItemId: skus.zohoItemId,
    })
    .from(receivingLine)
    .innerJoin(skus, eq(skus.id, receivingLine.skuId))
    .where(eq(receivingLine.docId, docId));
  const billable = lines.filter((l) => !(l.notes ?? "").startsWith(S1_FREE_NOTE));
  return { doc, billable };
}

/**
 * RECEIVING → Zoho Purchase Receive (live). Requires the doc to be against a
 * Zoho PO; the PO detail is fetched live to map item_id → line_item_id.
 * Quantities follow the variance rules: S4 lines already store the full bill
 * qty; S1 free lines are excluded (they go via the ₹0 adjustment).
 */
async function buildPurchaseReceive(docId: number): Promise<PushPlan> {
  const { doc, billable } = await loadPostedReceiving(docId);
  if (!doc.zohoPoId)
    throw new Error(
      "This receiving has no Zoho PO. Off-PO receipts go to Zoho as an inventory adjustment (push the linked adjustment instead).",
    );
  const missing = billable.filter((l) => !l.zohoItemId).map((l) => l.code);
  if (missing.length)
    throw new Error(
      `These SKUs aren't linked to Zoho items yet (run Items sync): ${missing.join(", ")}`,
    );

  const detail = await zohoGet<{
    purchaseorder?: { line_items?: { line_item_id: string; item_id: string }[] };
  }>(`${zohoConfig.inventoryBase}/purchaseorders/${doc.zohoPoId}`);
  const poLines = detail.purchaseorder?.line_items ?? [];
  const lineItemByItem = new Map(poLines.map((l) => [String(l.item_id), String(l.line_item_id)]));

  const items: { line_item_id: string; quantity: number }[] = [];
  for (const l of billable) {
    const li = lineItemByItem.get(String(l.zohoItemId));
    if (!li)
      throw new Error(
        `${l.code} is not on Zoho PO ${doc.poNo ?? doc.zohoPoId} — Zoho can't receive it against this PO.`,
      );
    items.push({ line_item_id: li, quantity: Number(l.acceptedQty) });
  }
  if (!items.length) throw new Error("No billable lines to receive.");

  // Purchase receives have no reference_number field — the idem token leads
  // the notes instead; the reconciler scans this PO's receives for it.
  const idemRef = `EAT-RCV-${doc.id}`;
  return {
    kind: "receiving.receive",
    requests: [
      {
        subKey: "doc",
        method: "POST",
        url: `${zohoConfig.inventoryBase}/purchasereceives?purchaseorder_id=${doc.zohoPoId}`,
        body: {
          date: doc.businessDate,
          line_items: items,
          notes: `${idemRef} — EAT receiving #${doc.id}${doc.varianceNote ? ` — ${doc.varianceNote}` : ""}`,
        },
        summary: `Receive ${items.length} line(s) against PO ${doc.poNo ?? doc.zohoPoId}`,
        idemRef,
        responseKey: "purchasereceive",
        idKeys: ["purchasereceive_id", "receive_id"],
        numberKeys: ["receive_number"],
      },
    ],
  };
}

/**
 * RECEIVING → Zoho Books Bill (live). Bill quantities = the billable receipt
 * lines (S4 already stores full bill qty; S1 free lines excluded). Rate comes
 * from the cached Zoho PO line when available.
 */
async function buildBill(docId: number): Promise<PushPlan> {
  const { doc, billable } = await loadPostedReceiving(docId);
  if (!doc.zohoPoId)
    throw new Error("This receiving has no Zoho PO — create the bill manually in Zoho Books.");
  const [po] = await db
    .select()
    .from(zohoPoCache)
    .where(eq(zohoPoCache.zohoPoId, doc.zohoPoId));
  const vendorId = po?.vendorZohoId;
  if (!vendorId)
    throw new Error(
      "The PO's vendor isn't in the local cache (run POs sync) — cannot address the bill.",
    );
  const missing = billable.filter((l) => !l.zohoItemId).map((l) => l.code);
  if (missing.length)
    throw new Error(
      `These SKUs aren't linked to Zoho items yet (run Items sync): ${missing.join(", ")}`,
    );

  const rateByItem = new Map<string, number>();
  if (Array.isArray(po?.lineItems)) {
    for (const li of po.lineItems as Record<string, unknown>[]) {
      if (li.item_id != null && li.rate != null)
        rateByItem.set(String(li.item_id), Number(li.rate));
    }
  }

  const line_items = billable.map((l) => {
    const rate = rateByItem.get(String(l.zohoItemId));
    return {
      item_id: l.zohoItemId!,
      quantity: Number(l.acceptedQty),
      ...(rate != null ? { rate } : {}),
    };
  });
  if (!line_items.length) throw new Error("No billable lines for this receiving.");

  const idemRef = `EAT-RCV-${doc.id}`;
  return {
    kind: "receiving.bill",
    requests: [
      {
        subKey: "doc",
        method: "POST",
        url: `${zohoConfig.booksBase}/bills`,
        body: {
          vendor_id: vendorId,
          date: doc.businessDate,
          purchaseorder_ids: [doc.zohoPoId],
          reference_number: idemRef,
          line_items,
          notes: doc.varianceNote ?? undefined,
        },
        summary: `Bill ${line_items.length} line(s) to ${po?.vendorName ?? "vendor"} for PO ${doc.poNo ?? doc.zohoPoId}`,
        idemRef,
        responseKey: "bill",
        idKeys: ["bill_id"],
        numberKeys: ["bill_number"],
      },
    ],
  };
}

/** Shared: wastage/adjustment docs → Zoho Inventory Adjustment (live). */
function adjustmentRequest(args: {
  kind: "wastage.adj" | "adjustment.adj";
  idemRef: string;
  date: string;
  reason: string;
  description?: string;
  lines: { item_id: string; qty: number; description?: string }[];
  summary: string;
}): PushPlan {
  return {
    kind: args.kind,
    requests: [
      {
        subKey: "doc",
        method: "POST",
        url: `${zohoConfig.inventoryBase}/inventoryadjustments`,
        body: {
          date: args.date,
          reason: args.reason.slice(0, 50) || "EAT adjustment",
          description: args.description,
          reference_number: args.idemRef,
          adjustment_type: "quantity",
          line_items: args.lines.map((l) => ({
            item_id: l.item_id,
            quantity_adjusted: l.qty,
            description: l.description,
          })),
        },
        summary: args.summary,
        idemRef: args.idemRef,
        responseKey: "inventory_adjustment",
        idKeys: ["inventory_adjustment_id"],
        numberKeys: ["reference_number"],
      },
    ],
  };
}

/** WASTAGE → negative Zoho Inventory Adjustment. */
async function buildWastageAdjustment(docId: number): Promise<PushPlan> {
  const [doc] = await db.select().from(wastageDoc).where(eq(wastageDoc.id, docId));
  if (!doc) throw new Error(`Wastage #${docId} not found.`);
  if (doc.docStatus !== "POSTED") throw new Error(`Wastage #${docId} is not posted.`);
  const lines = await db
    .select({
      qty: wastageLine.qty,
      reason: wastageLine.reason,
      source: wastageLine.source,
      code: skus.code,
      zohoItemId: skus.zohoItemId,
    })
    .from(wastageLine)
    .innerJoin(skus, eq(skus.id, wastageLine.skuId))
    .where(eq(wastageLine.docId, docId));
  const usable = lines.filter((l) => l.zohoItemId);
  if (!usable.length)
    throw new Error(
      `No lines linked to Zoho items (${lines.map((l) => l.code).join(", ")}). Run Items sync.`,
    );
  return adjustmentRequest({
    kind: "wastage.adj",
    idemRef: `EAT-WST-${doc.id}`,
    date: String(doc.businessDate),
    reason: `EAT wastage (${usable[0].source})`,
    description: doc.note ?? undefined,
    lines: usable.map((l) => ({
      item_id: l.zohoItemId!,
      qty: -Math.abs(Number(l.qty)),
      description: l.reason,
    })),
    summary: `Waste out ${usable.length} line(s), source ${usable[0].source}`,
  });
}

/** INV_ADJUSTMENT → Zoho Inventory Adjustment (skips zero-qty tie-out lines). */
async function buildInventoryAdjustment(docId: number): Promise<PushPlan> {
  const [doc] = await db
    .select()
    .from(invAdjustmentDoc)
    .where(eq(invAdjustmentDoc.id, docId));
  if (!doc) throw new Error(`Inventory adjustment #${docId} not found.`);
  if (doc.docStatus !== "POSTED") throw new Error(`Adjustment #${docId} is not posted.`);
  const lines = await db
    .select({
      qtyToAdjust: invAdjustmentLine.qtyToAdjust,
      reason: invAdjustmentLine.reason,
      code: skus.code,
      zohoItemId: skus.zohoItemId,
    })
    .from(invAdjustmentLine)
    .innerJoin(skus, eq(skus.id, invAdjustmentLine.skuId))
    .where(eq(invAdjustmentLine.docId, docId));
  const usable = lines.filter((l) => l.zohoItemId && !D(l.qtyToAdjust).isZero());
  if (!usable.length)
    throw new Error(
      "Nothing to adjust in Zoho (no non-zero lines linked to Zoho items).",
    );
  return adjustmentRequest({
    kind: "adjustment.adj",
    idemRef: `EAT-ADJ-${doc.id}`,
    date: String(doc.businessDate),
    reason: doc.against || "EAT inventory adjustment",
    description: doc.note ?? undefined,
    lines: usable.map((l) => ({
      item_id: l.zohoItemId!,
      qty: Number(l.qtyToAdjust),
      description: l.reason ?? undefined,
    })),
    summary: `Adjust ${usable.length} line(s) (${doc.against ?? "manual"})`,
  });
}

/**
 * ASSEMBLY → one Zoho Bundle per line (live). Pre-flights that the pack SKU is
 * a composite item in Zoho. quantity_consumed = used − waste (the waste share
 * goes to Zoho via the linked wastage adjustment so nothing double-deducts).
 */
async function buildBundles(docId: number): Promise<PushPlan> {
  const [doc] = await db.select().from(assemblyDoc).where(eq(assemblyDoc.id, docId));
  if (!doc) throw new Error(`Assembly #${docId} not found.`);
  if (doc.docStatus !== "POSTED") throw new Error(`Assembly #${docId} is not posted.`);
  const lines = await db
    .select({
      id: assemblyLine.id,
      packsMade: assemblyLine.packsMade,
      totalUsed: assemblyLine.totalUsed,
      qtyWaste: assemblyLine.qtyWaste,
      motherSkuId: assemblyLine.motherSkuId,
      packZohoItemId: skus.zohoItemId,
      packCode: skus.code,
    })
    .from(assemblyLine)
    .innerJoin(skus, eq(skus.id, assemblyLine.packSkuId))
    .where(eq(assemblyLine.docId, docId));
  if (!lines.length) throw new Error("Assembly has no lines.");

  // mother zoho ids in one shot
  const motherRows = await db
    .select({ id: skus.id, zohoItemId: skus.zohoItemId, code: skus.code })
    .from(skus);
  const motherById = new Map(motherRows.map((m) => [m.id, m]));

  const requests: PushRequest[] = [];
  for (const l of lines) {
    const m = motherById.get(l.motherSkuId);
    if (!l.packZohoItemId)
      throw new Error(`${l.packCode} isn't linked to a Zoho item (run Items sync).`);
    if (!m?.zohoItemId)
      throw new Error(`${m?.code ?? `sku ${l.motherSkuId}`} isn't linked to a Zoho item.`);

    // Pre-flight: the pack must be a composite item in Zoho for bundling.
    try {
      await zohoGet(`${zohoConfig.inventoryBase}/compositeitems/${l.packZohoItemId}`);
    } catch {
      throw new Error(
        `${l.packCode} is not a composite item in Zoho — a bundle can't be created. Make it a composite item in Zoho Inventory first.`,
      );
    }

    const consumed = qtyStr(sub(l.totalUsed, l.qtyWaste));
    // Per-line reference so each bundle sub-push reconciles independently.
    const idemRef = `EAT-ASM-${doc.id}-L${l.id}`;
    requests.push({
      subKey: `line:${l.id}`,
      method: "POST",
      url: `${zohoConfig.inventoryBase}/bundles`,
      body: {
        composite_item_id: l.packZohoItemId,
        date: doc.businessDate,
        quantity_to_bundle: Number(l.packsMade),
        reference_number: idemRef,
        line_items: [
          { item_id: m.zohoItemId, quantity_consumed: Number(consumed) },
        ],
        is_completed: true,
      },
      summary: `Bundle ${l.packsMade} × ${l.packCode} (consume ${consumed} of ${m.code})`,
      idemRef,
      responseKey: "bundle",
      idKeys: ["bundle_id"],
      numberKeys: ["bundle_number", "reference_number"],
    });
  }
  return { kind: "assembly.bundle", requests };
}

/** PO_DRAFT → Zoho Purchase Order (created in DRAFT status by default). */
async function buildPoDraftCreate(docId: number): Promise<PushPlan> {
  const [doc] = await db.select().from(poDraftDoc).where(eq(poDraftDoc.id, docId));
  if (!doc) throw new Error(`PO draft #${docId} not found.`);
  if (doc.zohoPoId)
    throw new Error(`Already pushed to Zoho as PO ${doc.zohoPoId} — edit that PO instead.`);
  if (!doc.vendorZohoId) throw new Error("Pick a vendor before pushing.");
  const lines = await db
    .select({
      qty: poDraftLine.qty,
      rate: poDraftLine.rate,
      code: skus.code,
      zohoItemId: skus.zohoItemId,
    })
    .from(poDraftLine)
    .innerJoin(skus, eq(skus.id, poDraftLine.skuId))
    .where(eq(poDraftLine.docId, docId));
  if (!lines.length) throw new Error("Add at least one line before pushing.");
  const missing = lines.filter((l) => !l.zohoItemId).map((l) => l.code);
  if (missing.length)
    throw new Error(`Not linked to Zoho items yet (run Items sync): ${missing.join(", ")}`);

  const idemRef = `EAT-PO-${doc.id}`;
  return {
    kind: "podraft.create",
    requests: [
      {
        subKey: "doc",
        method: "POST",
        url: `${zohoConfig.inventoryBase}/purchaseorders`,
        body: {
          vendor_id: doc.vendorZohoId,
          date: doc.businessDate,
          ...(doc.deliveryDate ? { delivery_date: doc.deliveryDate } : {}),
          reference_number: idemRef,
          line_items: lines.map((l) => ({
            item_id: l.zohoItemId!,
            quantity: Number(l.qty),
            ...(l.rate != null ? { rate: Number(l.rate) } : {}),
          })),
        },
        summary: `Draft PO for ${doc.vendorName ?? doc.vendorZohoId} (${lines.length} line(s))`,
        idemRef,
        responseKey: "purchaseorder",
        idKeys: ["purchaseorder_id"],
        numberKeys: ["purchaseorder_number"],
      },
    ],
  };
}

/** Builders keyed by push kind. `po.update` is a separate explicit action
 *  (actions/po.ts) because it edits a live Zoho record with its own payload. */
export const PUSH_BUILDERS: Record<
  Exclude<ZohoPushKind, "po.update">,
  (docId: number) => Promise<PushPlan>
> = {
  "receiving.receive": buildPurchaseReceive,
  "receiving.bill": buildBill,
  "wastage.adj": buildWastageAdjustment,
  "adjustment.adj": buildInventoryAdjustment,
  "assembly.bundle": buildBundles,
  "podraft.create": buildPoDraftCreate,
};

/** Which local doc table a push kind reads from (Review queue grouping). */
export const KIND_TO_DOC_TYPE: Record<Exclude<ZohoPushKind, "po.update">, string> = {
  "receiving.receive": "RECEIVING",
  "receiving.bill": "RECEIVING",
  "wastage.adj": "WASTAGE",
  "adjustment.adj": "INV_ADJUSTMENT",
  "assembly.bundle": "ASSEMBLY",
  "podraft.create": "PO_DRAFT",
};
