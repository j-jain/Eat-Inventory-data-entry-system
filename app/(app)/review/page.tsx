import { PageHeader } from "@/components/PageHeader";
import { ReviewClient } from "@/components/ReviewClient";
import { requireUser, hasRole } from "@/lib/auth/rbac";
import { reviewQueue } from "@/lib/zoho/review";
import { combinedZohoStock } from "@/lib/ledger/balance";
import { zohoConfig } from "@/lib/zoho/config";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const s = await requireUser();
  if (!hasRole(s.role, "MANAGER")) {
    return (
      <div>
        <PageHeader title="Review & Push" subtitle="Zoho staging area" />
        <div className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500 shadow-sm">
          Only Aniket (manager) can review and push data into Zoho.
        </div>
      </div>
    );
  }
  const [rows, stock] = await Promise.all([reviewQueue(), combinedZohoStock()]);
  return (
    <div>
      <PageHeader
        title="Review & Push"
        subtitle="Everything entered in the app stays here until you review it and push it into Zoho. Each button says exactly where the data lands."
      />
      {!zohoConfig.enabled && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Zoho is not configured — pushes will fail until the ZOHO_* env vars are set.
        </div>
      )}
      <ReviewClient rows={rows} stock={stock} />
    </div>
  );
}
