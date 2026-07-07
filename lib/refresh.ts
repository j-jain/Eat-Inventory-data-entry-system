/**
 * Guarded background refresh for polling pages. A failed router.refresh()
 * (server threw, or the device's network blipped) replaces the page with the
 * error boundary — deadly for an unattended floor tablet. So prove server +
 * DB are reachable via /api/health first (which also re-warms a pool
 * connection dropped during a serverless freeze) and silently skip the tick
 * otherwise: 10–15s of stale numbers beat a crash page.
 */
export async function refreshIfHealthy(router: { refresh: () => void }): Promise<void> {
  try {
    // Timeout so a hung preflight can't stack up behind the poll interval.
    const r = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return;
  } catch {
    return;
  }
  router.refresh();
}
