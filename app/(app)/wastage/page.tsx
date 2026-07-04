import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitWastage } from "@/actions/entries";
import { requireUser, hasRole } from "@/lib/auth/rbac";
import { allActiveSkus, recentWastage, wastageBySource } from "@/lib/queries";
import { WASTAGE_REASONS } from "@/lib/constants";
import { ZOHO_PUSH_LABELS } from "@/lib/zoho/labels";

export const dynamic = "force-dynamic";

// Friendly label for where each waste movement came from.
const SOURCE_LABEL: Record<string, string> = {
  WASTAGE: "Manual",
  SORT_WASTE: "Sorting",
  REGRADE_WASTE: "Regrade",
  RETURN_WASTE: "Return",
};

const STAGE_LABEL: Record<string, string> = {
  RECEIVING: "Receiving",
  SORTING: "Sorting & Grading",
  REGRADE: "Regrading",
  ASSEMBLY: "Assembly",
  RETURN: "Returns",
  EXPIRY: "Expiry",
  GENERAL: "General",
};

export default async function WastagePage() {
  const s = await requireUser();
  const [all, waste, bySource] = await Promise.all([
    allActiveSkus(),
    recentWastage(),
    wastageBySource(30),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <PageHeader
          title="Wastage"
          subtitle="Waste is tracked at every stage of the workflow — the cards show where the last 30 days' waste came from. Manual entries reduce stock (hard-blocked below zero)."
        />
        {bySource.length > 0 && (
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {bySource.map((c) => (
              <div
                key={c.source}
                className="rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-sm"
              >
                <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  {STAGE_LABEL[c.source] ?? c.source}
                </div>
                <div className="font-mono text-lg text-red-600">{c.totalQty}</div>
                <div className="text-[11px] text-neutral-400">{c.entries} entr{c.entries === 1 ? "y" : "ies"}</div>
              </div>
            ))}
          </div>
        )}
        <Card>
          <EntryForm
            kind="wastage"
            action={submitWastage}
            allSkus={all}
            reasons={WASTAGE_REASONS.map((r) => ({ code: r.code, label: r.label }))}
            canPushToZoho={hasRole(s.role, "MANAGER")}
            pushLabel={ZOHO_PUSH_LABELS["wastage.adj"]}
          />
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-700">
          Recorded wastage{" "}
          <span className="font-normal text-neutral-400">· {waste.length}</span>
        </h2>
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-4 py-2 font-medium">Item</th>
                <th className="px-4 py-2 font-medium">Location</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 text-right font-medium">Qty</th>
                <th className="px-4 py-2 font-medium">Reason / note</th>
                <th className="px-4 py-2 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {waste.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-sm text-neutral-400">
                    No wastage recorded yet
                  </td>
                </tr>
              )}
              {waste.map((w) => (
                <tr key={w.id} className="border-t border-neutral-50">
                  <td className="px-4 py-1.5 text-neutral-500">{w.businessDate}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-neutral-600">{w.code}</td>
                  <td className="px-4 py-1.5 text-neutral-700">{w.name}</td>
                  <td className="px-4 py-1.5 text-neutral-500">{w.location}</td>
                  <td className="px-4 py-1.5">
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                      {SOURCE_LABEL[w.movementType] ?? w.movementType}
                    </span>
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono text-red-600">{w.qty}</td>
                  <td className="px-4 py-1.5 text-neutral-500">{w.note ?? "—"}</td>
                  <td className="px-4 py-1.5 text-neutral-500">{w.user ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
