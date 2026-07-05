"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { appAuditLog, zohoPush as zohoPushTable } from "@/lib/db/schema";
import { requireManager } from "@/lib/auth/rbac";
import { logSystem } from "@/lib/log";
import { zohoConfig } from "@/lib/zoho/config";
import { zohoWrite } from "@/lib/zoho/write";
import {
  PUSH_BUILDERS,
  KIND_TO_DOC_TYPE,
  extractByContract,
  type PushRequest,
} from "@/lib/zoho/drafts";
import {
  claimPush,
  classifyWriteError,
  ensurePushRow,
  getPushRow,
  markFailed,
  markSuccess,
  markUnknown,
  resolveToPending,
  resolveToSuccess,
  IN_FLIGHT_STALE_MS,
  type PushRowKey,
} from "@/lib/zoho/push-state";
import { resolveInZoho } from "@/lib/zoho/resolve";
import type { ZohoPushKind } from "@/lib/zoho/labels";

export type PushRequestResult = {
  subKey: string;
  ok: boolean;
  zohoId?: string;
  zohoNumber?: string;
  error?: string;
  alreadyExisted?: boolean;
  /** true when the sub-push is UNKNOWN/IN_FLIGHT and must be reconciled, not retried */
  needsReconcile?: boolean;
  summary: string;
};
export type PushKindResult =
  | { ok: true; results: PushRequestResult[]; pushed: number; failed: number }
  | { ok: false; error: string };

function successAction(kind: string, subKey: string) {
  return `ZOHO_PUSH:${kind}:${subKey}`;
}
function failAction(kind: string, subKey: string) {
  return `ZOHO_PUSH_FAIL:${kind}:${subKey}`;
}

/**
 * Push a locally-saved POSTED document to Zoho. MANAGER-only (Aniket).
 *
 * v3: state lives in zoho_push, not the audit log. Per request:
 *   ensure row → atomic claim (only PENDING/FAILED are claimable; the unique
 *   key + row lock make concurrent double-clicks impossible) → zohoWrite →
 *   SUCCESS with contract-extracted ids, or FAILED (definite 4xx rejection),
 *   or UNKNOWN (transport/5xx — Zoho may have committed; never auto-retried,
 *   reconcile first). Audit rows are still written as the trail.
 */
