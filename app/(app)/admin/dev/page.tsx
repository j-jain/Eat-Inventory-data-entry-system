import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { syncLog, systemLog, zohoCallCounter, zohoPush } from "@/lib/db/schema";
import { PageHeader } from "@/components/PageHeader";
import { DevDashboard } from "@/components/DevDashboard";
import { requireAdmin } from "@/lib/auth/rbac";
import { istDay } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Standard plan budget — documented in docs/OPERATIONS.md. */
const DAILY_BUDGET = 2000;

export default async function DevPage() {
  await requireAdmin();
  const today = istDay();

  const [counter, syncs, pushCounts, problemPushes, logs] = await Promise.all([
    db.select().from(zohoCallCounter).where(eq(zohoCallCounter.day, today)).limit(1),
    db.select().from(syncLog).orderBy(desc(syncLog.id)).limit(25),
    db
      .select({ status: zohoPush.status, n: sql<number>`COUNT(*)` })
      .from(zohoPush)
      .groupBy(zohoPush.status),
    db
      .select({
        id: zohoPush.id,
        kind: zohoPush.kind,
        docType: zohoPush.docType,
        docId: zohoPush.docId,
        subKey: zohoPush.subKey,
        status: zohoPush.status,
        error: zohoPush.error,
        idemRef: zohoPush.idemRef,
        attempts: zohoPush.attempts,
        updatedAt: zohoPush.updatedAt,
      })
      .from(zohoPush)
      .where(inArray(zohoPush.status, ["FAILED", "UNKNOWN", "IN_FLIGHT"]))
      .orderBy(desc(zohoPush.updatedAt))
      .limit(50),
    db
      .select({
        id: systemLog.id,
        level: systemLog.level,
        source: systemLog.source,
        message: systemLog.message,
        ctx: systemLog.ctx,
        userId: systemLog.userId,
        createdAt: systemLog.createdAt,
      })
      .from(systemLog)
      .orderBy(desc(systemLog.id))
      .limit(200),
  ]);

  return (
    <div>
      <PageHeader
        title="Developer"
        subtitle="System health, error stream and the Zoho API budget — everything needed to debug a problem (or to copy for Claude)."
      />
      <DevDashboard
        budget={{
          day: today,
          calls: counter[0]?.calls ?? 0,
          writes: counter[0]?.writes ?? 0,
          limit: DAILY_BUDGET,
        }}
        syncs={syncs.map((s) => ({
          id: s.id,
          entity: s.entity,
          status: s.status,
          rowsPulled: s.rowsPulled ?? 0,
          error: s.error,
          startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
          finishedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
        }))}
        pushCounts={pushCounts.map((p) => ({ status: p.status, n: Number(p.n) }))}
        problemPushes={problemPushes.map((p) => ({
          ...p,
          updatedAt: new Date(p.updatedAt).toISOString(),
        }))}
        logs={logs.map((l) => ({
          ...l,
          ctx: l.ctx ?? null,
          createdAt: new Date(l.createdAt).toISOString(),
        }))}
      />
    </div>
  );
}
