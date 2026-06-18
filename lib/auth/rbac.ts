import { redirect } from "next/navigation";
import { getSession, type Session, type Role } from "./session";

const ORDER: Record<Role, number> = { FLOOR: 0, SUPERVISOR: 1, ADMIN: 2 };

/** Require a logged-in user; redirect to /login otherwise. */
export async function requireUser(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** Require at least the given role. Throws (caught by the action) if too low. */
export async function requireRole(min: Role): Promise<Session> {
  const s = await requireUser();
  if (ORDER[s.role] < ORDER[min]) {
    throw new Error(`Forbidden: this action requires ${min} role.`);
  }
  return s;
}

export const requireSupervisor = () => requireRole("SUPERVISOR");
export const requireAdmin = () => requireRole("ADMIN");

export function hasRole(role: Role, min: Role): boolean {
  return ORDER[role] >= ORDER[min];
}
