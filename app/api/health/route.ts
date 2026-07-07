import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Preflight for the client pollers (dashboard / pick list): proves server + DB
 * are reachable — and re-warms a pool connection dropped during a serverless
 * freeze — before they risk a router.refresh() that would trip the error
 * boundary on failure. Exposes no data, so no session check.
 */
export async function GET() {
  try {
    await db.execute(sql`SELECT 1`);
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
