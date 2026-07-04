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

  let created = 0;
  for (const u of SEED_USERS) {
    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.fullName}) = lower(${u.fullName})`);
    if (existing.length) continue;
    const pinHash = await hashPin(u.pin);
    await db
      .insert(schema.users)
      .values({ fullName: u.fullName, role: u.role, pinHash });
    created++;
  }
  console.log(
    `✓ users: ${created} created (Admin/1234, Supervisor/1111, Ramesh/0000) — change PINs after first login`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
