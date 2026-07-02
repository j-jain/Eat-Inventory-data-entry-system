import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitReturn } from "@/actions/entries";
import { customerInvoices, invoiceLines } from "@/actions/returns";
import { allActiveSkus, customers } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReturnPage() {
  const [all, clist] = await Promise.all([allActiveSkus(), customers()]);
  const packs = all.filter((s) => s.motherSkuId);
  return (
    <div>
      <PageHeader
        title="Returns"
        subtitle="Pick the customer, then the invoice it's returned against — its items fill in automatically. Enter qty returned, weighed kg and disposition. Resalable returns re-enter cold room as their mother SKU; waste returns are recorded only."
      />
      <Card>
        <EntryForm
          kind="return"
          action={submitReturn}
          packSkus={packs}
          allSkus={all}
          customers={clist}
          loadInvoices={customerInvoices}
          loadInvoiceLines={invoiceLines}
        />
      </Card>
    </div>
  );
}
