import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitSorting } from "@/actions/entries";
import { motherSkus } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function SortingPage() {
  const mothers = await motherSkus();
  return (
    <div>
      <PageHeader
        title="Sorting / Grading"
        subtitle="Split received stock into grades A/B/C (data). Waste is auto-calculated = sorted − (A+B+C) and posted to Wastage."
      />
      <Card>
        <EntryForm kind="sorting" action={submitSorting} motherSkus={mothers} />
      </Card>
    </div>
  );
}
