import { getToken } from "./token";
import { zohoConfig, ZohoApiError } from "./config";
import { assertDraftCreate } from "./write-guard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withOrg(url: string): string {
  const u = new URL(url);
  if (zohoConfig.orgId) u.searchParams.set("organization_id", zohoConfig.orgId);
  return u.toString();
}

/**
 * Create-only Zoho write: POSTs a single DRAFT document to an allowlisted
 * endpoint (enforced by assertDraftCreate). Mirrors zohoGet's auth shape but is
 * deliberately conservative about retries — a POST is NOT idempotent, so we only
 * retry on 401 (refresh, request was rejected before processing) and 429 (rate
 * limited, not processed). Transport/5xx errors throw immediately rather than
 * risk creating a duplicate draft. There is no update/delete counterpart.
 */
export async function zohoCreateDraft<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  attempts = 3,
): Promise<T> {
  assertDraftCreate("POST", new URL(url).pathname);
  let token = await getToken();
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(withOrg(url), {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) {
      // transport error — do NOT retry a POST (could have been applied)
      throw new ZohoApiError(0, `Zoho POST transport error: ${String(e)}`);
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
  throw new ZohoApiError(0, "Zoho POST failed (auth/rate-limit retries exhausted).");
}
