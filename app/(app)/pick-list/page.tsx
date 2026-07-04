import { PageHeader } from "@/components/PageHeader";
import { PickListClient } from "@/components/PickListClient";
import { requireUser, hasRole } from "@/lib/auth/rbac";
import { pickListGate, istToday } from "@/lib/workflow";
import { currentPickList } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function PickListPage() {
  const s = await requireUser();
  const [gate, list] = await Promise.all([pickListGate(), currentPickList(istToday())]);
  return (
    <div>
      <PageHeader
        title="Pick List"
        subtitle="Generate the day's pick list from open orders, then pick each pack. Assembly & Dispatch stay locked until it's completed."
      />
      <PickListClient gate={gate} list={list} isSupervisor={hasRole(s.role, "SUPERVISOR")} />
    </div>
  );
}
