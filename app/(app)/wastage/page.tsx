import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitWastage } from "@/actions/entries";
import { allActiveSkus } from "@/lib/queries";
import { WASTAGE_REASONS } from "@/lib/constants";

export const dynamic = "force-dynamic";

export default async function WastagePage() {
  const all = await allActiveSkus();
  return (
    <div>
      <PageHeader
        title="Wastage"
        subtitle="Record waste against any item with a reason. Reduces stock (hard-blocked below zero)."
      />
      <Card>
        <EntryForm
          kind="wastage"
          action={submitWastage}
          allSkus={all}
          reasons={WASTAGE_REASONS.map((r) => ({ code: r.code, label: r.label }))}
        />
      </Card>
    </div>
  );
}
