import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  appAuditLog,
  assemblyDoc,
  assemblyLine,
  invAdjustmentDoc,
  poDraftDoc,
  receivingDoc,
  wastageDoc,
  wastageLine,
} from "@/lib/db/schema";
import { ZOHO_PUSH_LABELS, type ZohoPushKind } from "./labels";

/**
 * Aniket's Review & Push queue: every POSTED document that can go to Zoho,
 * with its push status per destination. Status is derived from app_audit_log
 * rows (`ZOHO_PUSH:<kind>:<subKey>` success / `ZOHO_PUSH_FAIL:…` failure) —
 * no extra state table.
 */
export type ReviewStatus = "PENDING" | "PUSHED" | "PARTIAL" | "FAILED";
export type ReviewRow = {
  kind: Exclude<ZohoPushKind, "po.update">;
  docType: string;
  docId: number;
  businessDate: string;
  summary: string;
  landsIn: string;
  status: ReviewStatus;
  error: string | null;
  /** for multi-request kinds (bundles): pushed / total */
  progress?: { pushed: number; total: number };
};

type AuditRow = { action: string; docType: string | null; docId: number | null; payload: unknown; id: number };

function statusFor(
  kind: string,
  docType: string,
  docId: number,
  needed: number,
  audits: AuditRow[],
): { status: ReviewStatus; error: string | null; pushed: number } {
  const mine = audits.filter((a) => a.docType === docType && a.docId === docId);
  const successes = new Set(
    mine
      .filter((a) => a.action.startsWith(`ZOHO_PUSH:${kind}:`))
      .map((a) => a.action),
  );
  // legacy v1 rows count as a push for adjustments
  const legacy = mine.some((a) => a.action === "ZOHO_DRAFT_CREATED");
  const pushed = successes.size + (legacy && kind === "adjustment.adj" ? 1 : 0);
  const fails = mine
    .filter((a) => a.action.startsWith(`ZOHO_PUSH_FAIL:${kind}:`))
    .sort((a, b) => b.id - a.id);
  if (pushed >= needed) return { status: "PUSHED", error: null, pushed };
  if (pushed > 0) return { status: "PARTIAL", error: latestError(fails), pushed };
  if (fails.length) return { status: "FAILED", error: latestError(fails), pushed };
  return { status: "PENDING", error: null, pushed };
}

function latestError(fails: AuditRow[]): string | null {
  const p = fails[0]?.payload as { error?: string } | undefined;
  return p?.error ?? null;
}

export async function reviewQueue(days = 30): Promise<ReviewRow[]> {
  const cutoff = sql`CURRENT_DATE - ${days}::int`;

  const [receivings, wastages, adjustments, assemblies, assemblyLineCounts, poDrafts, audits] =
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
          id: appAuditLog.id,
          action: appAuditLog.action,
          docType: appAuditLog.docType,
          docId: appAuditLog.docId,
          payload: appAuditLog.payload,
        })
        .from(appAuditLog)
        .where(like(appAuditLog.action, "ZOHO_%")),
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
      const st = statusFor(kind, "RECEIVING", r.id, 1, audits);
      rows.push({
        kind,
        docType: "RECEIVING",
        docId: r.id,
        businessDate: String(r.businessDate),
        summary: `Receiving #${r.id} · PO ${r.poNo ?? r.zohoPoId}${r.variance !== "NONE" ? ` · ${r.variance}` : ""}`,
        landsIn: ZOHO_PUSH_LABELS[kind],
        status: st.status,
        error: st.error,
      });
    }
  }
  for (const w of wastages) {
    const st = statusFor("wastage.adj", "WASTAGE", w.id, 1, audits);
    rows.push({
      kind: "wastage.adj",
      docType: "WASTAGE",
      docId: w.id,
      businessDate: String(w.businessDate),
      summary: `Wastage #${w.id} · ${sourceByDoc.get(w.id) ?? "GENERAL"}${w.note ? ` · ${w.note}` : ""}`,
      landsIn: ZOHO_PUSH_LABELS["wastage.adj"],
      status: st.status,
      error: st.error,
    });
  }
  for (const a of adjustments) {
    const st = statusFor("adjustment.adj", "INV_ADJUSTMENT", a.id, 1, audits);
    rows.push({
      kind: "adjustment.adj",
      docType: "INV_ADJUSTMENT",
      docId: a.id,
      businessDate: String(a.businessDate),
      summary: `Adjustment #${a.id}${a.against ? ` · ${a.against}` : ""}`,
      landsIn: ZOHO_PUSH_LABELS["adjustment.adj"],
      status: st.status,
      error: st.error,
    });
  }
  for (const a of assemblies) {
    const total = lineCount.get(a.id) ?? 1;
    const st = statusFor("assembly.bundle", "ASSEMBLY", a.id, total, audits);
    rows.push({
      kind: "assembly.bundle",
      docType: "ASSEMBLY",
      docId: a.id,
      businessDate: String(a.businessDate),
      summary: `Assembly #${a.id} · ${a.channel} · ${total} pack line(s)`,
      landsIn: ZOHO_PUSH_LABELS["assembly.bundle"],
      status: st.status,
      error: st.error,
      progress: { pushed: st.pushed, total },
    });
  }
  for (const p of poDrafts) {
    const st = statusFor("podraft.create", "PO_DRAFT", p.id, 1, audits);
    rows.push({
      kind: "podraft.create",
      docType: "PO_DRAFT",
      docId: p.id,
      businessDate: String(p.businessDate),
      summary: `PO draft #${p.id} · ${p.vendorName ?? "vendor?"}${p.zohoPoId ? ` · Zoho ${p.zohoPoId}` : ""}`,
      landsIn: ZOHO_PUSH_LABELS["podraft.create"],
      status: p.zohoPoId ? "PUSHED" : st.status,
      error: st.error,
    });
  }

  // pending & failed first, then partial, pushed last; newest date first inside
  const rank: Record<ReviewStatus, number> = { FAILED: 0, PENDING: 1, PARTIAL: 2, PUSHED: 3 };
  rows.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.businessDate < b.businessDate ? 1 : a.businessDate > b.businessDate ? -1 : 0) ||
      b.docId - a.docId,
  );
  return rows;
}
