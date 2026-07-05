import { NextResponse } from "next/server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { syncMutex } from "@/lib/db/schema";
import { logSystem } from "@/lib/log";
import { zohoConfig } from "@/lib/zoho/config";
import {
  lastSyncAt,
  syncItems,
  syncVendors,
  syncCustomers,
  syncPurchaseOrders,
  syncSalesOrders,
} from "@/lib/zoho/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A crashed run must never wedge the cron — a claim older than this is
 *  taken over (well above maxDuration=60s). */
const MUTEX_STALE_MS = 10 * 60_000;

/**
 * Row-based mutex (NOT an advisory lock: Supabase's pgBouncer transaction
 * pooling breaks session-level advisory locks, and the pooled `pg` driver
 * can't guarantee lock/unlock land on the same connection). The atomic
 * UPDATE…RETURNING claim works on any pooler.
 */
async function claimSyncMutex(who: string): Promise<boolean> {
  const stale = new Date(Date.now() - MUTEX_STALE_MS);
  const claim = () =>
    db
      .update(syncMutex)
      .set({ lockedAt: new Date(), lockedBy: who })
      .where(
        and(eq(syncMutex.id, 1), or(isNull(syncMutex.lockedAt), lt(syncMutex.lockedAt, stale))),
      )
      .returning({ id: syncMutex.id });
  let rows = await claim();
  if (!rows.length) {
    // Row may not exist yet (fresh database) — seed and retry once.
    await db.insert(syncMutex).values({ id: 1 }).onConflictDoNothing();
    rows = await claim();
  }
  return rows.length > 0;
}

async function releaseSyncMutex(): Promise<void> {
  await db
    .update(syncMutex)
    .set({ lockedAt: null, lockedBy: null })
    .where(eq(syncMutex.id, 1));
}

/**
 * Zoho pull, triggered by Vercel Cron (daily) and the GitHub Actions workflow
 * (6×/day). Incremental per entity. Protected by CRON_SECRET. The two cron
 * sources can fire near-simultaneously — the mutex makes the loser a 200
 * no-op (200, not an error: the GitHub workflow curls with -fsS and must not
 * go red just because Vercel won the race).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!zohoConfig.enabled) {
    return NextResponse.json({ error: "zoho not configured" }, { status: 503 });
  }

  const who = `cron-${Date.now()}`;
  if (!(await claimSyncMutex(who))) {
    return NextResponse.json({ ok: true, skipped: "locked", at: new Date().toISOString() });
  }

  const jobs: { entity: "ITEM" | "VENDOR" | "CUSTOMER" | "PO" | "SO"; fn: (since?: Date) => Promise<number> }[] = [
    { entity: "ITEM", fn: syncItems },
    { entity: "VENDOR", fn: syncVendors },
    { entity: "CUSTOMER", fn: syncCustomers },
    { entity: "PO", fn: syncPurchaseOrders },
    { entity: "SO", fn: syncSalesOrders },
  ];

  const results: Record<string, number | string> = {};
  try {
    for (const j of jobs) {
      try {
        const since = (await lastSyncAt(j.entity)) ?? undefined;
        results[j.entity] = await j.fn(since);
      } catch (e) {
        // one entity failing shouldn't abort the rest; runSync already logs to sync_log
        const msg = e instanceof Error ? e.message : String(e);
        results[j.entity] = `error: ${msg}`;
        await logSystem("ERROR", "cron.sync", `${j.entity} sync failed: ${msg}`, { entity: j.entity });
      }
    }
  } finally {
    await releaseSyncMutex().catch(() => {});
  }

  return NextResponse.json({ ok: true, at: new Date().toISOString(), results });
}
