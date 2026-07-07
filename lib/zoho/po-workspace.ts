import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  receivingDoc,
  receivingLine,
  skus,
  zohoPoCache,
  zohoPush,
} from "@/lib/db/schema";
import { normalizeCode } from "@/lib/sku";
import { D } from "@/lib/money";

/**
 * Aniket's PO workspace: one rich card per purchase order with the same
 * detail the receiving sheet shows — lines with ordered/received/remaining,
 * the receipts recorded against it (and their push states), and whether the
 * "receive partial + cancel remainder" close is currently safe to offer.
 */
export type PushGlance = {
  status: "PENDING" | "IN_FLIGHT" | "SUCCESS" | "FAILED" | "UNKNOWN" | "SKIPPED";
  error: string | null;
  zohoId: string | null;
  zohoNumber: string | null;
};

export type PoWorkspaceLine = {
  lineItemId: string;
  itemId: string;
  skuText: string;
  name: string;
  orderedQty: string;
  receivedQty: string;
  remainingQty: string;
  rate: string | null;
  amount: string | null; // ordered × rate
  code: string | null; // matched local SKU code
  uom: string | null;
};

export type PoWorkspaceReceiving = {
  docId: number;
  businessDate: string;
  variance: string;
  varianceNote: string | null;
  lines: { code: string; name: string; qty: string }[];
  receive: PushGlance;
  bill: PushGlance;
};

export type PoWorkspaceCard = {
  zohoPoId: string;
  poNumber: string | null;
  vendorName: string | null;
  poDate: string | null;
  zohoStatus: string | null;
  /** false when the PO left the open-PO cache (closed in Zoho) but local
   *  receipts still have pushes to finish. */
  inCache: boolean;
  lines: PoWorkspaceLine[];
  receivings: PoWorkspaceReceiving[];
  totals: { ordered: string; received: string; remaining: string };
  canCloseRemainder: boolean;
  closeBlockReason: string | null;
};

const PENDING_GLANCE: PushGlance = {
  status: "PENDING",
  error: null,
  zohoId: null,
  zohoNumber: null,
};

