import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoPush } from "@/lib/db/schema";
import { ZohoApiError } from "./config";
import type { ZohoPushKind } from "./labels";

/**
 * zoho_push state machine — the single source of truth for "did this document
 * reach Zoho". States:
 *
 *   PENDING   → never sent (or confirmed-absent after an UNKNOWN reconcile)
 *   IN_FLIGHT → claimed by a push that hasn't recorded an outcome. If it stays
 *               here (crash between the Zoho write and our update), it is
 *               NEVER auto-retried — only the reconciler can move it.
 *   SUCCESS   → confirmed in Zoho (zoho_id recorded)
 *   FAILED    → Zoho definitively rejected it (4xx). Re-claimable.
 *   UNKNOWN   → outcome ambiguous (transport error / 5xx / retries exhausted).
 *               NEVER auto-retried — reconcile against Zoho first.
 *   SKIPPED   → operator chose not to push (reserved).
 *
 * Rows materialize lazily: ensurePushRow (ON CONFLICT DO NOTHING) immediately
 * followed by claimPush (UPDATE … WHERE status IN … RETURNING) is race-safe —
 * the unique key plus the row lock guarantee exactly one winner even for two
 * concurrent claims. The review queue treats "no row yet" as PENDING.
 */
export type PushStatus =
  | "PENDING"
  | "IN_FLIGHT"
  | "SUCCESS"
  | "FAILED"
  | "UNKNOWN"
  | "SKIPPED";

export type PushRowKey = {
  kind: Exclude<ZohoPushKind, "po.update">;
  docType: string;
  docId: number;
  subKey: string;
};

export type PushRow = typeof zohoPush.$inferSelect;

/** How long an IN_FLIGHT row must sit before the reconciler may touch it —
 *  generously above any serverless function timeout. */
export const IN_FLIGHT_STALE_MS = 5 * 60_000;

export async function ensurePushRow(
  key: PushRowKey,
  fields?: { idemRef?: string; createdBy?: number },
): Promise<void> {
  await db
    .insert(zohoPush)
    .values({
      kind: key.kind,
      docType: key.docType,
      docId: key.docId,
      subKey: key.subKey,
      idemRef: fields?.idemRef,
      createdBy: fields?.createdBy,
    })
    .onConflictDoNothing({
      target: [zohoPush.kind, zohoPush.docType, zohoPush.docId, zohoPush.subKey],
    });
}

export async function getPushRow(key: PushRowKey): Promise<PushRow | null> {
  const rows = await db
    .select()
    .from(zohoPush)
    .where(
      and(
        eq(zohoPush.kind, key.kind),
        eq(zohoPush.docType, key.docType),
        eq(zohoPush.docId, key.docId),
        eq(zohoPush.subKey, key.subKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function pushRowsForDocs(
  docType: string,
  docIds: number[],
): Promise<PushRow[]> {
  if (!docIds.length) return [];
  return db
    .select()
    .from(zohoPush)
    .where(and(eq(zohoPush.docType, docType), inArray(zohoPush.docId, docIds)));
}

/**
 * Atomically claim a push. Only PENDING and FAILED rows are claimable —
 * SUCCESS is done, UNKNOWN/IN_FLIGHT must go through the reconciler. Returns
 * the claimed row, or null if the row wasn't claimable (caller re-reads to
 * report why). Also stamps idem_ref/request payload for the attempt.
 */
export async function claimPush(
  key: PushRowKey,
  attempt: { idemRef: string; requestPayload: unknown; userId: number },
): Promise<PushRow | null> {
  const rows = await db
    .update(zohoPush)
    .set({
      status: "IN_FLIGHT",
      attempts: sql`${zohoPush.attempts} + 1`,
      idemRef: attempt.idemRef,
      requestPayload: attempt.requestPayload,
      createdBy: sql`COALESCE(${zohoPush.createdBy}, ${attempt.userId})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(zohoPush.kind, key.kind),
        eq(zohoPush.docType, key.docType),
        eq(zohoPush.docId, key.docId),
        eq(zohoPush.subKey, key.subKey),
        inArray(zohoPush.status, ["PENDING", "FAILED"]),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function markSuccess(
  id: number,
  outcome: { zohoId: string; zohoNumber?: string; response?: unknown },
): Promise<void> {
  await db
    .update(zohoPush)
    .set({
      status: "SUCCESS",
      zohoId: outcome.zohoId || null,
      zohoNumber: outcome.zohoNumber ?? null,
      zohoResponse: truncateJson(outcome.response),
      error: null,
      pushedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(zohoPush.id, id));
}

export async function markFailed(id: number, error: string, response?: unknown): Promise<void> {
  await db
    .update(zohoPush)
    .set({
      status: "FAILED",
      error: error.slice(0, 2000),
      zohoResponse: truncateJson(response),
      updatedAt: new Date(),
    })
    .where(eq(zohoPush.id, id));
}

export async function markUnknown(id: number, error: string): Promise<void> {
  await db
    .update(zohoPush)
    .set({ status: "UNKNOWN", error: error.slice(0, 2000), updatedAt: new Date() })
    .where(eq(zohoPush.id, id));
}

/** Reconciler outcomes: confirmed present in Zoho, or confirmed absent. */
export async function resolveToSuccess(
  id: number,
  found: { zohoId: string; zohoNumber?: string },
): Promise<void> {
  await markSuccess(id, { zohoId: found.zohoId, zohoNumber: found.zohoNumber });
}

export async function resolveToPending(id: number): Promise<void> {
  await db
    .update(zohoPush)
    .set({
      status: "PENDING",
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(zohoPush.id, id));
}

/**
 * FAILED vs UNKNOWN for a write error:
 *  - status 0  → transport error or retries exhausted: Zoho MAY have applied
 *                the write → UNKNOWN.
 *  - status ≥ 500 → Zoho-side error after processing started → UNKNOWN.
 *  - 429 → rate-limit retries exhausted; the request was rejected before
 *          processing → safe to call FAILED (re-claimable later).
 *  - other 4xx → definite rejection → FAILED.
 *  - non-ZohoApiError (builder bugs etc.) → FAILED (nothing was sent).
 */
export function classifyWriteError(e: unknown): "FAILED" | "UNKNOWN" {
  if (e instanceof ZohoApiError) {
    if (e.status === 429) return "FAILED";
    if (e.status === 0 || e.status >= 500) return "UNKNOWN";
    return "FAILED";
  }
  return "FAILED";
}

function truncateJson(v: unknown): unknown {
  if (v == null) return null;
  try {
    return JSON.parse(JSON.stringify(v).slice(0, 20_000));
  } catch {
    return null;
  }
}
