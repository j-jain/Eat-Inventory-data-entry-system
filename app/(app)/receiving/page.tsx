import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitReceivingBatch } from "@/actions/entries";
import { motherSkus, openPurchaseOrdersForReceiving } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReceivingPage() {
  const [mothers, pos] = await Promise.all([
    motherSkus(),
    openPurchaseOrdersForReceiving(),
  ]);
  // Every line of every open ("issued but not received") PO is pre-listed as a
  // locked row tagged with its PO + vendor; staff only fill Accepted qty. On Save
  // the rows are grouped back into one receiving doc per PO.
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
      expectedQty: ln.expectedQty,
      acceptedQty: "",
    })),
  );
  return (
    <div>
      <PageHeader
        title="Receiving"
        subtitle="Every open purchase order is listed below with its vendor, items and expected quantity — just enter the accepted quantity on whatever arrived. Use + Add row for an off-PO receipt."
      />
      <Card>
        <EntryForm
          kind="receiving"
          action={submitReceivingBatch}
          motherSkus={mothers}
          initialRows={initialRows.length ? initialRows : undefined}
        />
      </Card>
    </div>
  );
}