export async function pushToZoho(
  kind: Exclude<ZohoPushKind, "po.update">,
  docId: number,
): Promise<PushKindResult> {
  const s = await requireManager();
  if (!zohoConfig.enabled) return { ok: false, error: "Zoho is not configured." };
  const builder = PUSH_BUILDERS[kind];
  if (!builder) return { ok: false, error: `Unknown push kind "${kind}".` };
  const docType = KIND_TO_DOC_TYPE[kind];

  let requests: PushRequest[];
  try {
    requests = (await builder(docId)).requests;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const results: PushRequestResult[] = [];
  for (const req of requests) {
    const key: PushRowKey = { kind, docType, docId, subKey: req.subKey };
    await ensurePushRow(key, { idemRef: req.idemRef, createdBy: s.uid });

    const claimed = await claimPush(key, {
      idemRef: req.idemRef,
      requestPayload: req.body,
      userId: s.uid,
    });
    if (!claimed) {
      // Not claimable — report why without touching Zoho.
      const row = await getPushRow(key);
      if (row?.status === "SUCCESS") {
        results.push({
          subKey: req.subKey,
          ok: true,
          zohoId: row.zohoId ?? undefined,
          zohoNumber: row.zohoNumber ?? undefined,
          alreadyExisted: true,
          summary: req.summary,
        });
      } else {
        results.push({
          subKey: req.subKey,
          ok: false,
          needsReconcile: true,
          error:
            row?.status === "UNKNOWN"
              ? "Last attempt's outcome is unknown — run Reconcile before retrying (prevents a duplicate in Zoho)."
              : "A push for this item is already in flight — wait, then Reconcile if it never lands.",
          summary: req.summary,
        });
      }
      continue;
    }

    try {
      const res = await zohoWrite<Record<string, unknown>>(req.method, req.url, req.body);
      const { zohoId, zohoNumber } = extractByContract(req, res);
      await markSuccess(claimed.id, { zohoId, zohoNumber, response: res });
      await db.insert(appAuditLog).values({
        userId: s.uid,
        action: successAction(kind, req.subKey),
        docType,
        docId,
        payload: { zohoId, zohoNumber, summary: req.summary, idemRef: req.idemRef },
      });
      results.push({ subKey: req.subKey, ok: true, zohoId, zohoNumber, summary: req.summary });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const cls = classifyWriteError(e);
      if (cls === "UNKNOWN") {
        await markUnknown(claimed.id, error);
      } else {
        await markFailed(claimed.id, error);
      }
      await db.insert(appAuditLog).values({
        userId: s.uid,
        action: failAction(kind, req.subKey),
        docType,
        docId,
        payload: { error, outcome: cls, summary: req.summary, idemRef: req.idemRef },
      });
      await logSystem(
        "ERROR",
        "zoho-drafts.pushToZoho",
        `${kind} #${docId}/${req.subKey} → ${cls}: ${error}`,
        { kind, docId, subKey: req.subKey, idemRef: req.idemRef, url: req.url },
        s.uid,
      );
      results.push({
        subKey: req.subKey,
        ok: false,
        error,
        needsReconcile: cls === "UNKNOWN",
        summary: req.summary,
      });
    }
  }

  revalidatePath("/review");
  const pushed = results.filter((r) => r.ok && !r.alreadyExisted).length;
  const failed = results.filter((r) => !r.ok).length;
  return { ok: true, results, pushed, failed };
}

export type ReconcileResult =
  | { ok: true; outcome: "CONFIRMED_IN_ZOHO"; zohoId: string; zohoNumber?: string }
  | { ok: true; outcome: "NOT_IN_ZOHO_RETRY_OK" }
  | { ok: false; error: string };

/**
 * Resolve an UNKNOWN (or stuck IN_FLIGHT) push by searching Zoho for the
 * idem_ref that was stamped into the payload. Confirmed present → SUCCESS
 * with the found ids; provably absent → back to PENDING (safe to push again).
 * Read-only against Zoho.
 */
export async function reconcilePush(
  kind: Exclude<ZohoPushKind, "po.update">,
  docId: number,
  subKey: string,
): Promise<ReconcileResult> {
  const s = await requireManager();
  if (!zohoConfig.enabled) return { ok: false, error: "Zoho is not configured." };
  const docType = KIND_TO_DOC_TYPE[kind];
  const row = await getPushRow({ kind, docType, docId, subKey });
  if (!row) return { ok: false, error: "No push record found for this item." };
  if (row.status === "SUCCESS")
    return { ok: true, outcome: "CONFIRMED_IN_ZOHO", zohoId: row.zohoId ?? "" };
  if (row.status === "IN_FLIGHT") {
    const age = Date.now() - new Date(row.updatedAt).getTime();
    if (age < IN_FLIGHT_STALE_MS)
      return {
        ok: false,
        error: "A push is still in flight — wait a few minutes before reconciling.",
      };
  } else if (row.status !== "UNKNOWN" && row.status !== "FAILED") {
    return { ok: false, error: `Nothing to reconcile (status ${row.status}).` };
  }

  try {
    const found = await resolveInZoho(row);
    if (found.found) {
      await resolveToSuccess(row.id, { zohoId: found.zohoId, zohoNumber: found.zohoNumber });
      await db.insert(appAuditLog).values({
        userId: s.uid,
        action: successAction(kind, subKey),
        docType,
        docId,
        payload: {
          zohoId: found.zohoId,
          zohoNumber: found.zohoNumber,
          summary: "reconciled: found in Zoho",
          idemRef: row.idemRef,
        },
      });
      revalidatePath("/review");
      return {
        ok: true,
        outcome: "CONFIRMED_IN_ZOHO",
        zohoId: found.zohoId,
        zohoNumber: found.zohoNumber,
      };
    }
    // Provably absent — only reset UNKNOWN/stale-IN_FLIGHT; a FAILED row is
    // already re-claimable and stays FAILED for the error trail.
    if (row.status === "UNKNOWN" || row.status === "IN_FLIGHT") {
      await resolveToPending(row.id);
    }
    revalidatePath("/review");
    return { ok: true, outcome: "NOT_IN_ZOHO_RETRY_OK" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await logSystem(
      "ERROR",
      "zoho-drafts.reconcilePush",
      `${kind} #${docId}/${subKey}: ${error}`,
      { kind, docId, subKey, idemRef: row.idemRef },
      s.uid,
    );
    return { ok: false, error: `Reconcile lookup failed: ${error}` };
  }
}

/**
 * Reconcile every UNKNOWN / stale-IN_FLIGHT sub-push of a document (bundles
 * have one row per line). Used by the queue cards, where the operator sees
 * one document, not sub-keys.
 */
export async function reconcileDoc(
  kind: Exclude<ZohoPushKind, "po.update">,
  docId: number,
): Promise<{ ok: boolean; confirmed: number; cleared: number; error?: string }> {
  await requireManager();
  const docType = KIND_TO_DOC_TYPE[kind];
  const rows = await db
    .select({ subKey: zohoPushTable.subKey, status: zohoPushTable.status })
    .from(zohoPushTable)
    .where(
      and(
        eq(zohoPushTable.kind, kind),
        eq(zohoPushTable.docType, docType),
        eq(zohoPushTable.docId, docId),
        inArray(zohoPushTable.status, ["UNKNOWN", "IN_FLIGHT", "FAILED"]),
      ),
    );
  if (!rows.length) return { ok: true, confirmed: 0, cleared: 0 };
  let confirmed = 0;
  let cleared = 0;
  for (const r of rows) {
    const res = await reconcilePush(kind, docId, r.subKey);
    if (!res.ok) return { ok: false, confirmed, cleared, error: res.error };
    if (res.outcome === "CONFIRMED_IN_ZOHO") confirmed++;
    else cleared++;
  }
  return { ok: true, confirmed, cleared };
}

export type PushPreview =
  | {
      ok: true;
      requests: { subKey: string; method: string; url: string; body: unknown; summary: string }[];
    }
  | { ok: false; error: string };

/**
 * Dry-run: build the exact Zoho payload(s) for a document WITHOUT sending
 * anything (builders only perform read-only GETs for id mapping). Powers the
 * "what exactly will be sent" preview on Review & Push, and is the safe way
 * to exercise the whole push path in development with ZOHO_ENABLED=false…
 * except builders needing live GETs — those require Zoho config for preview.
 */
export async function previewPush(
  kind: Exclude<ZohoPushKind, "po.update">,
  docId: number,
): Promise<PushPreview> {
  await requireManager();
  const builder = PUSH_BUILDERS[kind];
  if (!builder) return { ok: false, error: `Unknown push kind "${kind}".` };
  try {
    const plan = await builder(docId);
    return {
      ok: true,
      requests: plan.requests.map((r) => ({
        subKey: r.subKey,
        method: r.method,
        url: r.url,
        body: r.body,
        summary: r.summary,
      })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ---- v1 compatibility (EntryForm's single push button) ---------------- */

export type PushableDocType =
  | "RECEIVING"
  | "ASSEMBLY"
  | "INV_ADJUSTMENT"
  | "WASTAGE"
  | "RETURN";

const DEFAULT_KIND: Partial<Record<PushableDocType, Exclude<ZohoPushKind, "po.update">>> = {
  RECEIVING: "receiving.receive",
  ASSEMBLY: "assembly.bundle",
  INV_ADJUSTMENT: "adjustment.adj",
  WASTAGE: "wastage.adj",
};

export type PushResult =
  | { ok: true; zohoId: string; zohoNumber?: string; module: string; alreadyExisted?: boolean }
  | { ok: false; error: string };

/** @deprecated shim for the v1 EntryForm button — now MANAGER-only. */
export async function pushDraftToZoho(
  docType: PushableDocType,
  docId: number,
): Promise<PushResult> {
  const kind = DEFAULT_KIND[docType];
  if (!kind)
    return { ok: false, error: `No Zoho push is wired for ${docType} yet.` };
  const res = await pushToZoho(kind, docId);
  if (!res.ok) return res;
  const firstFail = res.results.find((r) => !r.ok);
  if (firstFail && res.results.every((r) => !r.ok))
    return { ok: false, error: firstFail.error ?? "Push failed." };
  const first = res.results.find((r) => r.ok);
  return {
    ok: true,
    zohoId: first?.zohoId ?? "",
    zohoNumber: first?.zohoNumber,
    module: kind,
    alreadyExisted: res.results.every((r) => r.ok && r.alreadyExisted),
  };
}
