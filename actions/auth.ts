"use server";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, appAuditLog } from "@/lib/db/schema";
import { verifyPin } from "@/lib/auth/pin";
import { createSession, destroySession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

const LOCK_AFTER = 5;
const LOCK_SECONDS = 60;

export type SignInResult = { ok: true } | { ok: false; error: string };

export async function listLoginUsers() {
  return db
    .select({ id: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(users.fullName);
}

export async function signIn(userId: number, pin: string): Promise<SignInResult> {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  const u = rows[0];
  if (!u || !u.isActive) return { ok: false, error: "Unknown user." };

  if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) {
    const secs = Math.ceil((u.lockedUntil.getTime() - Date.now()) / 1000);
    return { ok: false, error: `Locked. Try again in ${secs}s.` };
  }

  const ok = await verifyPin(pin, u.pinHash);
  if (!ok) {
    const attempts = (u.attempts ?? 0) + 1;
    const lockedUntil =
      attempts >= LOCK_AFTER ? new Date(Date.now() + LOCK_SECONDS * 1000) : null;
    await db
      .update(users)
      .set({ attempts: attempts >= LOCK_AFTER ? 0 : attempts, lockedUntil })
      .where(eq(users.id, userId));
    return {
      ok: false,
      error: lockedUntil ? `Too many tries. Locked ${LOCK_SECONDS}s.` : "Wrong PIN.",
    };
  }

  await db
    .update(users)
    .set({ attempts: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, userId));
  await db.insert(appAuditLog).values({ userId, action: "LOGIN" });
  await createSession({ uid: u.id, name: u.fullName, role: u.role });
  return { ok: true };
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}
