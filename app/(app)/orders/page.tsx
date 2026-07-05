import { PageHeader } from "@/components/PageHeader";
import { OrdersClient } from "@/components/OrdersClient";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { customers, allActiveSkus, recentManualOrders } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const { session: s } = await requirePageAccess("/orders");
  const [custs, skus, orders] = await Promise.all([
    customers(),
    allActiveSkus(),
    recentManualOrders(),
  ]);
  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Record customer orders that don't flow through Zoho. Orders don't move stock — they feed the Pick List."
      />
      <OrdersClient
        customers={custs}
        skus={skus}
        orders={orders}
        isSupervisor={hasRole(s.role, "SUPERVISOR")}
      />
    </div>
  );
}
