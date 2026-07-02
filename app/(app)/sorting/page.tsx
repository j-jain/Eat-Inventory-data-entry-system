import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitSorting } from "@/actions/entries";
import { motherSkus, receivedPendingSort } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SortingPage() {
  const [mothers, pending] = await Promise.all([motherSkus(), receivedPendingSort()]);
  // Every received-but-not-yet-sorted item is pre-loaded (locked) for grading.
  // The full received batch is graded, so waste = Received − (A+B+C).
  const initialRows = pending.map((p) => ({
    __locked: "1",
    skuId: String(p.skuId),
    skuCode: p.code,
    itemName: p.name,
    uom: p.uom,
    vendorName: p.vendor ?? "",
    receivedQty: p.receivedQty,
    qtyA: "",
    qtyB: "",
    qtyC: "",
  }));
  return (
    <div>
      <PageHeader
        title="Sorting / Grading"
        subtitle="Everything received is pre-loaded here for grading. Split each item into grades A/B/C; waste is auto-calculated = Received − (A+B+C). To re-grade already-sorted stock, use the Regrade tab."
      />
      <Card>
        <EntryForm
          kind="sorting"
          action={submitSorting}
          motherSkus={mothers}
          initialRows={initialRows.length ? initialRows : undefined}
        />
      </Card>
    </div>
  );
}
