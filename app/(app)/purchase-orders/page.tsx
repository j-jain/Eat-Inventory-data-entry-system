import Link from "next/link";
import { openPurchaseOrders } from "@/lib/queries";
import { PageHeader, Card } from "@/components/PageHeader";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

export default async function PurchaseOrdersPage() {
  const { session: s } = await requirePageAccess("/purchase-orders");
  const isManager = hasRole(s.role, "MANAGER");
  const pos = await openPurchaseOrders();
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <PageHeader
          title="Purchase Orders"
          subtitle={
            isManager
              ? "Open POs from Zoho. Create a new PO (pushed to Zoho as a draft) or edit an open one's quantities — edits go straight to the live Zoho PO."
              : "Open POs pulled from Zoho (read-only) — the expected quantities receiving checks against."
          }
        />
        {isManager && (
          <Link
            href="/purchase-orders/new"
            className="shrink-0 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-ink hover:bg-brand-600"
          >
            + New PO
          </Link>
        )}
      </div>
      <Card>
        {pos.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No purchase orders yet. Pull them from{" "}
            <span className="font-medium">Admin → Zoho Sync</span> once Zoho is configured.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="py-2 font-medium">PO #</th>
                <th className="py-2 font-medium">Vendor</th>
                <th className="py-2 font-medium">Date</th>
                <th className="py-2 font-medium">Status</th>
                {isManager && <th className="py-2 font-medium" />}
              </tr>
            </thead>
            <tbody>
              {pos.map((p) => (
                <tr key={p.id} className="border-t border-neutral-50">
                  <td className="py-1.5 font-mono text-xs">{p.poNumber}</td>
                  <td className="py-1.5">{p.vendorName}</td>
                  <td className="py-1.5 text-neutral-500">{p.poDate}</td>
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
      </Card>
    </div>
  );
}
