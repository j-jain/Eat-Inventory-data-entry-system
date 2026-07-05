import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
  claimPush,
  classifyWriteError,
  ensurePushRow,
  getPushRow,
  markSuccess,
  markUnknown,
  resolveToPending,
  type PushRowKey,
} from "@/lib/zoho/push-state";
import { ZohoApiError } from "@/lib/zoho/config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  const client = new PGlite(); // in-memory
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  // push-state reads the app-wide lazy db — inject the test instance through
  // the same global the lazy proxy resolves.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__eatDb = db;
});

const KEY: PushRowKey = {
  kind: "receiving.receive",
  docType: "RECEIVING",
  docId: 101,
  subKey: "doc",
};
const ATTEMPT = { idemRef: "EAT-RCV-101", requestPayload: { x: 1 }, userId: 1 };

describe("zoho_push state machine", () => {
  it("ensure + claim wins exactly once; second claim is rejected", async () => {
    await ensurePushRow(KEY, { idemRef: "EAT-RCV-101", createdBy: 1 });
    await ensurePushRow(KEY); // idempotent
    const first = await claimPush(KEY, ATTEMPT);
    expect(first).not.toBeNull();
    expect(first!.status).toBe("IN_FLIGHT");
    expect(first!.attempts).toBe(1);
    const second = await claimPush(KEY, ATTEMPT); // double-click / bulk race
    expect(second).toBeNull();
  });

  it("SUCCESS is terminal — not claimable", async () => {
    const row = await getPushRow(KEY);
    await markSuccess(row!.id, { zohoId: "999", zohoNumber: "PR-1" });
    expect((await getPushRow(KEY))!.status).toBe("SUCCESS");
    expect(await claimPush(KEY, ATTEMPT)).toBeNull();
  });

  it("UNKNOWN is not claimable until reconciled back to PENDING", async () => {
    const key = { ...KEY, docId: 102 };
    await ensurePushRow(key);
    const claimed = await claimPush(key, ATTEMPT);
    await markUnknown(claimed!.id, "transport error");
    expect(await claimPush(key, ATTEMPT)).toBeNull(); // never blind-retried
    await resolveToPending(claimed!.id);
    const reclaimed = await claimPush(key, ATTEMPT);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.attempts).toBe(2);
  });

  it("FAILED is re-claimable directly", async () => {
    const key = { ...KEY, docId: 103 };
    await ensurePushRow(key);
    const c = await claimPush(key, ATTEMPT);
    await db
      .update(schema.zohoPush)
      .set({ status: "FAILED", error: "400 bad" })
      .where(eq(schema.zohoPush.id, c!.id));
    expect(await claimPush(key, ATTEMPT)).not.toBeNull();
  });

  it("unique key holds per sub_key (bundle lines are independent)", async () => {
    const a = { kind: "assembly.bundle", docType: "ASSEMBLY", docId: 7, subKey: "line:1" } as const;
    const b = { ...a, subKey: "line:2" };
    await ensurePushRow(a);
    await ensurePushRow(b);
    expect(await claimPush(a, ATTEMPT)).not.toBeNull();
    expect(await claimPush(b, ATTEMPT)).not.toBeNull();
  });
});

describe("classifyWriteError", () => {
  it("transport (status 0) and 5xx are UNKNOWN — Zoho may have committed", () => {
    expect(classifyWriteError(new ZohoApiError(0, "transport"))).toBe("UNKNOWN");
    expect(classifyWriteError(new ZohoApiError(500, "ise"))).toBe("UNKNOWN");
    expect(classifyWriteError(new ZohoApiError(502, "bad gw"))).toBe("UNKNOWN");
  });
  it("4xx (incl. exhausted 429) are FAILED — rejected before processing", () => {
    expect(classifyWriteError(new ZohoApiError(429, "rate"))).toBe("FAILED");
    expect(classifyWriteError(new ZohoApiError(400, "bad"))).toBe("FAILED");
    expect(classifyWriteError(new ZohoApiError(401, "auth"))).toBe("FAILED");
  });
  it("non-Zoho errors (builder bugs) are FAILED — nothing was sent", () => {
    expect(classifyWriteError(new Error("boom"))).toBe("FAILED");
  });
});

describe("audit-log backfill (0004)", () => {
  it("maps success/fail/legacy rows, keeps colon sub_keys, success wins", async () => {
    // wipe state from earlier tests, then seed audit rows and re-run the
    // backfill statements from the actual migration file
    await db.delete(schema.zohoPush);
    const audit = [
      // success with bundle line sub_key (colon inside)
      { action: "ZOHO_PUSH:assembly.bundle:line:7", docType: "ASSEMBLY", docId: 5, payload: { zohoId: "b1" } },
      // fail AFTER a success for the same key — success must win
      { action: "ZOHO_PUSH:receiving.receive:doc", docType: "RECEIVING", docId: 9, payload: { zohoId: "r9" } },
      { action: "ZOHO_PUSH_FAIL:receiving.receive:doc", docType: "RECEIVING", docId: 9, payload: { error: "later fail" } },
      // pure fail
      { action: "ZOHO_PUSH_FAIL:receiving.bill:doc", docType: "RECEIVING", docId: 9, payload: { error: "no vendor" } },
      // legacy v1 adjustment
      { action: "ZOHO_DRAFT_CREATED", docType: "INV_ADJUSTMENT", docId: 3, payload: { zohoId: "adj3" } },
      // po.update must be excluded
      { action: "ZOHO_PUSH:po.update:555", docType: "PURCHASE_ORDER", docId: 0, payload: {} },
    ];
    for (const a of audit) await db.insert(schema.appAuditLog).values({ userId: 1, ...a });

    const sqlText = readFileSync("./drizzle/0004_zoho_push_backfill.sql", "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint")) {
      const clean = stmt.trim();
      if (clean) await db.execute(sql.raw(clean));
    }

    const rows = await db.select().from(schema.zohoPush);
    const by = (k: string, t: string, i: number, sk: string) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows.find((r: any) => r.kind === k && r.docType === t && r.docId === i && r.subKey === sk);

    expect(by("assembly.bundle", "ASSEMBLY", 5, "line:7")?.status).toBe("SUCCESS");
    expect(by("assembly.bundle", "ASSEMBLY", 5, "line:7")?.zohoId).toBe("b1");
    expect(by("receiving.receive", "RECEIVING", 9, "doc")?.status).toBe("SUCCESS"); // success wins
    expect(by("receiving.bill", "RECEIVING", 9, "doc")?.status).toBe("FAILED");
    expect(by("receiving.bill", "RECEIVING", 9, "doc")?.error).toContain("no vendor");
    expect(by("adjustment.adj", "INV_ADJUSTMENT", 3, "doc")?.status).toBe("SUCCESS");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(rows.some((r: any) => r.kind === "po.update")).toBe(false);
  });
});
