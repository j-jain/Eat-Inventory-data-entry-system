"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { appAuditLog } from "@/lib/db/schema";
import { requireManager } from "@/lib/auth/rbac";
import { zohoConfig } from "@/lib/zoho/config";
import { zohoWrite } from "@/lib/zoho/write";
import { PUSH_BUILDERS, KIND_TO_DOC_TYPE, type PushRequest } from "@/lib/zoho/drafts";
import type { ZohoPushKind } from "@/lib/zoho/labels";

/** v1 action string — old adjustment pushes still count as pushed. */
const LEGACY_AUDIT_ACTION = "ZOHO_DRAFT_CREATED";

export type PushRequestResult = {
  subKey: string;
  ok: boolean;
  zohoId?: string;
  error?: string;
  alreadyExisted?: boolean;
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

/** Pull the created record object out of a Zoho create response wrapper. */
function extractRecord(res: Record<string, unknown>): Record<string, unknown> | null {
  for (const [k, v] of Object.entries(res)) {
    if (k === "code" || k === "message") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return null;
}

function extractZohoId(res: Record<string, unknown>): string {
  const rec = extractRecord(res);
  if (!rec) return "";
  for (const k of [
    "purchasereceive_id",
    "receive_id",
    "bill_id",
    "bundle_id",
    "purchaseorder_id",
    "inventory_adjustment_id",
  ]) {
    if (rec[k] != null) return String(rec[k]);
  }
  for (const [k, v] of Object.entries(rec)) {
    if (k.endsWith("_id") && (typeof v === "string" || typeof v === "number"))
      return String(v);
  }
  return "";
}

async function priorSuccess(
  kind: ZohoPushKind,
  docType: string,
  docId: number,
  subKey: string,
): Promise<{ zohoId?: string } | null> {
  const rows = await db
    .select({ payload: appAuditLog.payload })
    .from(appAuditLog)
    .where(
      and(
        eq(appAuditLog.action, successAction(kind, subKey)),
        eq(appAuditLog.docType, docType),
        eq(appAuditLog.docId, docId),
      ),
    )
    .limit(1);
  if (rows[0]) return (rows[0].payload ?? {}) as { zohoId?: string };
  // legacy v1 rows (adjustment pushes)
  if (kind === "adjustment.adj") {
    const legacy = await db
      .select({ payload: appAuditLog.payload })
      .from(appAuditLog)
      .where(
        and(
          eq(appAuditLog.action, LEGACY_AUDIT_ACTION),
          eq(appAuditLog.docType, "INV_ADJUSTMENT"),
          eq(appAuditLog.docId, docId),
        ),
      )
      .limit(1);
    if (legacy[0]) return (legacy[0].payload ?? {}) as { zohoId?: string };
  }
  return null;
}

/**
 * Push a locally-saved POSTED document to Zoho. MANAGER-only (Aniket) — the
 * button is also hidden for everyone else, but this is the real gate.
 * Idempotent per request (bundles dedupe per line). Failures are audited and
 * surface in the Review queue with the Zoho error text.
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
    const prior = await priorSuccess(kind, docType, docId, req.subKey);
    if (prior) {
      results.push({
        subKey: req.subKey,
        ok: true,
        zohoId: prior.zohoId,
        alreadyExisted: true,
        summary: req.summary,
      });
      continue;
    }
    try {
      const res = await zohoWrite<Record<string, unknown>>(req.method, req.url, req.body);
      const zohoId = extractZohoId(res);
      await db.insert(appAuditLog).values({
        userId: s.uid,
        action: successAction(kind, req.subKey),
        docType,
        docId,
        payload: { zohoId, summary: req.summary },
      });
      results.push({ subKey: req.subKey, ok: true, zohoId, summary: req.summary });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await db.insert(appAuditLog).values({
        userId: s.uid,
        action: failAction(kind, req.subKey),
        docType,
        docId,
        payload: { error, summary: req.summary },
      });
      results.push({ subKey: req.subKey, ok: false, error, summary: req.summary });
    }
  }

  revalidatePath("/review");
  const pushed = results.filter((r) => r.ok && !r.alreadyExisted).length;
  const failed = results.filter((r) => !r.ok).length;
  return { ok: true, results, pushed, failed };
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
    module: kind,
    alreadyExisted: res.results.every((r) => r.ok && r.alreadyExisted),
  };
}
