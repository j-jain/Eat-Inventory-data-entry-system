import { PageHeader } from "@/components/PageHeader";
import { DashboardClient } from "@/components/DashboardClient";
import { liveStock } from "@/lib/ledger/balance";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const rows = await liveStock();
  return (
    <div>
      <div className="flex items-start justify-between">
        <PageHeader
          title="Live Inventory"
          subtitle="Current stock per item, updating live. Click a SKU code to see its full movement history."
        />
        <div className="flex gap-2 text-sm">
          <a
            href="/api/export/ledger"
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50"
          >
            ⬇ Ledger CSV
          </a>
          <a
            href="/api/export/grades"
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50"
          >
            ⬇ Grade composition CSV
          </a>
        </div>
      </div>
      <DashboardClient initial={rows} />
    </div>
  );
}
