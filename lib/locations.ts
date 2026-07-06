import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { locations } from "@/lib/db/schema";

// No module-level cache: on serverless each instance would hold its own copy,
// and the locations table is tiny — an indexed lookup per call is fine.
export async function locationId(code: string): Promise<number> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.code, code));
  if (!rows[0]) throw new Error(`Location ${code} not seeded`);
  return rows[0].id;
}
