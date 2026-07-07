import type { Instrumentation } from "next";

/**
 * Server-error capture into system_log (the Admin → Developer error stream).
 * Without this, page/route/action crashes only reach Vercel's function logs —
 * the crash card's digest had nothing on our side to match against.
 * logSystem is fire-and-forget and swallows its own failures, but the whole
 * body is guarded anyway: observability must never take a request down.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { logSystem } = await import("@/lib/log");
    const e = err as { digest?: string } & Error;
    await logSystem("ERROR", "request", e.message ?? String(err), {
      digest: e.digest,
      path: request.path,
      method: request.method,
      routeType: context.routeType,
      routePath: context.routePath,
      stack: e.stack?.slice(0, 2000),
    });
  } catch {
    // never rethrow from the error hook
  }
};
