/**
 * Seed starter users (idempotent). Run: npx tsx scripts/seed-users.ts
 * Default PINs are for first login only — change them in Admin.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { sql } from "drizzle-orm";

const SEED_USERS = [
  { fullName: "Admin", role: "ADMIN" as const, pin: "1234" },
  { fullName: "Aniket", role: "MANAGER" as const, pin: "2222" },
  { fullName: "Supervisor", role: "SUPERVISOR" as const, pin: "1111" },
  { fullName: "Ramesh (Floor)", role: "FLOOR" as const, pin: "0000" },
];

async function main() {
  const { db } = await import("../lib/db");
  const schema = await import("../lib/db/schema");
  const { hashPin } = await import("../lib/auth/pin");
  const { encryptPin } = await import("../lib/auth/pin-crypto");
  const { eq, isNull, and } = await import("drizzle-orm");

  let created = 0;
  let backfilled = 0;
  for (const u of SEED_USERS) {
    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.fullName}) = lower(${u.fullName})`);
    if (existing.length) {
      // pre-v3 rows have no viewable PIN — backfill from the known seed
      // default so Admin → Users can display it (no-op if already set)
      const res = await db
        .update(schema.users)
        .set({ pinEnc: encryptPin(u.pin) })
        .where(and(eq(schema.users.id, existing[0].id), isNull(schema.users.pinEnc)))
        .returning({ id: schema.users.id });
      backfilled += res.length;
      continue;
    }
    const pinHash = await hashPin(u.pin);
    await db
      .insert(schema.users)
      .values({ fullName: u.fullName, role: u.role, pinHash, pinEnc: encryptPin(u.pin) });
    created++;
  }
  console.log(
    `✓ users: ${created} created, ${backfilled} viewable-PIN backfills (Admin/1234, Aniket/2222, Supervisor/1111, Ramesh/0000) — change PINs in Admin → Users`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
