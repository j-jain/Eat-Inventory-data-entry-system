import { PageHeader, Card } from "@/components/PageHeader";
import { AssemblyTabs } from "@/components/AssemblyTabs";
import { motherSkus, packSkusByChannel, type SkuOption } from "@/lib/queries";
import { SHEET_SKUS } from "@/scripts/sheet-skus";
import { normalizeCode } from "@/lib/sku";

export const dynamic = "force-dynamic";

// The operational Excel pack list (sheet-skus) — only these are pre-listed; any
// other channel SKU stays reachable via "+ Add row".
const SHEET_CODES = new Set(SHEET_SKUS.map((s) => normalizeCode(s.code)));
const onSheet = (list: SkuOption[]) =>
  list.filter((s) => SHEET_CODES.has(normalizeCode(s.code)));

export default async function AssemblyPage() {
  const [mothers, bz, s, bf] = await Promise.all([
    motherSkus(),
    packSkusByChannel("BLINKIT"),
    packSkusByChannel("SPENCERS"),
    packSkusByChannel("BULK_FRUIT"),
  ]);
  return (
    <div>
      <PageHeader
        title="DC Assembly"
        subtitle="Every pack from the assembly sheet is listed with its size and mother. Fill Out / Back / Quantity only on what you assembled; blank rows are ignored. Need an off-sheet item? Use + Add row."
      />
      <Card>
        <AssemblyTabs
          motherSkus={mothers}
          packsByChannel={{ BLINKIT: bz, SPENCERS: s, BULK_FRUIT: bf }}
          prelistByChannel={{
            BLINKIT: onSheet(bz),
            SPENCERS: onSheet(s),
            BULK_FRUIT: onSheet(bf),
          }}
        />
      </Card>
    </div>
  );
}
