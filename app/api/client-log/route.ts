import { getSession } from "@/lib/auth/session";
import { logSystem } from "@/lib/log";

export const dynamic = "force-dynamic";

// Per-instance token bucket — a crash-looping client must not turn the
// diagnostics channel into a DB write flood.
let windowStart = 0;
let count = 0;

/**
 * Receives client-side render crashes from the (app) error boundary and lands
 * them in system_log, so Admin → Developer finally shows the crash class that
 * instrumentation.ts (server-only) can't see.
 */
export async function POST(req: Request) {
  const s = await getSession(); // jose JWT verify, no DB hit
  if (!s) return new Response(null, { status: 401 });

  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    count = 0;
  }
  if (++count > 10) return new Response(null, { status: 429 });

  let body: { message?: string; digest?: string; stack?: string; path?: string } = {};
  try {
    body = JSON.parse((await req.text()).slice(0, 10_000));
  } catch {
    // log what we can — an unparseable body still means a crash happened
  }
  await logSystem(
    "ERROR",
    "client",
    (body.message ?? "client render error").slice(0, 4000),
    { digest: body.digest, path: body.path, stack: body.stack?.slice(0, 2000) },
    s.uid,
  );
  return new Response(null, { status: 204 });
}
