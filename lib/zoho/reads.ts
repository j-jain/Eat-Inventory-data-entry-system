import { zohoGet } from "./client";
import { zohoConfig } from "./config";

export type InvoiceSummary = {
  zohoInvoiceId: string;
  invoiceNumber: string | null;
  date: string | null;
  total: number | null;
  status: string | null;
};

export type InvoiceLine = { sku: string | null; name: string | null; qty: number | null };

/** Recent invoices for ONE customer, fetched live on demand (no bulk pre-pull). */
export async function fetchCustomerInvoices(
  customerZohoId: string,
  limit = 50,
): Promise<InvoiceSummary[]> {
  const u = new URL(`${zohoConfig.booksBase}/invoices`);
  u.searchParams.set("customer_id", customerZohoId);
  u.searchParams.set("sort_column", "date");
  u.searchParams.set("sort_order", "D");
  u.searchParams.set("per_page", String(limit));
  const data = await zohoGet<{ invoices?: Record<string, unknown>[] }>(u.toString());
  return (data.invoices ?? []).map((i) => ({
    zohoInvoiceId: String(i.invoice_id),
    invoiceNumber: (i.invoice_number as string) ?? null,
    date: (i.date as string) ?? null,
    total: (i.total as number) ?? null,
    status: (i.status as string) ?? null,
  }));
}

/** Line items for ONE invoice, fetched lazily when a return references it. */
export async function getInvoiceDetail(zohoInvoiceId: string): Promise<{
  invoiceNumber: string | null;
  lines: InvoiceLine[];
}> {
  const data = await zohoGet<{ invoice?: Record<string, unknown> }>(
    `${zohoConfig.booksBase}/invoices/${zohoInvoiceId}`,
  );
  const inv = data.invoice ?? {};
  const lis = (inv.line_items as Record<string, unknown>[]) ?? [];
  return {
    invoiceNumber: (inv.invoice_number as string) ?? null,
    lines: lis.map((li) => ({
      sku: (li.sku as string) ?? null,
      name: (li.name as string) ?? null,
      qty: (li.quantity as number) ?? null,
    })),
  };
}
