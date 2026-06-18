import * as schema from "./schema";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";

/**
 * Database connection.
 *
 * Production (Vercel + Neon): set DATABASE_URL → uses @neondatabase/serverless
 *   Pool over WebSocket, which supports real interactive transactions
 *   (SELECT ... FOR UPDATE), required by the ledger post-service.
 *
 * Local dev / verification (no DATABASE_URL): falls back to PGlite, an
 *   in-process WASM Postgres — no external database needed. Real Postgres,
 *   so generated columns, CHECK constraints and triggers all work.
 */
export type DB = NeonDatabase<typeof schema>;

declare global {
  // eslint-disable-next-line no-var
  var __eatDb: DB | undefined;
}

function createDb(): DB {
  const url = process.env.DATABASE_URL;

  if (url) {
    // Neon serverless (WebSocket pool → supports transactions)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool, neonConfig } = require("@neondatabase/serverless");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ws = require("ws");
    neonConfig.webSocketConstructor = ws;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle } = require("drizzle-orm/neon-serverless");
    const pool = new Pool({ connectionString: url });
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
