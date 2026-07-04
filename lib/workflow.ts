import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { pickList, pickListLine } from "@/lib/db/schema";
import { sumQty } from "@/lib/money";

/** 'YYYY-MM-DD' in Asia/Kolkata — the operational business date. */
export function istToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * The mandatory Pick List gate for Assembly & Dispatch.
 *
 * Rule: the gate passes only when at least one pick list was GENERATED today
 * (IST) AND no pick list is OPEN anywhere. Generating again mid-day (new
 * orders arrived) re-locks Assembly/Dispatch until the new list is completed.
 * An OPEN list from a previous day must be completed or cancelled first —
 * there is no role-based bypass; the only escape is a SUPERVISOR
 * short-complete, which records a reason that surfaces on the Summary sheet.
 */
export type PickGate =
  | { state: "NO_PICK_LIST" }
  | {
      state: "OPEN";
      pickListId: number;
      businessDate: string;
      pct: number; // 0-100 picked progress
    }
  | { state: "COMPLETED"; pickListId: number };

export async function pickListGate(): Promise<PickGate> {
  // Any OPEN list (regardless of date) blocks — max one exists by constraint.
  const open = await db
    .select({ id: pickList.id, businessDate: pickList.businessDate })
    .from(pickList)
    .where(eq(pickList.status, "OPEN"))
    .limit(1);
  if (open[0]) {
    const lines = await db
      .select({ toPick: pickListLine.qtyToPick, picked: pickListLine.qtyPicked })
      .from(pickListLine)
      .where(eq(pickListLine.pickListId, open[0].id));
    const toPick = sumQty(lines.map((l) => l.toPick));
    const picked = sumQty(lines.map((l) => l.picked));
    const pct = toPick.isZero()
      ? 0
      : Math.min(100, Math.round(picked.div(toPick).times(100).toNumber()));
    return {
      state: "OPEN",
      pickListId: open[0].id,
      businessDate: String(open[0].businessDate),
      pct,
    };
  }

  const today = await db
    .select({ id: pickList.id })
    .from(pickList)
    .where(
      and(
        eq(pickList.businessDate, istToday()),
        inArray(pickList.status, ["COMPLETED"]),
      ),
    )
    .orderBy(desc(pickList.id))
    .limit(1);
  if (today[0]) return { state: "COMPLETED", pickListId: today[0].id };
  return { state: "NO_PICK_LIST" };
}

/**
 * Server-side guard called at the top of submitAssembly / submitDispatch.
 * Returns the completed pick list id, or throws with an operator-readable
 * message. No role bypasses.
 */
export async function assertPickListComplete(): Promise<number> {
  const gate = await pickListGate();
  if (gate.state === "COMPLETED") return gate.pickListId;
  if (gate.state === "OPEN") {
    throw new Error(
      `Pick list #${gate.pickListId} is still open (${gate.pct}% picked). Finish picking (or a supervisor completes it short) before Assembly/Dispatch.`,
    );
  }
  throw new Error(
    "Generate and complete today's Pick List before Assembly/Dispatch. Open the Pick List tab and press Generate.",
  );
}

/** True if `d` (YYYY-MM-DD) is before today IST — used to flag stale lists. */
export function isPastIst(d: string): boolean {
  return d < istToday(); // ISO dates compare lexicographically
}
