"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Tabs, type TabDef } from "@/components/Tabs";

/**
 * Purchase Orders list with Zoho-style receive-status filtering. The cache
 * only holds actionable POs (fully-received / closed / cancelled are evicted
 * by the sync), so "All" = partially received + pending + drafts — exactly
 * the working set.
 */
export type PoListRow = {
  id: number;
  zohoPoId: string;
  poNumber: string | null;
  vendorName: string | null;
  poDate: string | null;
  status: string | null;
  receivedStatus: string | null;
  hasLocalReceipt: boolean;
};

type ReceiveState = "DRAFT" | "PARTIAL" | "PENDING";
type TabKey = "all" | "partial" | "pending" | "drafts";

/** Zoho's received_status, upgraded by one local signal: a POSTED local
 *  receipt means "at least partial" even before the next Zoho sync. NULL
 *  (pre-backfill rows) counts as pending. Never downgrades. */
function deriveReceiveState(r: PoListRow): ReceiveState {
  if ((r.status ?? "").toLowerCase() === "draft") return "DRAFT";
  if ((r.receivedStatus ?? "").toLowerCase() === "partially_received") return "PARTIAL";
  if (r.hasLocalReceipt) return "PARTIAL";
  return "PENDING";
}

const RECEIVE_CHIP: Record<ReceiveState, { label: string; cls: string }> = {
  PENDING: { label: "Pending", cls: "bg-neutral-100 text-neutral-600" },
  PARTIAL: { label: "Partially received", cls: "bg-amber-100 text-amber-700" },
  DRAFT: { label: "Draft", cls: "bg-purple-100 text-purple-700" },
};

const MATCHES: Record<TabKey, (s: ReceiveState) => boolean> = {
  all: () => true,
  partial: (s) => s === "PARTIAL",
  pending: (s) => s === "PENDING",
  drafts: (s) => s === "DRAFT",
};

export function PurchaseOrdersClient({
  rows,
  isManager,
}: {
  rows: PoListRow[];
  isManager: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("all");

  const withState = useMemo(
    () => rows.map((r) => ({ ...r, receiveState: deriveReceiveState(r) })),
    [rows],
  );

  const counts = useMemo(() => {
    const c = { all: withState.length, partial: 0, pending: 0, drafts: 0 };
    for (const r of withState) {
      if (r.receiveState === "PARTIAL") c.partial += 1;
      else if (r.receiveState === "PENDING") c.pending += 1;
      else c.drafts += 1;
    }
    return c;
  }, [withState]);

  const tabs: TabDef<TabKey>[] = [
    { key: "all", label: "All", badge: counts.all },
    { key: "partial", label: "Partially received", badge: counts.partial, tone: "amber" },
    { key: "pending", label: "Pending", badge: counts.pending },
    { key: "drafts", label: "Drafts", badge: counts.drafts },
  ];

  const visible = useMemo(
    () => withState.filter((r) => MATCHES[tab](r.receiveState)),
    [withState, tab],
  );

  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No purchase orders yet. Pull them from{" "}
        <span className="font-medium">Admin → Zoho Sync</span> once Zoho is configured.
      </p>
    );
  }

  return (
    <div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-3" />
      {visible.length === 0 ? (
        <p className="py-4 text-center text-sm text-neutral-500">Nothing in this view.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="py-2 font-medium">PO #</th>
              <th className="py-2 font-medium">Vendor</th>
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Receive</th>
              <th className="py-2 font-medium">Status</th>
              {isManager && <th className="py-2 font-medium" />}
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} className="border-t border-neutral-50">
                <td className="py-1.5 font-mono text-xs">{p.poNumber}</td>
                <td className="py-1.5">{p.vendorName}</td>
                <td className="py-1.5 text-neutral-500">{p.poDate}</td>
                <td className="py-1.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${RECEIVE_CHIP[p.receiveState].cls}`}
                  >
                    {RECEIVE_CHIP[p.receiveState].label}
                  </span>
                </td>
                <td className="py-1.5 text-neutral-500">{p.status}</td>
                {isManager && (
                  <td className="py-1.5 text-right">
                    <Link
                      href={`/purchase-orders/${p.zohoPoId}/edit`}
                      className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
                    >
                      Edit
                    </Link>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
