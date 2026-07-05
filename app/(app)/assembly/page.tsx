import { PageHeader, Card } from "@/components/PageHeader";
import { AssemblyTabs } from "@/components/AssemblyTabs";
import { WorkflowLock } from "@/components/WorkflowLock";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { motherSkus, packSkusByChannel, currentPickList } from "@/lib/queries";
import { pickListGate, istToday } from "@/lib/workflow";
import { ZOHO_PUSH_LABELS } from "@/lib/zoho/labels";
import { WASTAGE_REASONS } from "@/lib/constants";

export const dynamic = "force-dynamic";

export default async function AssemblyPage() {
  const { session: s } = await requirePageAccess("/assembly");
  const isManager = hasRole(s.role, "MANAGER");
  const gate = await pickListGate();

  if (gate.state !== "COMPLETED") {
    return (
      <div>
        <PageHeader
          title="DC Assembly"
          subtitle="Convert raw (mother) stock into finished packs — after the Pick List is done."
        />
        <WorkflowLock gate={gate} stage="Assembly" />
      </div>
    );
  }

  const [mothers, bz, sp, bf, list] = await Promise.all([
    motherSkus(),
    packSkusByChannel("BLINKIT"),
    packSkusByChannel("SPENCERS"),
    packSkusByChannel("BULK_FRUIT"),
    currentPickList(istToday()),
  ]);

  // Assembly is pick-list-driven: only today's picked packs are pre-listed.
  // (Requirement: no assembling products that weren't picked.) Managers may
  // still add off-list rows as an audited exception.
  const pickLines = (list?.lines ?? []).map((l) => ({
    skuId: l.skuId,
    need: l.qtyPicked !== "0.000" ? l.qtyPicked : l.qtyToPick,
    code: l.code,
  }));

  return (
    <div>
      <PageHeader
        title="DC Assembly"
        subtitle="Today's pick list drives this sheet — each picked pack is listed with how many are needed. Enter Out / Back / Quantity made; Used is automatic."
      />
      <Card>
        <AssemblyTabs
          motherSkus={mothers}
          packsByChannel={{ BLINKIT: bz, SPENCERS: sp, BULK_FRUIT: bf }}
          pickLines={pickLines}
          allowAddRow={isManager}
          canPushToZoho={isManager}
          pushLabel={ZOHO_PUSH_LABELS["assembly.bundle"]}
          wasteReasons={WASTAGE_REASONS.map((r) => ({ code: r.code, label: r.label }))}
        />
      </Card>
    </div>
  );
}
