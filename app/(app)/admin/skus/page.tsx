import { db } from "@/lib/db";
import { skus } from "@/lib/db/schema";
import { PageHeader } from "@/components/PageHeader";
import { SkuAdmin } from "@/components/SkuAdmin";
import { requireAdmin } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

export default async function SkusPage() {
  await requireAdmin();
  const rows = await db
    .select({
      id: skus.id,
      code: skus.code,
      name: skus.name,
      channel: skus.channel,
      uom: skus.uom,
      packSizeText: skus.packSizeText,
      skuKind: skus.skuKind,
      isActive: skus.isActive,
    })
    .from(skus)
    .orderBy(skus.code);
  return (
    <div>
      <PageHeader
        title="SKUs"
        subtitle="Add SKUs and toggle which are active (active SKUs appear in the entry dropdowns). History is never deleted."
      />
      <SkuAdmin skus={rows} />
    </div>
  );
}
