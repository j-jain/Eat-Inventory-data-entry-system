/**
 * Write guard for Zoho. The app is otherwise HARD read-only (see ./guard.ts).
 * This narrowly permits ONLY draft-creating POSTs to an explicit allowlist of
 * endpoints. There is intentionally NO update / delete / patch helper anywhere
 * in lib/zoho — the only write function is `zohoCreateDraft` in ./write.ts.
 * Anything that is not a whitelisted POST throws.
 */

/**
 * Allowlisted draft-create endpoint paths (URL pathname, no host/query). Extend
 * ONE AT A TIME as each tab's mapping is wired and verified against Zoho. Keep
 * this list to create-only endpoints — never add an update/delete/convert path.
 */
export const DRAFT_CREATE_PATHS = [
  "/inventory/v1/inventoryadjustments",
] as const;

export function assertDraftCreate(method: string, path: string): void {
  if (method.toUpperCase() !== "POST") {
    throw new Error(
      `Zoho write is CREATE-ONLY (drafts): ${method} is blocked. No update/delete is permitted.`,
    );
  }
  const allowed = DRAFT_CREATE_PATHS.some((p) => path === p || path.startsWith(p + "/"));
  if (!allowed) {
    throw new Error(
      `Zoho write blocked: "${path}" is not an allowed draft-create endpoint.`,
    );
  }
}
