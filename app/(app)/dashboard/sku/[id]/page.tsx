import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { skus } from "@/lib/db/schema";
import { skuLedger } from "@/lib/ledger/balance";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

export default async function SkuLedgerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const skuId = Number(id);
  const [sku] = await db.select().from(skus).where(eq(skus.id, skuId));
  const ledger = await skuLedger(skuId);

  if (!sku) return <div className="text-neutral-500">SKU not found.</div>;

  return (
    <div>
      <Link href="/dashboard" className="text-sm text-brand-800 hover:underline">
        ← Live Inventory
      </Link>
      <div className="mt-2">
        <PageHeader
          title={`${sku.code} — ${sku.name}`}
          subtitle={`${sku.channel} · ${sku.uom}${sku.packSizeText ? " · " + sku.packSizeText : ""}`}
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Movement</th>
              <th className="px-4 py-2 font-medium">Location</th>
              <th className="px-4 py-2 text-right font-medium">Qty</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
              <th className="px-4 py-2 font-medium">Doc</th>
              <th className="px-4 py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {ledger.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-neutral-400">
                  No movements yet
                </td>
              </tr>
            )}
            {ledger.map((m) => {
              const neg = Number(m.qtySigned) < 0;
              return (
                <tr key={m.id} className="border-t border-neutral-50">
                  <td className="px-4 py-1.5 text-neutral-500">
                    {new Date(m.createdAt).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                    })}
                  </td>
                  <td className="px-4 py-1.5">{m.movementType}</td>
                  <td className="px-4 py-1.5 text-neutral-500">{m.locationCode}</td>
                  <td className={`px-4 py-1.5 text-right font-mono ${neg ? "text-red-600" : "text-brand-800"}`}>
                    {Number(m.qtySigned).toFixed(3)}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono">{Number(m.balanceAfter).toFixed(3)}</td>
                  <td className="px-4 py-1.5 text-neutral-500">
                    {m.docType} #{m.docId}
                  </td>
                  <td className="px-4 py-1.5 text-neutral-400">{m.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
