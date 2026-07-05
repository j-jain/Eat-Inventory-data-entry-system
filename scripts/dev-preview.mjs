/**
 * Isolated preview dev server: local PGlite DB + dummy Zoho credentials.
 * A Node launcher (not a shell wrapper) so the env reliably reaches next dev
 * on Windows — empty-string vars vanish from Windows child environments and
 * shell prefixes don't survive every spawn chain.
 *
 * Run: npm run dev:preview   (after: FORCE_PGLITE=1 npm run db:migrate + db:seed)
 */
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  FORCE_PGLITE: "1",
  PGLITE_DIR: "./.pglite-preview",
  ZOHO_ENABLED: "true",
  ZOHO_DC: "in",
  ZOHO_ORG_ID: "000preview",
  ZOHO_CLIENT_ID: "preview-dummy",
  ZOHO_CLIENT_SECRET: "preview-dummy",
  ZOHO_REFRESH_TOKEN: "preview-dummy",
  CRON_SECRET: "preview-secret",
  ALLOW_RESET: "true",
};

console.log("[dev-preview] FORCE_PGLITE=1 → local ./.pglite-preview, Zoho creds are dummies");
const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "dev"],
  { env, stdio: "inherit", shell: process.platform === "win32" },
);
child.on("exit", (code) => process.exit(code ?? 0));
