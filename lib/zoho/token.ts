import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { zohoToken } from "@/lib/db/schema";
import { zohoConfig, ZohoNotConfiguredError, ZohoApiError } from "./config";

const BUFFER_MS = 120_000; // refresh 2 min before expiry

// warm in-process memo (helps a hot serverless instance avoid a DB read)
let memo: { token: string; expiresAt: number } | null = null;

/**
 * Return a valid access token, refreshing only when needed. Cached in the
 * zoho_token DB row (serverless functions are ephemeral, so an in-memory cache
 * alone won't survive). Mirrors eat-os get_token().
 */
export async function getToken(force = false): Promise<string> {
  if (!zohoConfig.enabled) throw new ZohoNotConfiguredError();

  const now = Date.now();
  if (!force && memo && memo.expiresAt - BUFFER_MS > now) return memo.token;

  if (!force) {
    const rows = await db.select().from(zohoToken).where(eq(zohoToken.id, 1));
    const row = rows[0];
    if (row && row.expiresAt.getTime() - BUFFER_MS > now) {
      memo = { token: row.accessToken, expiresAt: row.expiresAt.getTime() };
      return row.accessToken;
    }
  }

  // refresh
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: zohoConfig.clientId,
    client_secret: zohoConfig.clientSecret,
    refresh_token: zohoConfig.refreshToken,
  });
  const res = await fetch(`${zohoConfig.accountsBase}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ZohoApiError(res.status, `token refresh failed: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) throw new ZohoApiError(401, `token refresh: ${data.error ?? "no token"}`);

  const expiresAt = new Date(now + (data.expires_in ?? 3600) * 1000);
  memo = { token: data.access_token, expiresAt: expiresAt.getTime() };
  await db
    .insert(zohoToken)
    .values({ id: 1, accessToken: data.access_token, expiresAt })
    .onConflictDoUpdate({
      target: zohoToken.id,
      set: { accessToken: data.access_token, expiresAt, updatedAt: new Date() },
    });
  return data.access_token;
}
