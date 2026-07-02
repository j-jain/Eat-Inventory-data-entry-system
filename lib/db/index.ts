import * as schema from "./schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Database connection — provider-agnostic.
 *
 * Production: set DATABASE_URL to any managed Postgres pooled connection
 *   (Supabase Mumbai, Neon Singapore, RDS, …) → uses node-postgres, which
 *   supports real interactive transactions (SELECT ... FOR UPDATE) required by
 *   the ledger post-service.
 *
 * Local dev / verification (no DATABASE_URL): falls back to PGlite, an
 *   in-process WASM Postgres — no external database needed.
 */
export type DB = NodePgDatabase<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __eatDb: DB | undefined;
}

function createDb(): DB {
  const url = process.env.DATABASE_URL;

  if (url) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle } = require("drizzle-orm/node-postgres");
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 5),
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });
    return drizzle(pool, { schema, casing: "snake_case" }) as DB;
  }

  // PGlite local fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PGlite } = require("@electric-sql/pglite");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/pglite");
  const dir = process.env.PGLITE_DIR || "./.pglite-data";
  const client = new PGlite(dir);
  return drizzle(client, { schema, casing: "snake_case" }) as unknown as DB;
}

function getDb(): DB {
  if (!globalThis.__eatDb) globalThis.__eatDb = createDb();
  return globalThis.__eatDb;
}

/**
 * Lazy proxy: the real driver is only created on first actual use (a request),
 * never at import/build time. Methods are bound to the real db so Drizzle's
 * `this` works through the proxy.
 */
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export { schema };
