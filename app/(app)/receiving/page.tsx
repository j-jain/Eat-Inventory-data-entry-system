import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitReceiving } from "@/actions/entries";
import { motherSkus, vendors } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReceivingPage() {
  const [mothers, vlist] = await Promise.all([motherSkus(), vendors()]);
  return (
    <div>
      <PageHeader
        title="Receiving"
        subtitle="On-spot accepted quantity per item. Adds to cold-room stock. (Grading is a separate step.)"
      />
      <Card>
        <EntryForm
          kind="receiving"
          action={submitReceiving}
          motherSkus={mothers}
          vendors={vlist}
        />
      </Card>
    </div>
  );
}
