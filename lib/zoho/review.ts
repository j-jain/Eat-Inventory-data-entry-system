import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  assemblyDoc,
  assemblyLine,
  invAdjustmentDoc,
  poDraftDoc,
  receivingDoc,
  wastageDoc,
  wastageLine,
  zohoPush,
} from "@/lib/db/schema";
import { ZOHO_PUSH_LABELS, type ZohoPushKind } from "./labels";

/**
 * Aniket's Review & Push queue: every POSTED document that can go to Zoho,
 * with its push status per destination. v3: status comes from the zoho_push
 * state table ("no row yet" = PENDING). UNKNOWN means the last attempt's
 * outcome is ambiguous — it must be reconciled against Zoho, never blind-
 * retried.
 */
export type ReviewStatus = "PENDING" | "PUSHED" | "PARTIAL" | "FAILED" | "UNKNOWN";
export type ReviewRow = {
  kind: Exclude<ZohoPushKind, "po.update">;
  docType: string;
  docId: number;
  businessDate: string;
  summary: string;
  landsIn: string;
  status: ReviewStatus;
  error: string | null;
  zohoId: string | null;
  zohoNumber: string | null;
  pushedAt: string | null;
  /** for multi-request kinds (bundles): pushed / total */
  progress?: { pushed: number; total: number };
};

type PushStateRow = {
  kind: string;
  docType: string;
  docId: number;
  subKey: string;
  status: string;
  error: string | null;
  zohoId: string | null;
  zohoNumber: string | null;
  pushedAt: Date | null;
  updatedAt: Date;
};

function statusFor(
  kind: string,
  docType: string,
  docId: number,
  needed: number,
  pushRows: PushStateRow[],
): {
  status: ReviewStatus;
  error: string | null;
  pushed: number;
  zohoId: string | null;
  zohoNumber: string | null;
  pushedAt: string | null;
} {
  const mine = pushRows.filter(
    (r) => r.kind === kind && r.docType === docType && r.docId === docId,
  );
  const successes = mine.filter((r) => r.status === "SUCCESS");
  const unknowns = mine
    .filter((r) => r.status === "UNKNOWN" || r.status === "IN_FLIGHT")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const fails = mine
    .filter((r) => r.status === "FAILED")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const pushed = successes.length;
  const first = successes[0];
  const base = {
    pushed,
    zohoId: first?.zohoId ?? null,
    zohoNumber: first?.zohoNumber ?? null,
    pushedAt: first?.pushedAt ? new Date(first.pushedAt).toISOString() : null,
  };
  if (pushed >= needed) return { status: "PUSHED", error: null, ...base };
  if (unknowns.length)
    return {
      status: "UNKNOWN",
      error:
        unknowns[0].error ??
        "Outcome of the last attempt is unknown — reconcile against Zoho before retrying.",
      ...base,
    };
  if (pushed > 0) return { status: "PARTIAL", error: fails[0]?.error ?? null, ...base };
  if (fails.length) return { status: "FAILED", error: fails[0]?.error ?? null, ...base };
  return { status: "PENDING", error: null, ...base };
}

/** Everything that has confirmedly landed in Zoho, newest first (History tab). */
export type PushHistoryRow = {
  id: number;
  kind: string;
  docType: string;
  docId: number;
  subKey: string;
  idemRef: string | null;
  zohoId: string | null;
  zohoNumber: string | null;
  pushedAt: string | null;
};

export async function pushHistory(limit = 300): Promise<PushHistoryRow[]> {
  const rows = await db
    .select({
      id: zohoPush.id,
      kind: zohoPush.kind,
      docType: zohoPush.docType,
      docId: zohoPush.docId,
      subKey: zohoPush.subKey,
      idemRef: zohoPush.idemRef,
      zohoId: zohoPush.zohoId,
      zohoNumber: zohoPush.zohoNumber,
      pushedAt: zohoPush.pushedAt,
    })
    .from(zohoPush)
    .where(eq(zohoPush.status, "SUCCESS"))
    .orderBy(desc(zohoPush.pushedAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    pushedAt: r.pushedAt ? new Date(r.pushedAt).toISOString() : null,
  }));
}

