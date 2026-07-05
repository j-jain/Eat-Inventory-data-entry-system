import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitSorting } from "@/actions/entries";
import { motherSkus } from "@/lib/queries";
import { combinedZohoStock, liveStock } from "@/lib/ledger/balance";
import { requirePageAccess } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

export default async function RegradePage() {
  await requirePageAccess("/regrade");
  const [mothers, combined, live] = await Promise.all([
    motherSkus(),
    combinedZohoStock(),
    liveStock(),
  ]);
  // Prefill "Sorting quantity" with the current stock of the picked SKU:
  // combined figure (Zoho + not-yet-pushed local Δ) when the SKU is linked,
  // else the local cold-room balance. Always editable.
  const stock: Record<string, string> = {};
  for (const r of live)
    if (r.locationCode === "COLD_ROOM") stock[String(r.skuId)] = r.qty;
  for (const r of combined) stock[String(r.skuId)] = r.combinedQty;
  return (
    <div>
      <PageHeader
        title="Regrade"
        subtitle="Re-grade already-sorted stock. Pick the item — the current stock fills in automatically (edit it if you're regrading less) — then split into grades A/B/C; waste is auto-calculated."
      />
      <Card>
        <EntryForm
          kind="regrade"
          action={submitSorting}
          motherSkus={mothers}
          stockPrefill={{ field: "sortedQty", stock, unit: "kg" }}
        />
      </Card>
    </div>
  );
}
