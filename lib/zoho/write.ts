import { getToken } from "./token";
import { zohoConfig, ZohoApiError } from "./config";
import { assertZohoWrite } from "./write-guard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withOrg(url: string): string {
  const u = new URL(url);
  if (zohoConfig.orgId) u.searchParams.set("organization_id", zohoConfig.orgId);
  return u.toString();
}

/**
 * The ONE Zoho write function. Every call must match the write registry
 * (assertZohoWrite) by method + path. Deliberately conservative retries —
 * neither a POST nor a PO PUT is idempotent against Zoho, so we retry only on
 * 401 (token refresh; request was rejected before processing) and 429 (rate
 * limited, not processed). Transport/5xx errors throw immediately rather than
 * risk creating a duplicate record.
 */
export async function zohoWrite<T = Record<string, unknown>>(
  method: "POST" | "PUT",
  url: string,
  body: unknown,
  attempts = 3,
): Promise<T> {
  const u = new URL(url);
  assertZohoWrite(method, u.pathname);
  let token = await getToken();
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(withOrg(url), {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) {
      // transport error — do NOT retry a write (it may have been applied)
      throw new ZohoApiError(0, `Zoho ${method} transport error: ${String(e)}`);
    }
    if (res.status === 401 && i < attempts - 1) {
      token = await getToken(true);
      continue;
    }
    if (res.status === 429 && i < attempts - 1) {
      const ra = Number(res.headers.get("Retry-After") ?? 0);
      await sleep(Math.min(60_000, (ra || 2 ** i) * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new ZohoApiError(res.status, text.slice(0, 500));
    return (text ? JSON.parse(text) : {}) as T;
  }
  throw new ZohoApiError(0, `Zoho ${method} failed (auth/rate-limit retries exhausted).`);
}

/** @deprecated v1 alias — create-only call sites keep working unchanged. */
export async function zohoCreateDraft<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  attempts = 3,
): Promise<T> {
  return zohoWrite<T>("POST", url, body, attempts);
}
