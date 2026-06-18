import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { locations } from "@/lib/db/schema";

const cache = new Map<string, number>();

export async function locationId(code: string): Promise<number> {
  const hit = cache.get(code);
  if (hit) return hit;
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.code, code));
  if (!rows[0]) throw new Error(`Location ${code} not seeded`);
  cache.set(code, rows[0].id);
  return rows[0].id;
}
