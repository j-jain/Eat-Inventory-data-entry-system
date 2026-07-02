import { NextResponse } from "next/server";
import { zohoConfig } from "@/lib/zoho/config";
import {
  lastSyncAt,
  syncItems,
  syncVendors,
  syncCustomers,
  syncPurchaseOrders,
} from "@/lib/zoho/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily Zoho pull, triggered by Vercel Cron (vercel.json → 01:00 UTC = 06:30 IST).
 * Incremental: each entity pulls only what changed since its last successful sync.
 * Protected by CRON_SECRET — Vercel sends `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!zohoConfig.enabled) {
    return NextResponse.json({ error: "zoho not configured" }, { status: 503 });
  }

  const jobs: { entity: "ITEM" | "VENDOR" | "CUSTOMER" | "PO"; fn: (since?: Date) => Promise<number> }[] = [
    { entity: "ITEM", fn: syncItems },
    { entity: "VENDOR", fn: syncVendors },
    { entity: "CUSTOMER", fn: syncCustomers },
    { entity: "PO", fn: syncPurchaseOrders },
  ];

  const results: Record<string, number | string> = {};
  for (const j of jobs) {
    try {
      const since = (await lastSyncAt(j.entity)) ?? undefined;
      results[j.entity] = await j.fn(since);
    } catch (e) {
      // one entity failing shouldn't abort the rest; runSync already logs the error
      results[j.entity] = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return NextResponse.json({ ok: true, at: new Date().toISOString(), results });
}
