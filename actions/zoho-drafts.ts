"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appAuditLog } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth/rbac";
import { zohoConfig } from "@/lib/zoho/config";
import { zohoCreateDraft } from "@/lib/zoho/write";
import { DRAFT_BUILDERS, type PushableDocType } from "@/lib/zoho/drafts";

const AUDIT_ACTION = "ZOHO_DRAFT_CREATED";

export type PushResult =
  | { ok: true; zohoId: string; zohoNumber?: string; module: string; alreadyExisted?: boolean }
  | { ok: false; error: string };

/** Pull the created record object out of a Zoho create response wrapper. */
function extractRecord(res: Record<string, unknown>): Record<string, unknown> | null {
  for (const [k, v] of Object.entries(res)) {
    if (k === "code" || k === "message") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return null;
}

/**
 * Push a locally-saved (POSTED) document to Zoho as a DRAFT. Create-only: never
 * updates or deletes anything in Zoho or the local DB. Idempotent — a doc that
 * was already pushed returns the existing draft instead of creating a duplicate.
 * Available to any logged-in user; the create-only guarantee lives in the write
 * client + guard, not in gating.
 */
export async function pushDraftToZoho(
  docType: PushableDocType,
  docId: number,
): Promise<PushResult> {
  const s = await requireUser();
  if (!zohoConfig.enabled) return { ok: false, error: "Zoho is not configured." };

  const builder = DRAFT_BUILDERS[docType];
  if (!builder) return { ok: false, error: `Unknown document type "${docType}".` };

  // Idempotency: already pushed this exact doc?
  const prior = await db
    .select({ payload: appAuditLog.payload })
    .from(appAuditLog)
    .where(
      and(
        eq(appAuditLog.action, AUDIT_ACTION),
        eq(appAuditLog.docType, docType),
        eq(appAuditLog.docId, docId),
      ),
    )
    .limit(1);
  if (prior[0]) {
    const p = (prior[0].payload ?? {}) as {
      zohoId?: string;
      zohoNumber?: string;
      module?: string;
    };
    return {
      ok: true,
      zohoId: String(p.zohoId ?? ""),
      zohoNumber: p.zohoNumber,
      module: String(p.module ?? docType),
      alreadyExisted: true,
    };
  }

  try {
    const { url, body, module } = await builder(docId);
    const res = await zohoCreateDraft<Record<string, unknown>>(url, body);
    const rec = extractRecord(res);
    const get = (k: string) =>
      rec && typeof rec[k] !== "undefined" && rec[k] !== null ? String(rec[k]) : undefined;
    const zohoId =
      get(`${module}_id`) ?? get("inventory_adjustment_id") ?? get("id") ?? "";
    const zohoNumber =
      get("reference_number") ?? get("adjustment_no") ?? get("number");

    await db.insert(appAuditLog).values({
      userId: s.uid,
      action: AUDIT_ACTION,
      docType,
      docId,
      payload: { module, zohoId, zohoNumber },
    });

    return { ok: true, zohoId, zohoNumber, module };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
