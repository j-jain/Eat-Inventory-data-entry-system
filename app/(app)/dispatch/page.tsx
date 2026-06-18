import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitDispatch } from "@/actions/entries";
import { allActiveSkus, customers } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function DispatchPage() {
  const [all, clist] = await Promise.all([allActiveSkus(), customers()]);
  const packs = all.filter((s) => s.motherSkuId);
  return (
    <div>
      <PageHeader
        title="Dispatch"
        subtitle="Ship finished packs out of finished-goods stock (hard-blocked below zero)."
      />
      <Card>
        <EntryForm
          kind="dispatch"
          action={submitDispatch}
          packSkus={packs}
          allSkus={all}
          customers={clist}
        />
      </Card>
    </div>
  );
}
