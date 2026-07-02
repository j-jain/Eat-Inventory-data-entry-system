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
    const pg = (await import("pg")).default;
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    await pool.end();
    console.log("✓ migrated (Postgres)");
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
