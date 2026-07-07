"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary for every app page: a crash shows a friendly
 * recovery card instead of a white screen (important on floor devices).
 * The digest is what to quote when reporting — the full error is in the
 * server logs / Admin → Developer.
 */
// Module-level so they survive the boundary remounting on every error: at most
// one automatic reset / one crash report per window, so a persistent failure
// can't retry-loop or spam system_log.
let lastAutoReset = 0;
let lastReport = 0;

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // Server errors reach system_log via instrumentation.ts; client render
    // crashes would otherwise vanish — ship them to Admin → Developer.
    const now = Date.now();
    if (now - lastReport < 30_000) return;
    lastReport = now;
    fetch("/api/client-log", {
      method: "POST",
      keepalive: true, // survives the reset() remount
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        digest: error.digest,
        stack: error.stack?.slice(0, 2000),
        path: location.pathname,
      }),
    }).catch(() => {}); // reporting must never crash the crash page
  }, [error]);

  // Transient crashes (dead DB connection after a serverless freeze, a network
  // blip mid-refresh) almost always succeed on retry — recover unattended
  // floor devices automatically, but back off hard on persistent failures
  // instead of re-running the failed page's whole query set every 15s.
  useEffect(() => {
    const now = Date.now();
    if (now - lastAutoReset < 60_000) return;
    lastAutoReset = now;
    const t = setTimeout(reset, 5_000 + Math.random() * 5_000);
    return () => clearTimeout(t);
  }, [reset]);

  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm">
      <p className="text-3xl">😵</p>
      <h2 className="mt-2 text-base font-semibold text-ink">Something broke on this page</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Your entered data is safe — saved documents are never lost by a page crash.
        {error.digest ? (
          <>
            {" "}
            Error code: <span className="font-mono text-xs">{error.digest}</span>
          </>
        ) : null}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-ink hover:bg-brand-600"
        >
          Try again
        </button>
        <a
          href="/dashboard"
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
        >
          Go to Live Inventory
        </a>
      </div>
      <p className="mt-3 text-xs text-neutral-400">
        Admins: details are in Admin → Developer (copy the row for Claude).
      </p>
    </div>
  );
}