export async function reviewQueue(days = 30): Promise<ReviewRow[]> {
  const cutoff = sql`CURRENT_DATE - ${days}::int`;

  const [receivings, wastages, adjustments, assemblies, assemblyLineCounts, poDrafts, pushRows] =
    await Promise.all([
      db
        .select({
          id: receivingDoc.id,
          businessDate: receivingDoc.businessDate,
          poNo: receivingDoc.poNo,
          zohoPoId: receivingDoc.zohoPoId,
          variance: receivingDoc.variance,
        })
        .from(receivingDoc)
        .where(and(eq(receivingDoc.docStatus, "POSTED"), gte(receivingDoc.businessDate, cutoff)))
        .orderBy(desc(receivingDoc.id))
        .limit(200),
      db
        .select({ id: wastageDoc.id, businessDate: wastageDoc.businessDate, note: wastageDoc.note })
        .from(wastageDoc)
        .where(and(eq(wastageDoc.docStatus, "POSTED"), gte(wastageDoc.businessDate, cutoff)))
        .orderBy(desc(wastageDoc.id))
        .limit(200),
      db
        .select({
          id: invAdjustmentDoc.id,
          businessDate: invAdjustmentDoc.businessDate,
          against: invAdjustmentDoc.against,
        })
        .from(invAdjustmentDoc)
        .where(
          and(eq(invAdjustmentDoc.docStatus, "POSTED"), gte(invAdjustmentDoc.businessDate, cutoff)),
        )
        .orderBy(desc(invAdjustmentDoc.id))
        .limit(200),
      db
        .select({
          id: assemblyDoc.id,
          businessDate: assemblyDoc.businessDate,
          channel: assemblyDoc.channel,
        })
        .from(assemblyDoc)
        .where(and(eq(assemblyDoc.docStatus, "POSTED"), gte(assemblyDoc.businessDate, cutoff)))
        .orderBy(desc(assemblyDoc.id))
        .limit(200),
      db
        .select({
          docId: assemblyLine.docId,
          n: sql<number>`COUNT(*)`,
        })
        .from(assemblyLine)
        .groupBy(assemblyLine.docId),
      db
        .select({
          id: poDraftDoc.id,
          businessDate: poDraftDoc.businessDate,
          vendorName: poDraftDoc.vendorName,
          zohoPoId: poDraftDoc.zohoPoId,
        })
        .from(poDraftDoc)
        .where(and(eq(poDraftDoc.docStatus, "POSTED"), gte(poDraftDoc.businessDate, cutoff)))
        .orderBy(desc(poDraftDoc.id))
        .limit(200),
      db
        .select({
          kind: zohoPush.kind,
          docType: zohoPush.docType,
          docId: zohoPush.docId,
          subKey: zohoPush.subKey,
          status: zohoPush.status,
          error: zohoPush.error,
          zohoId: zohoPush.zohoId,
          zohoNumber: zohoPush.zohoNumber,
          pushedAt: zohoPush.pushedAt,
          updatedAt: zohoPush.updatedAt,
        })
        .from(zohoPush)
        .where(
          inArray(zohoPush.docType, [
            "RECEIVING",
            "WASTAGE",
            "INV_ADJUSTMENT",
            "ASSEMBLY",
            "PO_DRAFT",
          ]),
        ),
    ]);

  // wastage docs that are RECEIVING-S4 auto docs vs manual — label only
  const wastageSourceRows = wastages.length
    ? await db
        .select({ docId: wastageLine.docId, source: wastageLine.source })
        .from(wastageLine)
        .where(inArray(wastageLine.docId, wastages.map((w) => w.id)))
    : [];
  const sourceByDoc = new Map<number, string>();
  for (const r of wastageSourceRows) if (!sourceByDoc.has(r.docId)) sourceByDoc.set(r.docId, String(r.source));

  const lineCount = new Map(assemblyLineCounts.map((c) => [c.docId, Number(c.n)]));
  const rows: ReviewRow[] = [];

  for (const r of receivings) {
    if (!r.zohoPoId) continue; // off-PO receipts push via their linked adjustment
    for (const kind of ["receiving.receive", "receiving.bill"] as const) {
      const st = statusFor(kind, "RECEIVING", r.id, 1, pushRows);
      rows.push({
        kind,
        docType: "RECEIVING",
        docId: r.id,
        businessDate: String(r.businessDate),
        summary: `Receiving #${r.id} · PO ${r.poNo ?? r.zohoPoId}${r.variance !== "NONE" ? ` · ${r.variance}` : ""}`,
        landsIn: ZOHO_PUSH_LABELS[kind],
        status: st.status,
        error: st.error,
        zohoId: st.zohoId,
        zohoNumber: st.zohoNumber,
        pushedAt: st.pushedAt,
      });
    }
  }
  for (const w of wastages) {
    const st = statusFor("wastage.adj", "WASTAGE", w.id, 1, pushRows);
    rows.push({
      kind: "wastage.adj",
      docType: "WASTAGE",
      docId: w.id,
      businessDate: String(w.businessDate),
      summary: `Wastage #${w.id} · ${sourceByDoc.get(w.id) ?? "GENERAL"}${w.note ? ` · ${w.note}` : ""}`,
      landsIn: ZOHO_PUSH_LABELS["wastage.adj"],
      status: st.status,
      error: st.error,
      zohoId: st.zohoId,
      zohoNumber: st.zohoNumber,
      pushedAt: st.pushedAt,
    });
  }
  for (const a of adjustments) {
    const st = statusFor("adjustment.adj", "INV_ADJUSTMENT", a.id, 1, pushRows);
    rows.push({
      kind: "adjustment.adj",
      docType: "INV_ADJUSTMENT",
      docId: a.id,
      businessDate: String(a.businessDate),
      summary: `Adjustment #${a.id}${a.against ? ` · ${a.against}` : ""}`,
      landsIn: ZOHO_PUSH_LABELS["adjustment.adj"],
      status: st.status,
      error: st.error,
      zohoId: st.zohoId,
      zohoNumber: st.zohoNumber,
      pushedAt: st.pushedAt,
    });
  }
  for (const a of assemblies) {
    const total = lineCount.get(a.id) ?? 1;
    const st = statusFor("assembly.bundle", "ASSEMBLY", a.id, total, pushRows);
    rows.push({
      kind: "assembly.bundle",
      docType: "ASSEMBLY",
      docId: a.id,
      businessDate: String(a.businessDate),
      summary: `Assembly #${a.id} · ${a.channel} · ${total} pack line(s)`,
      landsIn: ZOHO_PUSH_LABELS["assembly.bundle"],
      status: st.status,
      error: st.error,
      zohoId: st.zohoId,
      zohoNumber: st.zohoNumber,
      pushedAt: st.pushedAt,
      progress: { pushed: st.pushed, total },
    });
  }
  for (const p of poDrafts) {
    const st = statusFor("podraft.create", "PO_DRAFT", p.id, 1, pushRows);
    rows.push({
      kind: "podraft.create",
      docType: "PO_DRAFT",
      docId: p.id,
      businessDate: String(p.businessDate),
      summary: `PO draft #${p.id} · ${p.vendorName ?? "vendor?"}${p.zohoPoId ? ` · Zoho ${p.zohoPoId}` : ""}`,
      landsIn: ZOHO_PUSH_LABELS["podraft.create"],
      // dual truth: poDraftDoc.zohoPoId is an independent success signal
      status: p.zohoPoId ? "PUSHED" : st.status,
      error: st.error,
      zohoId: st.zohoId ?? p.zohoPoId,
      zohoNumber: st.zohoNumber,
      pushedAt: st.pushedAt,
    });
  }

  // needs-attention first: failed & unknown, then pending, partial, pushed
  const rank: Record<ReviewStatus, number> = {
    FAILED: 0,
    UNKNOWN: 1,
    PENDING: 2,
    PARTIAL: 3,
    PUSHED: 4,
  };
  rows.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.businessDate < b.businessDate ? 1 : a.businessDate > b.businessDate ? -1 : 0) ||
      b.docId - a.docId,
  );
  return rows;
}
