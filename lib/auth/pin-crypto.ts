import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Reversible PIN storage for the Admin → Users screen. The owner wants PINs
 * visible and editable in admin; storing them bare would make a DB dump leak
 * every PIN, so they're AES-256-GCM encrypted with a key derived from
 * SESSION_SECRET — DB alone isn't enough, the server secret is also needed.
 * Login verification still uses the bcrypt hash (lib/auth/pin.ts); this is
 * display-only material.
 */
const KEY_SALT = "eat-pin-enc-v1";

function key(): Buffer {
  const secret = process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me-please-32+";
  return scryptSync(secret, KEY_SALT, 32);
}

export function encryptPin(pin: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptPin(stored: string | null): string | null {
  if (!stored) return null;
  try {
    const [v, ivB64, tagB64, encB64] = stored.split(":");
    if (v !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    // wrong SESSION_SECRET or corrupted value — treat as not viewable
    return null;
  }
}
