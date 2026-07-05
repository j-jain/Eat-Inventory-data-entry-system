import { PageHeader } from "@/components/PageHeader";
import { ReviewClient, type ZohoUiBases } from "@/components/ReviewClient";
import { hasRole } from "@/lib/auth/rbac";
import { requirePageAccess } from "@/lib/auth/access";
import { pushHistory, reviewQueue } from "@/lib/zoho/review";
import { poWorkspace } from "@/lib/zoho/po-workspace";
import { combinedZohoStock } from "@/lib/ledger/balance";
import { zohoConfig } from "@/lib/zoho/config";

export const dynamic = "force-dynamic";

/** Best-effort deep links into the Zoho web UI (server-side: needs dc + org). */
function zohoUiBases(): ZohoUiBases {
  if (!zohoConfig.orgId) return { inventory: null, books: null };
  const dc = process.env.ZOHO_DC || "in";
  return {
    inventory: `https://inventory.zoho.${dc}/app/${zohoConfig.orgId}#`,
    books: `https://books.zoho.${dc}/app/${zohoConfig.orgId}#`,
  };
}

export default async function ReviewPage() {
  const { session: s } = await requirePageAccess("/review");
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
  const [rows, stock, pos, history] = await Promise.all([
    reviewQueue(),
    combinedZohoStock(),
    poWorkspace(),
    pushHistory(),
  ]);
  return (
    <div>
      <PageHeader
        title="Review & Push"
        subtitle="Everything entered in the app stays here until you review it and push it into Zoho. Each card says exactly where the data lands."
      />
      {!zohoConfig.enabled && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Zoho is not configured — pushes will fail until the ZOHO_* env vars are set.
        </div>
      )}
      <ReviewClient rows={rows} stock={stock} pos={pos} history={history} zohoUi={zohoUiBases()} />
    </div>
  );
}
