/**
 * CLIENT-SAFE labels: exactly where each push lands inside Zoho, rendered
 * verbatim next to every push button (owner requirement: "next to every Push
 * button, clearly written where exactly that information will be pushed").
 *
 * No server imports here — this module is bundled into client components.
 */
export type ZohoPushKind =
  | "receiving.receive"
  | "receiving.bill"
  | "wastage.adj"
  | "adjustment.adj"
  | "assembly.bundle"
  | "podraft.create"
  | "po.update";

export const ZOHO_PUSH_LABELS: Record<ZohoPushKind, string> = {
  "receiving.receive": "→ Zoho Inventory › Purchase Receives (live)",
  "receiving.bill": "→ Zoho Books › Bills (live)",
  "wastage.adj": "→ Zoho Inventory › Inventory Adjustments (applies immediately)",
  "adjustment.adj": "→ Zoho Inventory › Inventory Adjustments (applies immediately)",
  "assembly.bundle": "→ Zoho Inventory › Bundles (live)",
  "podraft.create": "→ Zoho Inventory › Purchase Orders (draft)",
  "po.update": "→ Zoho Inventory › Purchase Orders (edits the live PO)",
};

/** True when the push creates/edits a real (non-draft) record in Zoho. */
export const ZOHO_PUSH_IS_LIVE: Record<ZohoPushKind, boolean> = {
  "receiving.receive": true,
  "receiving.bill": true,
  "wastage.adj": true,
  "adjustment.adj": true,
  "assembly.bundle": true,
  "podraft.create": false, // Zoho POs are created in draft status
  "po.update": true,
};
