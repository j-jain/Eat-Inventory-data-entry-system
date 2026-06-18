import { openPurchaseOrders } from "@/lib/queries";
import { PageHeader, Card } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default async function PurchaseOrdersPage() {
  const pos = await openPurchaseOrders();
  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        subtitle="Open POs pulled from Zoho (read-only) — the expected quantities receiving checks against."
      />
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
              </tr>
            </thead>
            <tbody>
              {pos.map((p) => (
                <tr key={p.id} className="border-t border-neutral-50">
                  <td className="py-1.5 font-mono text-xs">{p.poNumber}</td>
                  <td className="py-1.5">{p.vendorName}</td>
                  <td className="py-1.5 text-neutral-500">{p.poDate}</td>
                  <td className="py-1.5 text-neutral-500">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