export async function poWorkspace(days = 30): Promise<PoWorkspaceCard[]> {
  const cutoff = sql`CURRENT_DATE - ${days}::int`;
  const [pos, docs, skuList] = await Promise.all([
    db.select().from(zohoPoCache).orderBy(desc(zohoPoCache.poDate)).limit(200),
    db
      .select({
        id: receivingDoc.id,
        businessDate: receivingDoc.businessDate,
        zohoPoId: receivingDoc.zohoPoId,
        poNo: receivingDoc.poNo,
        variance: receivingDoc.variance,
        varianceNote: receivingDoc.varianceNote,
      })
      .from(receivingDoc)
      .where(
        and(
          eq(receivingDoc.docStatus, "POSTED"),
          isNotNull(receivingDoc.zohoPoId),
          gte(receivingDoc.businessDate, cutoff),
        ),
      )
      .orderBy(desc(receivingDoc.id))
      .limit(200),
    db
      .select({ id: skus.id, code: skus.code, name: skus.name, uom: skus.uom })
      .from(skus)
      .where(eq(skus.isActive, true)),
  ]);

  const docIds = docs.map((d) => d.id);
  const [recLines, pushRows] = await Promise.all([
    docIds.length
      ? db
          .select({
            docId: receivingLine.docId,
            skuId: receivingLine.skuId,
            qty: receivingLine.acceptedQty,
            code: skus.code,
            name: skus.name,
          })
          .from(receivingLine)
          .innerJoin(skus, eq(skus.id, receivingLine.skuId))
          .where(inArray(receivingLine.docId, docIds))
      : Promise.resolve([] as { docId: number; skuId: number; qty: string; code: string; name: string }[]),
    docIds.length
      ? db
          .select()
          .from(zohoPush)
          .where(and(eq(zohoPush.docType, "RECEIVING"), inArray(zohoPush.docId, docIds)))
      : Promise.resolve([] as (typeof zohoPush.$inferSelect)[]),
  ]);

  const byNorm = new Map<string, { id: number; code: string; uom: string }>();
  for (const s of skuList) byNorm.set(normalizeCode(s.code), { id: s.id, code: s.code, uom: s.uom });

  // cumulative accepted per (zohoPoId, skuId) — POSTED docs only (docs above)
  const cumulative = new Map<string, ReturnType<typeof D>>();
  const linesByDoc = new Map<number, { code: string; name: string; qty: string }[]>();
  const docById = new Map(docs.map((d) => [d.id, d]));
  for (const l of recLines) {
    const doc = docById.get(l.docId);
    if (doc?.zohoPoId) {
      const k = `${doc.zohoPoId}::${l.skuId}`;
      cumulative.set(k, (cumulative.get(k) ?? D(0)).plus(D(l.qty)));
    }
    const arr = linesByDoc.get(l.docId) ?? [];
    arr.push({ code: l.code, name: l.name, qty: String(l.qty) });
    linesByDoc.set(l.docId, arr);
  }

  const glance = (docId: number, kind: "receiving.receive" | "receiving.bill"): PushGlance => {
    const row = pushRows.find((r) => r.docId === docId && r.kind === kind);
    if (!row) return PENDING_GLANCE;
    return {
      status: row.status as PushGlance["status"],
      error: row.error,
      zohoId: row.zohoId,
      zohoNumber: row.zohoNumber,
    };
  };

  const receivingsFor = (zohoPoId: string): PoWorkspaceReceiving[] =>
    docs
      .filter((d) => d.zohoPoId === zohoPoId)
      .map((d) => ({
        docId: d.id,
        businessDate: String(d.businessDate),
        variance: String(d.variance),
        varianceNote: d.varianceNote ?? null,
        lines: linesByDoc.get(d.id) ?? [],
        receive: glance(d.id, "receiving.receive"),
        bill: glance(d.id, "receiving.bill"),
      }));

  const cards: PoWorkspaceCard[] = [];
  const cachedPoIds = new Set<string>();

  for (const po of pos) {
    cachedPoIds.add(po.zohoPoId);
    // Drafts are cached for the PO list but have nothing to receive, push, or
    // close — keep them out of the workspace and its attention counts.
    if ((po.status ?? "").toLowerCase() === "draft") continue;
    const raw = Array.isArray(po.lineItems) ? (po.lineItems as Record<string, unknown>[]) : [];
    let ordered = D(0);
    let received = D(0);
    let remaining = D(0);
    const lines: PoWorkspaceLine[] = raw.map((li) => {
      const skuText = String(li.sku ?? "");
      const match = skuText ? byNorm.get(normalizeCode(skuText)) : undefined;
      const orderedQty = D(String(li.quantity ?? li.quantity_ordered ?? 0));
      const got = match
        ? (cumulative.get(`${po.zohoPoId}::${match.id}`) ?? D(0))
        : D(0);
      const rem = orderedQty.minus(got);
      const rate = li.rate != null ? D(String(li.rate)) : null;
      ordered = ordered.plus(orderedQty);
      received = received.plus(got);
      remaining = remaining.plus(rem.gt(0) ? rem : D(0));
      return {
        lineItemId: String(li.line_item_id ?? ""),
        itemId: String(li.item_id ?? ""),
        skuText,
        name: String(li.name ?? li.description ?? ""),
        orderedQty: orderedQty.toFixed(3),
        receivedQty: got.toFixed(3),
        remainingQty: rem.toFixed(3),
        rate: rate ? rate.toFixed(2) : null,
        amount: rate ? orderedQty.times(rate).toFixed(2) : null,
        code: match?.code ?? null,
        uom: match?.uom ?? null,
      };
    });
    const receivings = receivingsFor(po.zohoPoId);
    // skip pure non-produce POs (no matched line AND no local receipts)
    if (!lines.some((l) => l.code) && receivings.length === 0) continue;

    const { can, reason } = closability(receivings, received, remaining);
    cards.push({
      zohoPoId: po.zohoPoId,
      poNumber: po.poNumber,
      vendorName: po.vendorName,
      poDate: po.poDate ? String(po.poDate) : null,
      zohoStatus: po.status ?? null,
      inCache: true,
      lines,
      receivings,
      totals: {
        ordered: ordered.toFixed(3),
        received: received.toFixed(3),
        remaining: remaining.toFixed(3),
      },
      canCloseRemainder: can,
      closeBlockReason: reason,
    });
  }

  // POs that vanished from the open cache but still have local receipts with
  // unfinished pushes — keep them visible so bills/receives can be completed.
  const orphanPoIds = [...new Set(docs.map((d) => d.zohoPoId!).filter((id) => !cachedPoIds.has(id)))];
  for (const poId of orphanPoIds) {
    const receivings = receivingsFor(poId);
    const unfinished = receivings.some(
      (r) => r.receive.status !== "SUCCESS" || r.bill.status !== "SUCCESS",
    );
    if (!unfinished) continue;
    const anyDoc = docs.find((d) => d.zohoPoId === poId);
    cards.push({
      zohoPoId: poId,
      poNumber: anyDoc?.poNo ?? null,
      vendorName: null,
      poDate: null,
      zohoStatus: "not in open-PO cache (closed or cancelled in Zoho)",
      inCache: false,
      lines: [],
      receivings,
      totals: { ordered: "0.000", received: "0.000", remaining: "0.000" },
      canCloseRemainder: false,
      closeBlockReason: "PO is no longer open in Zoho.",
    });
  }

  // needs-attention first: any non-SUCCESS push or something left to receive
  const needsWork = (c: PoWorkspaceCard) =>
    c.receivings.some((r) => r.receive.status !== "SUCCESS" || r.bill.status !== "SUCCESS") ||
    D(c.totals.remaining).gt(0);
  cards.sort((a, b) => Number(needsWork(b)) - Number(needsWork(a)));
  return cards;
}

function closability(
  receivings: PoWorkspaceReceiving[],
  received: ReturnType<typeof D>,
  remaining: ReturnType<typeof D>,
): { can: boolean; reason: string | null } {
  if (!receivings.length) return { can: false, reason: "Nothing has been received yet." };
  if (remaining.lte(0)) return { can: false, reason: null }; // fully received — nothing to cancel
  if (received.lte(0)) return { can: false, reason: "No received quantity recorded." };
  const varianced = receivings.filter((r) => r.variance !== "NONE");
  if (varianced.length)
    return {
      can: false,
      reason: `Receipt #${varianced[0].docId} has variance ${varianced[0].variance} — close the remainder manually in Zoho (variance receipts change what Zoho should bill).`,
    };
  const unpushed = receivings.filter((r) => r.receive.status !== "SUCCESS");
  if (unpushed.length)
    return {
      can: false,
      reason: `Push receipt #${unpushed[0].docId} to Zoho first — Zoho must know the received quantity before the PO can be trimmed to it.`,
    };
  return { can: true, reason: null };
}
