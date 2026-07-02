/**
 * Run Zoho read-only syncs into the local cache tables (same code the in-app
 * Admin → Zoho Sync buttons call). Stop the dev server first (PGlite is
 * single-connection). Run: npx tsx scripts/zoho-sync.ts [vendors customers items pos invoices]
 * Default: vendors customers
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  const which = args.length ? args : ["vendors", "customers"];
  const sync = await import("../lib/zoho/sync");
  const map: Record<string, () => Promise<number>> = {
    items: sync.syncItems,
    vendors: sync.syncVendors,
    customers: sync.syncCustomers,
    pos: sync.syncPurchaseOrders,
  };
  for (const k of which) {
    const fn = map[k];
    if (!fn) {
      console.log(`skip unknown: ${k}`);
      continue;
    }
    const t = Date.now();
    try {
      const n = await fn();
      console.log(`✓ ${k}: ${n} rows in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log(`✗ ${k}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
