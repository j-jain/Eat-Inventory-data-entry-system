/**
 * Standalone Zoho connectivity check — refreshes a token and reads each
 * endpoint. Pure HTTP, no DB (safe to run while the dev server is up).
 * Run: npx tsx scripts/zoho-check.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

const dc = process.env.ZOHO_DC || "in";
const org = process.env.ZOHO_ORG_ID || "";
const accounts = `https://accounts.zoho.${dc}`;
const inv = `https://www.zohoapis.${dc}/inventory/v1`;
const books = `https://www.zohoapis.${dc}/books/v3`;

async function token(): Promise<string> {
  const p = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ZOHO_CLIENT_ID || "",
    client_secret: process.env.ZOHO_CLIENT_SECRET || "",
    refresh_token: process.env.ZOHO_REFRESH_TOKEN || "",
  });
  const r = await fetch(`${accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: p.toString(),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token refresh failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token as string;
}

async function get(t: string, url: string, listKey: string) {
  const u = new URL(url);
  u.searchParams.set("organization_id", org);
  u.searchParams.set("per_page", "200");
  const r = await fetch(u, { headers: { Authorization: `Zoho-oauthtoken ${t}` } });
  if (!r.ok) return { ok: false, status: r.status, body: (await r.text()).slice(0, 160) };
  const j = await r.json();
  const arr = j[listKey] || [];
  const f = arr[0] || {};
  return {
    ok: true,
    countPage1: arr.length,
    more: !!j.page_context?.has_more_page,
    sample: f.name || f.contact_name || f.vendor_name || f.purchaseorder_number || f.invoice_number || null,
  };
}

(async () => {
  const t = await token();
  console.log("✓ token refresh OK");
  console.log("items    ", await get(t, `${inv}/items?status=active`, "items"));
  console.log("vendors  ", await get(t, `${inv}/vendors`, "contacts"));
  console.log("customers", await get(t, `${books}/contacts?contact_type=customer`, "contacts"));
  console.log("pos      ", await get(t, `${inv}/purchaseorders`, "purchaseorders"));
  console.log("invoices ", await get(t, `${books}/invoices`, "invoices"));
  process.exit(0);
})().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
