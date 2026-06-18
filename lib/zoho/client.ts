import { getToken } from "./token";
import { zohoConfig, ZohoApiError } from "./config";
import { assertReadOnly } from "./guard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withOrg(url: string): string {
  const u = new URL(url);
  if (zohoConfig.orgId) u.searchParams.set("organization_id", zohoConfig.orgId);
  return u.toString();
}

/**
 * Paced, retrying GET. Mirrors eat-os _request(): 401→refresh+retry,
 * 429→Retry-After, 5xx/transport→exponential backoff, up to `attempts` tries.
 * READ-ONLY: method is forced to GET via the guard.
 */
export async function zohoGet<T = unknown>(
  url: string,
  attempts = 5,
): Promise<T> {
  assertReadOnly("GET");
  let token = await getToken();
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(withOrg(url), {
        method: "GET",
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        token = await getToken(true);
        continue;
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get("Retry-After") ?? 0);
        await sleep(Math.min(60_000, (ra || 2 ** i) * 1000));
        continue;
      }
      if (res.status >= 500) {
        await sleep(Math.min(30_000, 2 ** i * 1000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new ZohoApiError(res.status, text.slice(0, 300));
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (e instanceof ZohoApiError) throw e;
      await sleep(Math.min(30_000, 2 ** i * 1000));
    }
  }
  throw new ZohoApiError(0, `Zoho GET failed after ${attempts} attempts: ${String(lastErr)}`);
}

/** Page through a list endpoint until has_more_page is false (or cap hit). */
export async function zohoPaged<T = Record<string, unknown>>(
  base: string,
  listKey: string,
  extraParams: Record<string, string> = {},
  cap = 40,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= cap; page++) {
    const u = new URL(base);
    u.searchParams.set("per_page", "200");
    u.searchParams.set("page", String(page));
    for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
    const data = await zohoGet<Record<string, unknown>>(u.toString());
    const list = (data[listKey] as T[]) ?? [];
    out.push(...list);
    const ctx = data.page_context as { has_more_page?: boolean } | undefined;
    if (!ctx?.has_more_page) break;
  }
  return out;
}
