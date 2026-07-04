import { PageHeader } from "@/components/PageHeader";
import { NewPoEditor } from "@/components/PoEditor";
import { requireUser, hasRole } from "@/lib/auth/rbac";
import { allActiveSkus, vendors } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function NewPoPage() {
  const s = await requireUser();
  if (!hasRole(s.role, "MANAGER")) {
    return (
      <div>
        <PageHeader title="New Purchase Order" />
        <div className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500 shadow-sm">
          Only Aniket (manager) can create purchase orders.
        </div>
      </div>
    );
  }
  const [vlist, skus] = await Promise.all([vendors(), allActiveSkus()]);
  return (
    <div>
      <PageHeader
        title="New Purchase Order"
        subtitle="Build the PO while you're on the phone with the vendor — save as often as you like, then push it into Zoho as a draft."
      />
      <NewPoEditor
        vendors={vlist.filter((v) => v.vendorZohoId)}
        skus={skus.map((k) => ({ id: k.id, code: k.code, name: k.name, uom: k.uom }))}
      />
    </div>
  );
}
