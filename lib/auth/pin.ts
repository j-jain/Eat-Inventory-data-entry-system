import bcrypt from "bcryptjs";

/**
 * PIN hashing. 4 digits is weak, so we (a) mix in a server-side pepper and
 * (b) rely on per-user rate-limit/lockout (see actions/auth) as the real
 * defense. ADMIN/override actions are additionally role-gated.
 */
const pepper = () => process.env.PIN_PEPPER ?? "";

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin + pepper(), 10);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin + pepper(), hash);
}
