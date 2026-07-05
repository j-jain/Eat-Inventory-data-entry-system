import { PageHeader } from "@/components/PageHeader";
import { DashboardClient } from "@/components/DashboardClient";
import { dashboardInventory } from "@/lib/dashboard";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { session } = await requirePageAccess("/dashboard");
  const data = await dashboardInventory();
  const canExport = hasRole(session.role, "MANAGER");
  return (
    <div>
      <div className="flex items-start justify-between">
        <PageHeader
          title="Live Inventory"
          subtitle="Current stock per item, updating live. Click a SKU code to see its full movement history."
        />
        {canExport && (
          <div className="flex gap-2 text-sm">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API CSV download, not a page route */}
            <a
              href="/api/export/ledger"
              className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50"
            >
              ⬇ Ledger CSV
            </a>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API CSV download, not a page route */}
            <a
              href="/api/export/grades"
              className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50"
            >
              ⬇ Grade composition CSV
            </a>
          </div>
        )}
      </div>
      <DashboardClient data={data} />
    </div>
  );
}
