/**
 * Hard read-only guarantee for v1. Every Zoho HTTP call routes through here;
 * any non-GET method throws. There is intentionally NO post/put/delete helper
 * anywhere in lib/zoho. (Unit-tested.)
 */
export function assertReadOnly(method: string): void {
  if (method.toUpperCase() !== "GET") {
    throw new Error(
      `Zoho is READ-ONLY in v1: ${method} is blocked. Writing to Zoho is a later phase.`,
    );
  }
}
