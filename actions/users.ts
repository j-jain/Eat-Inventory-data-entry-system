"use server";

import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { users, appAuditLog } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/rbac";
import { hashPin } from "@/lib/auth/pin";
import { decryptPin, encryptPin } from "@/lib/auth/pin-crypto";
import { ALL_PAGE_HREFS, ROLE_DEFAULT_PAGES } from "@/lib/auth/access";
import type { Role } from "@/lib/auth/session";

export type UserAdminRow = {
  id: number;
  fullName: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  /** decrypted PIN when viewable (null for pre-v3 users until a PIN reset) */
  pin: string | null;
  /** effective page set + whether it's custom or the role default */
  pages: string[];
  customPages: boolean;
};

export async function listUsersAdmin(): Promise<UserAdminRow[]> {
  await requireAdmin();
  const rows = await db.select().from(users).orderBy(users.fullName);
  return rows.map((u) => {
    const custom = Array.isArray(u.allowedPages) ? (u.allowedPages as string[]) : null;
    return {
      id: u.id,
      fullName: u.fullName,
      role: u.role,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
      pin: decryptPin(u.pinEnc),
      pages: custom ?? ROLE_DEFAULT_PAGES[u.role],
      customPages: custom != null,
    };
  });
}

const PinSchema = z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits.");
const NameSchema = z.string().trim().min(2, "Name is too short.").max(60);
const RoleSchema = z.enum(["FLOOR", "SUPERVISOR", "MANAGER", "ADMIN"]);
const PagesSchema = z
  .array(z.string())
  .transform((arr) => arr.filter((p) => ALL_PAGE_HREFS.includes(p)));

export type UserActionResult = { ok: true; id?: number } | { ok: false; error: string };

export async function createUser(input: {
  fullName: string;
  role: Role;
  pin: string;
}): Promise<UserActionResult> {
  const s = await requireAdmin();
  try {
    const fullName = NameSchema.parse(input.fullName);
    const role = RoleSchema.parse(input.role);
    const pin = PinSchema.parse(input.pin);
    const [row] = await db
      .insert(users)
      .values({
        fullName,
        role,
        pinHash: await hashPin(pin),
        pinEnc: encryptPin(pin),
      })
      .returning({ id: users.id });
    await db.insert(appAuditLog).values({
      userId: s.uid,
      action: "USER_CREATED",
      payload: { newUserId: row.id, fullName, role },
    });
    revalidatePath("/admin/users");
    return { ok: true, id: row.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: msg.includes("uq_users_name") ? "A user with this name already exists." : msg,
    };
  }
}

export async function setUserPin(userId: number, pin: string): Promise<UserActionResult> {
  const s = await requireAdmin();
  try {
    const p = PinSchema.parse(pin);
    await db
      .update(users)
      .set({ pinHash: await hashPin(p), pinEnc: encryptPin(p), attempts: 0, lockedUntil: null })
      .where(eq(users.id, userId));
    await db.insert(appAuditLog).values({
      userId: s.uid,
      action: "USER_PIN_SET",
      payload: { targetUserId: userId },
    });
    revalidatePath("/admin/users");
    return { ok: true, id: userId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function setUserActive(userId: number, active: boolean): Promise<UserActionResult> {
  const s = await requireAdmin();
  if (userId === s.uid && !active)
    return { ok: false, error: "You can't block your own account." };
  // never allow blocking the last active admin
  if (!active) {
    const [{ n }] = await db
      .select({ n: sql<number>`COUNT(*)` })
      .from(users)
      .where(sql`${users.role} = 'ADMIN' AND ${users.isActive} = true AND ${users.id} <> ${userId}`);
    const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (target?.role === "ADMIN" && Number(n) === 0)
      return { ok: false, error: "This is the last active ADMIN — it can't be blocked." };
  }
  await db.update(users).set({ isActive: active }).where(eq(users.id, userId));
  await db.insert(appAuditLog).values({
    userId: s.uid,
    action: active ? "USER_UNBLOCKED" : "USER_BLOCKED",
    payload: { targetUserId: userId },
  });
  revalidatePath("/admin/users");
  return { ok: true, id: userId };
}

export async function setUserRole(userId: number, role: Role): Promise<UserActionResult> {
  const s = await requireAdmin();
  try {
    const r = RoleSchema.parse(role);
    if (userId === s.uid && r !== "ADMIN")
      return { ok: false, error: "You can't demote your own account." };
    await db.update(users).set({ role: r }).where(eq(users.id, userId));
    await db.insert(appAuditLog).values({
      userId: s.uid,
      action: "USER_ROLE_SET",
      payload: { targetUserId: userId, role: r },
    });
    revalidatePath("/admin/users");
    return { ok: true, id: userId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** pages = null resets to the role default. Applies on the user's very next
 *  request (access is loaded per-request, not from the JWT). */
export async function setUserPages(
  userId: number,
  pages: string[] | null,
): Promise<UserActionResult> {
  const s = await requireAdmin();
  try {
    const cleaned = pages == null ? null : PagesSchema.parse(pages);
    await db.update(users).set({ allowedPages: cleaned }).where(eq(users.id, userId));
    await db.insert(appAuditLog).values({
      userId: s.uid,
      action: "USER_PAGES_SET",
      payload: { targetUserId: userId, pages: cleaned },
    });
    revalidatePath("/admin/users");
    return { ok: true, id: userId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
