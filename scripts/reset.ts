/**
 * Clear all transactional data (ledger, balances, all sheet docs/lines) while
 * keeping SKUs, users and locations. Run: npx tsx scripts/reset.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { sql } from "drizzle-orm";

const TABLES = [
  "stock_ledger",
  "stock_balance",
  "receiving_line",
  "receiving_doc",
  "sorting_line",
  "sorting_doc",
  "assembly_line",
  "assembly_doc",
  "wastage_line",
  "wastage_doc",
  "return_line",
  "return_doc",
  "inv_adjustment_line",
  "inv_adjustment_doc",
  "dispatch_line",
  "dispatch_doc",
  "opening_doc",
];

async function main() {
  const { db } = await import("../lib/db");
  // disable the append-only trigger so we can truncate during dev reset
  await db.execute(sql`ALTER TABLE stock_ledger DISABLE TRIGGER trg_ledger_no_delete`);
  for (const t of TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${t}`));
  }
  await db.execute(sql`ALTER TABLE stock_ledger ENABLE TRIGGER trg_ledger_no_delete`);
  console.log(`✓ reset ${TABLES.length} transactional tables (skus/users/locations kept)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
