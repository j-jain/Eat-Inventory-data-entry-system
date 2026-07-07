import Link from "next/link";
import { openPurchaseOrders } from "@/lib/queries";
import { PageHeader, Card } from "@/components/PageHeader";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { PurchaseOrdersClient, type PoListRow } from "@/components/PurchaseOrdersClient";

export const dynamic = "force-dynamic";

export default async function PurchaseOrdersPage() {
  const { session: s } = await requirePageAccess("/purchase-orders");
  const isManager = hasRole(s.role, "MANAGER");
  const pos = await openPurchaseOrders();
  // Plain serializable rows only — the jsonb line_items never crosses the
  // client boundary.
  const rows: PoListRow[] = pos.map((p) => ({
    id: p.id,
    zohoPoId: p.zohoPoId,
    poNumber: p.poNumber,
    vendorName: p.vendorName,
    poDate: p.poDate,
    status: p.status,
    receivedStatus: p.receivedStatus,
    hasLocalReceipt: p.hasLocalReceipt,
  }));
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
        <PurchaseOrdersClient rows={rows} isManager={isManager} />
      </Card>
    </div>
  );
}
