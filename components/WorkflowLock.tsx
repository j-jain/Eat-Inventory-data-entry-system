import Link from "next/link";
import type { PickGate } from "@/lib/workflow";

/**
 * Lock card shown instead of a gated form (Assembly / Dispatch) until the
 * mandatory Pick List is generated + completed. Server component — pages call
 * pickListGate() and render this when the gate doesn't pass.
 */
export function WorkflowLock({ gate, stage }: { gate: PickGate; stage: string }) {
  const open = gate.state === "OPEN" ? gate : null;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl">
        🔒
      </div>
      <h2 className="text-base font-semibold text-amber-900">
        {`${stage} is locked until today's Pick List is completed`}
      </h2>
      {open ? (
        <div className="mx-auto mt-3 max-w-sm">
          <p className="text-sm text-amber-800">
            Pick list #{open.pickListId} is {open.pct}% picked
            {open.businessDate ? ` (${open.businessDate})` : ""}.
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-amber-100">
            <div
              className="h-2 rounded-full bg-amber-500"
              style={{ width: `${open.pct}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-amber-800">
          No pick list has been generated today. Press <b>Generate Pick List</b>{" "}
          first — it is mandatory before any packing or dispatch work.
        </p>
      )}
      <Link
        href="/pick-list"
        className="mt-4 inline-block rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600"
      >
        Open the Pick List
      </Link>
    </div>
  );
}
