import { cache } from "react";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { NAV_LINKS, type NavRole } from "@/components/nav-links";
import { getSession, type Role, type Session } from "./session";

/**
 * Per-user page access (v3).
 *
 * The JWT is identity-only; on every request the layout/pages load the live
 * user row (React cache() dedupes it within the request), so blocking a user,
 * changing their role, or editing their page list applies IMMEDIATELY — not
 * at next login.
 *
 * A user's effective page set = `users.allowed_pages` when set, else the
 * role default derived from NAV_LINKS min-roles. Nav filtering uses the same
 * set (cosmetic); the real gates are `requirePageAccess()` in each page plus
 * the role checks inside every server action.
 */

const ORDER: Record<NavRole, number> = { FLOOR: 0, SUPERVISOR: 1, MANAGER: 2, ADMIN: 3 };

/** Page registry for the Users admin UI (serializable). */
export const PAGE_DEFS = NAV_LINKS.map((l) => ({
  href: l.href,
  label: l.label,
  group: l.group || "General",
}));

export const ALL_PAGE_HREFS = NAV_LINKS.map((l) => l.href);

export function roleDefaultPages(role: Role): string[] {
  return NAV_LINKS.filter((l) => ORDER[role] >= ORDER[l.min ?? "FLOOR"]).map((l) => l.href);
}

/** Kept as a record for callers that want all four at once (docs, admin UI). */
export const ROLE_DEFAULT_PAGES: Record<Role, string[]> = {
  FLOOR: roleDefaultPages("FLOOR"),
  SUPERVISOR: roleDefaultPages("SUPERVISOR"),
  MANAGER: roleDefaultPages("MANAGER"),
  ADMIN: roleDefaultPages("ADMIN"),
};

export type Access = {
  session: Session;
  /** live role from DB (JWT may be stale after a role change) */
  role: Role;
  pages: Set<string>;
};

/** Load the live user row once per request. Returns null when logged out OR
 *  the account has been blocked since the session was issued. */
export const currentAccess = cache(async (): Promise<Access | null> => {
  const session = await getSession();
  if (!session) return null;
  const rows = await db
    .select({
      role: users.role,
      isActive: users.isActive,
      allowedPages: users.allowedPages,
    })
    .from(users)
    .where(eq(users.id, session.uid))
    .limit(1);
  const u = rows[0];
  if (!u || !u.isActive) return null;
  const custom = Array.isArray(u.allowedPages) ? (u.allowedPages as string[]) : null;
  const pages = new Set(custom ?? roleDefaultPages(u.role));
  // ADMIN can never lock themselves out of admin surfaces
  if (u.role === "ADMIN") for (const p of ALL_PAGE_HREFS) pages.add(p);
  // /dashboard is the safe landing page for everyone — removing it would
  // send requirePageAccess into a redirect loop
  pages.add("/dashboard");
  return { session: { ...session, role: u.role }, role: u.role, pages };
});

export function pageAllowed(access: Access, href: string): boolean {
  // A registered page is matched EXACTLY — "/purchase-orders/new" never
  // inherits from "/purchase-orders". Only unregistered deeper paths
  // (e.g. /purchase-orders/123/edit, /dashboard/sku/9) inherit their
  // longest registered parent.
  if (ALL_PAGE_HREFS.includes(href)) return access.pages.has(href);
  const parent = ALL_PAGE_HREFS.filter((p) => href.startsWith(p + "/")).sort(
    (a, b) => b.length - a.length,
  )[0];
  return parent ? access.pages.has(parent) : false;
}

/** Server-component gate: redirects to /login when logged out or blocked,
 *  to /dashboard when the page isn't in the user's set. */
export async function requirePageAccess(href: string): Promise<Access> {
  const access = await currentAccess();
  if (!access) redirect("/login");
  if (!pageAllowed(access, href)) redirect("/dashboard");
  return access;
}
