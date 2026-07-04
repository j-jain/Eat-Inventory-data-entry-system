import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { hasRole } from "@/lib/auth/rbac";
import { combinedZohoStock } from "@/lib/ledger/balance";

export const dynamic = "force-dynamic";

/** MANAGER-only feed: Zoho stock + local unpushed deltas per SKU. */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasRole(s.role, "MANAGER"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rows = await combinedZohoStock();
  return NextResponse.json({ at: new Date().toISOString(), rows });
}
