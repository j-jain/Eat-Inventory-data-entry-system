import { PageHeader } from "@/components/PageHeader";
import { EditPoEditor, type ZohoPoLine } from "@/components/PoEditor";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { openPurchaseOrders } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function EditPoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { session: s } = await requirePageAccess("/purchase-orders");
  if (!hasRole(s.role, "MANAGER")) {
    return (
      <div>
        <PageHeader title="Edit Purchase Order" />
        <div className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500 shadow-sm">
          Only Aniket (manager) can edit purchase orders.
        </div>
      </div>
    );
  }
  const pos = await openPurchaseOrders();
  const po = pos.find((p) => p.zohoPoId === id);
  if (!po) {
    return (
      <div>
        <PageHeader title="Edit Purchase Order" />
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-800">
          PO {id} isn&apos;t in the local cache — run a Zoho sync (Admin → Zoho Sync) and try
          again, or the PO may have been closed.
        </div>
      </div>
    );
  }
  const raw = Array.isArray(po.lineItems)
    ? (po.lineItems as Record<string, unknown>[])
    : [];
  const lines: ZohoPoLine[] = raw
    .filter((li) => li.line_item_id != null)
    .map((li) => ({
      lineItemId: String(li.line_item_id),
      name: String(li.name ?? li.description ?? ""),
      sku: String(li.sku ?? ""),
      quantity: Number(li.quantity ?? 0),
      rate: li.rate != null ? Number(li.rate) : null,
    }));
  return (
    <div>
      <PageHeader
        title="Edit Purchase Order"
        subtitle="Change quantities so the PO reflects what will actually be billed. Saving updates the LIVE PO in Zoho and refreshes the receiving sheet."
      />
      <EditPoEditor
        zohoPoId={id}
        poNumber={po.poNumber ?? id}
        vendorName={po.vendorName ?? ""}
        lines={lines}
      />
    </div>
  );
}
