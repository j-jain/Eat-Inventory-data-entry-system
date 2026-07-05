import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

const COOKIE = "eat_session";
// 30 days — "remember this device". The JWT is identity-only: role, active
// status and page permissions are re-read from the DB on every request
// (lib/auth/access.ts), so a long session can't outlive a block/role change.
const MAX_AGE = 60 * 60 * 24 * 30;

export type Role = "FLOOR" | "SUPERVISOR" | "MANAGER" | "ADMIN";
export type Session = { uid: number; name: string; role: Role };

const secret = () =>
  new TextEncoder().encode(
    process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me-please-32+",
  );

export async function createSession(s: Session): Promise<void> {
  const token = await new SignJWT({ uid: s.uid, name: s.name, role: s.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret());
  const c = await cookies();
  c.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function getSession(): Promise<Session | null> {
  const c = await cookies();
  const token = c.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      uid: payload.uid as number,
      name: payload.name as string,
      role: payload.role as Role,
    };
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE);
}
