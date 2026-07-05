/** Shared navigation model for the desktop sidebar + mobile bottom sheet.
 *  This is ALSO the page registry for per-user permissions — lib/auth/access
 *  derives the gateable page list from it. Keep hrefs stable. */
export type NavRole = "FLOOR" | "SUPERVISOR" | "MANAGER" | "ADMIN";

export type NavLink = {
  href: string;
  label: string;
  group: "" | "Entry" | "Reference" | "Manager" | "Admin";
  /** minimum role that gets the link by DEFAULT (per-user overrides win) */
  min?: NavRole;
  /** shown in the collapsed icon rail + mobile sheet */
  icon: string;
};

/** v3: visibility is per-user — a link shows iff its href is in the user's
 *  effective page set (computed server-side in lib/auth/access.ts). */
export function navVisiblePages(l: NavLink, allowed: string[]): boolean {
  return allowed.includes(l.href);
}

/** The locked workflow order is reflected top-to-bottom in the Entry group. */
export const NAV_LINKS: NavLink[] = [
  { href: "/dashboard", label: "Live Inventory", group: "", icon: "📊" },
  { href: "/receiving", label: "Receiving", group: "Entry", icon: "📥" },
  { href: "/sorting", label: "Sorting / Grading", group: "Entry", icon: "⚖️" },
  { href: "/regrade", label: "Regrade", group: "Entry", icon: "🔄" },
  { href: "/orders", label: "Orders", group: "Entry", min: "SUPERVISOR", icon: "📝" },
  { href: "/pick-list", label: "Pick List", group: "Entry", icon: "📋" },
  { href: "/assembly", label: "DC Assembly", group: "Entry", icon: "📦" },
  { href: "/dispatch", label: "Dispatch & Delivery", group: "Entry", icon: "🚚" },
  { href: "/return", label: "Returns", group: "Entry", icon: "↩️" },
  { href: "/wastage", label: "Wastage", group: "Entry", icon: "🗑️" },
  { href: "/adjustment", label: "Inventory Adjustment", group: "Entry", min: "SUPERVISOR", icon: "🛠️" },
  { href: "/purchase-orders", label: "Purchase Orders", group: "Reference", min: "SUPERVISOR", icon: "📄" },
  { href: "/summary", label: "Summary Sheets", group: "Reference", min: "SUPERVISOR", icon: "📑" },
  { href: "/review", label: "Review & Push", group: "Manager", min: "MANAGER", icon: "☁️" },
  { href: "/purchase-orders/new", label: "New PO", group: "Manager", min: "MANAGER", icon: "➕" },
  { href: "/admin/skus", label: "SKUs", group: "Admin", min: "ADMIN", icon: "🏷️" },
  { href: "/admin/users", label: "Users", group: "Admin", min: "ADMIN", icon: "👥" },
  { href: "/admin/sync", label: "Zoho Sync", group: "Admin", min: "ADMIN", icon: "🔁" },
  { href: "/admin/dev", label: "Developer", group: "Admin", min: "ADMIN", icon: "🧰" },
];
