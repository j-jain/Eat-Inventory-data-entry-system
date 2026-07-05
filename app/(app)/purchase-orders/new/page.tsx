import { PageHeader } from "@/components/PageHeader";
import { NewPoEditor } from "@/components/PoEditor";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { allActiveSkus, vendors } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function NewPoPage() {
  const { session: s } = await requirePageAccess("/purchase-orders/new");
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
  // Only Zoho-linked items are offered — an unlinked SKU would be rejected at
  // push time anyway ("run Items sync"), so it can't be picked at all.
  const linked = skus.filter((k) => k.zohoItemId);
  const hiddenCount = skus.length - linked.length;
  return (
    <div>
      <PageHeader
        title="New Purchase Order"
        subtitle="Build the PO while you're on the phone with the vendor — save as often as you like, then push it into Zoho as a draft."
      />
      {hiddenCount > 0 && (
        <p className="mb-3 text-xs text-neutral-400">
          {hiddenCount} SKU(s) aren&apos;t linked to a Zoho item yet and are hidden here — run the
          Items sync (Admin → Zoho Sync) to link them.
        </p>
      )}
      <NewPoEditor
        vendors={vlist.filter((v) => v.vendorZohoId)}
        skus={linked.map((k) => ({ id: k.id, code: k.code, name: k.name, uom: k.uom }))}
      />
    </div>
  );
}
