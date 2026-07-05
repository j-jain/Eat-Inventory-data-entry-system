import { db } from "@/lib/db";
import { systemLog, zohoCallCounter } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

/**
 * Structured logging into system_log (the developer dashboard's feed).
 * Fire-and-forget by design: a logging failure must never break the operation
 * being logged. Keep ctx JSON-serializable and small (payload snapshots are
 * truncated at the call site, not here).
 */
export type LogLevel = "INFO" | "WARN" | "ERROR";

export async function logSystem(
  level: LogLevel,
  source: string,
  message: string,
  ctx?: unknown,
  userId?: number | null,
): Promise<void> {
  try {
    await db.insert(systemLog).values({
      level,
      source,
      message: message.slice(0, 4000),
      ctx: ctx == null ? null : JSON.parse(JSON.stringify(ctx).slice(0, 20_000)),
      userId: userId ?? null,
    });
  } catch {
    // swallow — logging must never take the caller down
  }
}

/** IST calendar date (YYYY-MM-DD). Local copy to avoid importing lib/workflow
 *  (which pulls query modules) into low-level clients. */
export function istDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Count one Zoho API call against today's budget (Standard plan: 2,000/day).
 *  Fire-and-forget — the counter is telemetry, never a gate. */
export function countZohoCall(isWrite: boolean): void {
  void db
    .insert(zohoCallCounter)
    .values({ day: istDay(), calls: 1, writes: isWrite ? 1 : 0 })
    .onConflictDoUpdate({
      target: zohoCallCounter.day,
      set: {
        calls: sql`${zohoCallCounter.calls} + 1`,
        writes: sql`${zohoCallCounter.writes} + ${isWrite ? 1 : 0}`,
      },
    })
    .catch(() => {});
}

/**
 * Wrap a server action so unexpected exceptions land in system_log with
 * context before being rethrown (actions that already return {ok:false}
 * handle their own expected failures — this catches the UNexpected ones).
 */
export function withLog<A extends unknown[], R>(
  source: string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      await logSystem("ERROR", source, e instanceof Error ? e.message : String(e), {
        args: JSON.parse(JSON.stringify(args).slice(0, 4000)),
        stack: e instanceof Error ? e.stack?.slice(0, 2000) : undefined,
      });
      throw e;
    }
  };
}
