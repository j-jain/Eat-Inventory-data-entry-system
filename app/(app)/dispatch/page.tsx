import { PageHeader } from "@/components/PageHeader";
import { WorkflowLock } from "@/components/WorkflowLock";
import { DispatchForm, DeliveryList } from "@/components/DispatchClient";
import { requirePageAccess } from "@/lib/auth/access";
import { pickListGate, istToday } from "@/lib/workflow";
import { customers, dispatchPrelist, todaysDispatches } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function DispatchPage() {
  await requirePageAccess("/dispatch");
  const gate = await pickListGate();
  const date = istToday();

  const [custs, dispatches, prelist] = await Promise.all([
    customers(),
    todaysDispatches(date),
    gate.state === "COMPLETED" ? dispatchPrelist(gate.pickListId, date) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dispatch"
        subtitle="Ship the packs from today's completed pick list, then confirm what was delivered."
      />

      {gate.state === "COMPLETED" ? (
        <DispatchForm prelist={prelist} customers={custs} />
      ) : (
        <WorkflowLock gate={gate} stage="Dispatch" />
      )}

      <DeliveryList dispatches={dispatches} />
    </div>
  );
}
