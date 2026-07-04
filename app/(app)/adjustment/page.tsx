import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitAdjustment } from "@/actions/entries";
import { requireUser, hasRole } from "@/lib/auth/rbac";
import { allActiveSkus, vendors } from "@/lib/queries";
import { ZOHO_PUSH_LABELS } from "@/lib/zoho/labels";

export const dynamic = "force-dynamic";

export default async function AdjustmentPage() {
  const s = await requireUser();
  const [all, vlist] = await Promise.all([allActiveSkus(), vendors()]);
  return (
    <div>
      <PageHeader
        title="Inventory Adjustment"
        subtitle="PO vs received vs bill tie-out, supervisor overrides, ₹0 consignment intake, and physical-count corrections. *To-adjust auto = Actual − Bill. Requires supervisor."
      />
      <Card>
        <EntryForm
          kind="adjustment"
          action={submitAdjustment}
          allSkus={all}
          vendors={vlist}
          canPushToZoho={hasRole(s.role, "MANAGER")}
          pushLabel={ZOHO_PUSH_LABELS["adjustment.adj"]}
        />
      </Card>
    </div>
  );
}
