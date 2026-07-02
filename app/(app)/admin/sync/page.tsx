import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { syncLog } from "@/lib/db/schema";
import { zohoConfig } from "@/lib/zoho/config";
import { PageHeader, Card } from "@/components/PageHeader";
import { SyncPanel } from "@/components/SyncPanel";
import { ResetPanel } from "@/components/ResetPanel";
import { requireAdmin } from "@/lib/auth/rbac";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  await requireAdmin();
  const logs = await db.select().from(syncLog).orderBy(desc(syncLog.id)).limit(20);
  return (
    <div>
      <PageHeader
        title="Zoho Sync (read-only)"
        subtitle="Pull SKUs, stock, vendors, customers, POs and invoices FROM Zoho. v1 never writes back to Zoho."
      />
      <div className="space-y-5">
        <Card>
          <SyncPanel enabled={zohoConfig.enabled} />
        </Card>
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-neutral-700">Recent syncs</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-3 py-1.5 font-medium">Entity</th>
                <th className="px-3 py-1.5 font-medium">Status</th>
                <th className="px-3 py-1.5 text-right font-medium">Rows</th>
                <th className="px-3 py-1.5 font-medium">Started</th>
                <th className="px-3 py-1.5 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-neutral-400">
                    No syncs yet
                  </td>
                </tr>
              )}
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-neutral-50">
                  <td className="px-3 py-1.5">{l.entity}</td>
                  <td className="px-3 py-1.5">{l.status}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{l.rowsPulled ?? 0}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-neutral-500">
                    {new Date(l.startedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                  </td>
                  <td className="px-3 py-1.5 text-red-500">{l.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {process.env.ALLOW_RESET === "true" && <ResetPanel />}
      </div>
    </div>
  );
}
