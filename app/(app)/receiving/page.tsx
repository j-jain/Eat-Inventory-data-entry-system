import { PageHeader, Card } from "@/components/PageHeader";
import { ReceivingSheet } from "@/components/ReceivingSheet";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { motherSkus, openPurchaseOrdersForReceiving } from "@/lib/queries";
import { ZOHO_PUSH_LABELS } from "@/lib/zoho/labels";

export const dynamic = "force-dynamic";

export default async function ReceivingPage() {
  const { session: s } = await requirePageAccess("/receiving");
  const isManager = hasRole(s.role, "MANAGER");
  const [mothers, pos] = await Promise.all([
    motherSkus(),
    openPurchaseOrdersForReceiving(),
  ]);
  // Every line of every open PO is pre-listed as a locked row tagged with its
  // PO + vendor; staff only fill Accepted qty against the REMAINING quantity
  // (partial deliveries keep the line here until fully received). Receiving is
  // PO-only for floor staff — off-PO rows are a manager exception.
  const initialRows = pos.flatMap((po) =>
    po.lines.map((ln) => ({
      __locked: "1",
      zohoPoId: po.zohoPoId,
      poNo: po.poNumber ?? "",
      vendorName: po.vendorName ?? "",
      skuId: ln.skuId ? String(ln.skuId) : "",
      skuCode: ln.code ?? "",
      itemName: ln.name,
      uom: ln.uom ?? "",
      expectedQty: ln.remainingQty,
      orderedQty: ln.expectedQty,
      alreadyReceived: ln.alreadyReceivedQty,
      acceptedQty: "",
    })),
  );
  return (
    <div>
      <PageHeader
        title="Receiving"
        subtitle={
          isManager
            ? "Open POs are listed with their remaining quantity — enter what arrived. Off-PO receipts (+ Add row) are a manager-only exception."
            : "Only items on an open purchase order can be received. Enter the accepted quantity against each remaining line — partial deliveries are fine, the rest stays listed."
        }
      />
      <Card>
        <ReceivingSheet
          mothers={mothers}
          initialRows={initialRows.length ? initialRows : undefined}
          canPushToZoho={isManager}
          pushLabel={ZOHO_PUSH_LABELS["receiving.receive"]}
          allowAddRow={isManager}
        />
      </Card>
    </div>
  );
}
