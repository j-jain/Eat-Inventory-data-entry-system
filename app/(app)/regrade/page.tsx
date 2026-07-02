import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitSorting } from "@/actions/entries";
import { motherSkus } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function RegradePage() {
  const mothers = await motherSkus();
  // Re-grading already-sorted stock: no vendor / received reference. Add a row,
  // pick the item (SKU code auto-fills), enter the quantity being re-graded and
  // its A/B/C split; waste is auto = Sorting qty − (A+B+C). Posts as a re-check.
  return (
    <div>
      <PageHeader
        title="Regrade"
        subtitle="Re-grade already-sorted stock. Add a row, pick the item, enter the quantity being re-graded and split it into grades A/B/C; waste is auto-calculated."
      />
      <Card>
        <EntryForm kind="regrade" action={submitSorting} motherSkus={mothers} />
      </Card>
    </div>
  );
}
