import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { liveStock } from "@/lib/ledger/balance";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await liveStock();
  return NextResponse.json({ rows, at: new Date().toISOString() });
}
