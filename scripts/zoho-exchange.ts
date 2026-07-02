/**
 * One-shot: exchange a Zoho Self Client GRANT CODE for a long-lived REFRESH
 * TOKEN (with write scopes), so the app can push DRAFTS to Zoho.
 *
 * You do NOT need a new Zoho OAuth app — reuse the existing ZOHO_CLIENT_ID /
 * ZOHO_CLIENT_SECRET. You only need a refresh token that includes write scopes.
 *
 * Steps:
 *   1. Go to the Zoho API Console:  https://api-console.zoho.in  (use .com etc.
 *      to match your ZOHO_DC). Open your Self Client (or add a "Self Client").
 *   2. "Generate Code" with these scopes (comma-separated, NO spaces).
 *
 *      RECOMMENDED (keeps current read sync working + adds inventory-adjustment
 *      drafts, and grants NO delete power anywhere):
 *        ZohoInventory.items.READ,ZohoInventory.purchaseorders.READ,ZohoInventory.contacts.READ,ZohoInventory.inventoryadjustments.CREATE,ZohoInventory.inventoryadjustments.READ,ZohoBooks.contacts.READ,ZohoBooks.invoices.READ
 *
 *      SIMPLE fallback (works, but the token itself can do more — the app's
 *      create-only guard still blocks everything except draft creation):
 *        ZohoInventory.FullAccess.all,ZohoBooks.fullaccess.all
 *
 *      (Add ZohoInventory.compositeitems.CREATE / ZohoBooks.creditnotes.CREATE
 *      later when Assembly / Returns drafts are wired.)
 *   3. Pick a short duration (e.g. 10 min) and the org. Copy the generated code.
 *   4. Run:  npx tsx scripts/zoho-exchange.ts <GRANT_CODE>
 *   5. Copy the printed refresh_token into .env.local as ZOHO_REFRESH_TOKEN
 *      (replace the existing one), then restart the dev server.
 *
 * This script only PRINTS the token — it does not write any files.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const dc = process.env.ZOHO_DC || "in";
const accounts = `https://accounts.zoho.${dc}`;

async function main() {
  const code = process.argv[2];
  if (!code) {
    console.error("Usage: npx tsx scripts/zoho-exchange.ts <GRANT_CODE>");
    process.exit(1);
  }
  const clientId = process.env.ZOHO_CLIENT_ID || "";
  const clientSecret = process.env.ZOHO_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    console.error("ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET missing from .env.local");
    process.exit(1);
  }
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });
  // Self Client codes don't use a redirect; standard clients may pass argv[3].
  const redirect = process.argv[3];
  if (redirect) params.set("redirect_uri", redirect);

  const res = await fetch(`${accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    error?: string;
    scope?: string;
  };
  if (!json.refresh_token) {
    console.error("✗ No refresh_token returned:", JSON.stringify(json).slice(0, 300));
    console.error(
      "  (Grant codes expire fast and are single-use — regenerate in the API console and retry.)",
    );
    process.exit(1);
  }
  console.log("✓ Success. Put this in .env.local as ZOHO_REFRESH_TOKEN:\n");
  console.log("ZOHO_REFRESH_TOKEN=" + json.refresh_token);
  if (json.scope) console.log("\nGranted scopes:", json.scope);
  console.log("\nThen restart the dev server.");
  process.exit(0);
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
