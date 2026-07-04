/**
 * Write guard for Zoho. The app is otherwise HARD read-only (see ./guard.ts).
 *
 * v2: the single draft-create allowlist grew into an explicit REGISTRY that is
 * simultaneously the security guard and the "where does this land in Zoho"
 * label source. Every write must match one registry entry by BOTH method and
 * path pattern; anything else throws. There is still no DELETE/PATCH anywhere,
 * and the only permitted PUT is the purchase-order edit.
 */
import { ZOHO_PUSH_LABELS, type ZohoPushKind } from "./labels";

export type ZohoWriteEntry = {
  key: ZohoPushKind;
  method: "POST" | "PUT";
  /** Matched against the URL pathname (no host, no query). */
  pathPattern: RegExp;
  /** Exact UI label — where this lands inside Zoho. */
  landsIn: string;
  /** True only for writes that mutate an existing Zoho record. */
  mutatesExisting: boolean;
};

export const ZOHO_WRITES: ZohoWriteEntry[] = [
  {
    key: "adjustment.adj",
    method: "POST",
    pathPattern: /^\/inventory\/v1\/inventoryadjustments$/,
    landsIn: ZOHO_PUSH_LABELS["adjustment.adj"],
    mutatesExisting: false,
  },
  {
    key: "wastage.adj",
    method: "POST",
    pathPattern: /^\/inventory\/v1\/inventoryadjustments$/,
    landsIn: ZOHO_PUSH_LABELS["wastage.adj"],
    mutatesExisting: false,
  },
  {
    key: "receiving.receive",
    method: "POST",
    pathPattern: /^\/inventory\/v1\/purchasereceives$/,
    landsIn: ZOHO_PUSH_LABELS["receiving.receive"],
    mutatesExisting: false,
  },
  {
    key: "receiving.bill",
    method: "POST",
    pathPattern: /^\/books\/v3\/bills$/,
    landsIn: ZOHO_PUSH_LABELS["receiving.bill"],
    mutatesExisting: false,
  },
  {
    key: "assembly.bundle",
    method: "POST",
    pathPattern: /^\/inventory\/v1\/bundles$/,
    landsIn: ZOHO_PUSH_LABELS["assembly.bundle"],
    mutatesExisting: false,
  },
  {
    key: "podraft.create",
    method: "POST",
    pathPattern: /^\/inventory\/v1\/purchaseorders$/,
    landsIn: ZOHO_PUSH_LABELS["podraft.create"],
    mutatesExisting: false,
  },
  {
    key: "po.update",
    method: "PUT",
    pathPattern: /^\/inventory\/v1\/purchaseorders\/\d+$/,
    landsIn: ZOHO_PUSH_LABELS["po.update"],
    mutatesExisting: true,
  },
];

/**
 * Throws unless (method, path) matches a registry entry — every Zoho write
 * flows through here (called by zohoWrite in ./write.ts). DELETE/PATCH can
 * never match; PUT matches only the single purchase-order edit pattern.
 */
export function assertZohoWrite(method: string, path: string): ZohoWriteEntry {
  const m = method.toUpperCase();
  if (m !== "POST" && m !== "PUT") {
    throw new Error(
      `Zoho write blocked: ${m} is never permitted (create + PO-edit only).`,
    );
  }
  const entry = ZOHO_WRITES.find((w) => w.method === m && w.pathPattern.test(path));
  if (!entry) {
    throw new Error(
      `Zoho write blocked: ${m} "${path}" is not in the write registry.`,
    );
  }
  return entry as ZohoWriteEntry;
}

/** @deprecated v1 shim — POST-only path check; prefer zohoWrite + registry. */
export function assertDraftCreate(method: string, path: string): void {
  if (method.toUpperCase() !== "POST") {
    throw new Error(
      `Zoho write is CREATE-ONLY here: ${method} is blocked. Use zohoWrite for the PO edit.`,
    );
  }
  assertZohoWrite("POST", path);
}
