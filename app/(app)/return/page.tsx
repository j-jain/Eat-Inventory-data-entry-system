import { PageHeader, Card } from "@/components/PageHeader";
import { EntryForm } from "@/components/EntryForm";
import { submitReturn } from "@/actions/entries";
import { allActiveSkus, customers, recentInvoices } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReturnPage() {
  const [all, clist, invs] = await Promise.all([
    allActiveSkus(),
    customers(),
    recentInvoices(),
  ]);
  const packs = all.filter((s) => s.motherSkuId);
  return (
    <div>
      <PageHeader
        title="Returns"
        subtitle="Match a Zoho sales invoice (else marked pending). Resalable returns re-enter cold room by weighed kg; waste returns are recorded only."
      />
      <Card>
        <EntryForm
          kind="return"
          action={submitReturn}
          packSkus={packs}
          allSkus={all}
          customers={clist}
          invoices={invs.map((i) => ({
            zohoInvoiceId: i.zohoInvoiceId,
            invoiceNumber: i.invoiceNumber,
            customerName: i.customerName,
          }))}
        />
      </Card>
    </div>
  );
}
