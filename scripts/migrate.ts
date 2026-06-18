/**
 * Apply Drizzle migrations from ./drizzle to whichever DB is configured.
 *   - DATABASE_URL set  → Neon serverless (production)
 *   - DATABASE_URL empty → PGlite local (dev/verification)
 *
 * Run: npx tsx scripts/migrate.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

async function main() {
  const url = process.env.DATABASE_URL;
  const migrationsFolder = "./drizzle";

  if (url) {
    const { Pool, neonConfig } = await import("@neondatabase/serverless");
    const ws = (await import("ws")).default;
    neonConfig.webSocketConstructor = ws;
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
    const pool = new Pool({ connectionString: url });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    await pool.end();
    console.log("✓ migrated (Neon)");
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dir = process.env.PGLITE_DIR || "./.pglite-data";
    const client = new PGlite(dir);
    const db = drizzle(client);
    await migrate(db, { migrationsFolder });
    console.log(`✓ migrated (PGlite @ ${dir})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
