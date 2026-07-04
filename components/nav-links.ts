/** Shared navigation model for the desktop sidebar + mobile bottom sheet. */
export type NavRole = "FLOOR" | "SUPERVISOR" | "MANAGER" | "ADMIN";

export type NavLink = {
  href: string;
  label: string;
  group: "" | "Entry" | "Reference" | "Manager" | "Admin";
  /** minimum role that sees the link (ordering per lib/auth/rbac) */
  min?: NavRole;
};

const ORDER: Record<NavRole, number> = { FLOOR: 0, SUPERVISOR: 1, MANAGER: 2, ADMIN: 3 };

export function navVisible(l: NavLink, role: NavRole): boolean {
  return !l.min || ORDER[role] >= ORDER[l.min];
}

/** The locked workflow order is reflected top-to-bottom in the Entry group. */
export const NAV_LINKS: NavLink[] = [
  { href: "/dashboard", label: "Live Inventory", group: "" },
  { href: "/receiving", label: "Receiving", group: "Entry" },
  { href: "/sorting", label: "Sorting / Grading", group: "Entry" },
  { href: "/regrade", label: "Regrade", group: "Entry" },
  { href: "/orders", label: "Orders", group: "Entry" },
  { href: "/pick-list", label: "Pick List", group: "Entry" },
  { href: "/assembly", label: "DC Assembly", group: "Entry" },
  { href: "/dispatch", label: "Dispatch & Delivery", group: "Entry" },
  { href: "/return", label: "Returns", group: "Entry" },
  { href: "/wastage", label: "Wastage", group: "Entry" },
  { href: "/adjustment", label: "Inventory Adjustment", group: "Entry" },
  { href: "/purchase-orders", label: "Purchase Orders", group: "Reference" },
  { href: "/summary", label: "Summary Sheets", group: "Reference" },
  { href: "/review", label: "Review & Push", group: "Manager", min: "MANAGER" },
  { href: "/purchase-orders/new", label: "New PO", group: "Manager", min: "MANAGER" },
  { href: "/admin/skus", label: "SKUs", group: "Admin", min: "ADMIN" },
  { href: "/admin/sync", label: "Zoho Sync", group: "Admin", min: "ADMIN" },
];
