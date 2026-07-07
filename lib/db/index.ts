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
  // FORCE_PGLITE=1 pins the in-process DB even when DATABASE_URL is set —
  // the reliable local-isolation switch on Windows, where an empty-string
  // env var is silently dropped from child-process environment blocks.
  const url = process.env.FORCE_PGLITE === "1" ? undefined : process.env.DATABASE_URL;

  if (url) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { drizzle } = require("drizzle-orm/node-postgres");
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    // Supabase session-mode pooling (port 5432 on the pooler host) caps
    // concurrent clients at pool_size — a handful of serverless instances
    // exhausts it and every further request 500s. Transaction mode (:6543)
    // is the only mode that scales on Vercel (see DEPLOY.md §1).
    if (/pooler\.supabase\.com:5432/.test(url))
      console.warn(
        "[db] DATABASE_URL uses Supabase's SESSION pooler (:5432) — use the transaction pooler (:6543) on serverless or connections will be exhausted",
      );
    const pool = new Pool({
      connectionString: url,
      // Serverless instances multiply pools, so each must stay modest — but a
      // single dashboard render fans out 5 parallel queries, so 3 self-starves.
      // 8 fits one full fan-out with headroom; even ~20 warm instances stay
      // under Supavisor's default client limit.
      max: Number(process.env.DB_POOL_MAX ?? (process.env.VERCEL ? 8 : 5)),
      connectionTimeoutMillis: 10_000,
      // A hung query must fail fast, not squat on a pool slot until the Vercel
      // function limit. statement_timeout is server-side (the transaction
      // pooler may strip startup params); query_timeout is the client-side
      // backstop that always applies, 2s wider so the clean server cancel
      // (57014) wins when it can.
      statement_timeout: 10_000,
      query_timeout: 12_000,
      // Short: a connection idling across a serverless freeze comes back as a
      // dead socket, so the less time spent idle the better.
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      keepAlive: true,
      // TLS in transit, but certificate validation is off — Supabase's pooler
      // presents a cert most Node images can't chain. Acceptable for this
      // deployment (Vercel ↔ Supabase over their backbones); to pin instead,
      // download Supabase's CA and pass { ca } here.
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });
    // The pooler reaps idle connections; without a listener that 'error'
    // event is unhandled and takes down the whole process.
    pool.on("error", (e: Error) => console.error("[db] idle pool client error:", e.message));

    // A frozen instance loses idle sockets silently; the first query on one
    // fails, a fresh connection works. Retry exactly once, and only for
    // connection-class failures — SQL errors must surface. db.transaction()
    // uses pool.connect(), which is deliberately NOT retried (replaying half
    // a transaction is worse than failing it).
    const retriable = (e: unknown): boolean => {
      const { code, message } = (e ?? {}) as { code?: string; message?: string };
      return (
        ["57P01", "08001", "08003", "08006"].includes(code ?? "") ||
        /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|timeout exceeded when trying to connect/i.test(
          message ?? "",
        )
      );
    };
    const origQuery = pool.query.bind(pool);
    pool.query = (...args: unknown[]) => {
      // callback form bypasses the retry (drizzle only uses promises)
      if (typeof args[args.length - 1] === "function") return origQuery(...args);
      return origQuery(...args).catch((e: unknown) => {
        if (!retriable(e)) throw e;
        console.warn("[db] retrying after connection error:", (e as Error).message);
        return origQuery(...args);
      });
    };
    return drizzle(pool, { schema, casing: "snake_case" }) as DB;
  }

  // PGlite is per-process and file-backed: on Vercel every instance would get
  // its own empty throwaway DB (data "randomly" differing between devices).
  // A missing DATABASE_URL in production is always a misconfiguration.
  if (process.env.FORCE_PGLITE !== "1" && (process.env.VERCEL || process.env.NODE_ENV === "production"))
    throw new Error(
      "DATABASE_URL is not set — refusing PGlite fallback in production. Set it to the Supabase transaction pooler string (…pooler.supabase.com:6543).",
    );

  // PGlite local fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PGlite } = require("@electric-sql/pglite");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/pglite");
  const dir = process.env.PGLITE_DIR || "./.pglite-data";
  console.log(`[db] PGlite @ ${dir} (local, isolated)`);
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
