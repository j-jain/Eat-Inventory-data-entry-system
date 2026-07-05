-- Backfill zoho_push from the audit-log rows that carried push state until v3.
-- Idempotent (ON CONFLICT DO NOTHING against uq_zoho_push_key), so re-running
-- is safe. Order matters: successes first, so failure rows can't shadow them.

-- 1) Successful pushes: ZOHO_PUSH:<kind>:<subKey> (po.update excluded — PO
--    edits legitimately repeat and are not modelled in zoho_push).
INSERT INTO "zoho_push" ("kind", "doc_type", "doc_id", "sub_key", "status", "zoho_id", "pushed_at", "created_at", "created_by")
SELECT DISTINCT ON (split_part(a."action", ':', 2), a."doc_type", a."doc_id", regexp_replace(a."action", '^ZOHO_PUSH:[^:]+:', ''))
       split_part(a."action", ':', 2),
       a."doc_type",
       a."doc_id",
       regexp_replace(a."action", '^ZOHO_PUSH:[^:]+:', ''),
       'SUCCESS',
       NULLIF(a."payload"->>'zohoId', ''),
       a."created_at",
       a."created_at",
       a."user_id"
FROM "app_audit_log" a
WHERE a."action" LIKE 'ZOHO_PUSH:%'
  AND a."action" NOT LIKE 'ZOHO_PUSH:po.update:%'
  AND a."doc_type" IS NOT NULL
  AND a."doc_id" IS NOT NULL
ORDER BY split_part(a."action", ':', 2), a."doc_type", a."doc_id", regexp_replace(a."action", '^ZOHO_PUSH:[^:]+:', ''), a."id" ASC
ON CONFLICT ("kind", "doc_type", "doc_id", "sub_key") DO NOTHING;
--> statement-breakpoint

-- 2) Legacy v1 adjustment pushes (ZOHO_DRAFT_CREATED) count as pushed.
INSERT INTO "zoho_push" ("kind", "doc_type", "doc_id", "sub_key", "status", "zoho_id", "pushed_at", "created_at", "created_by")
SELECT DISTINCT ON (a."doc_id")
       'adjustment.adj', 'INV_ADJUSTMENT', a."doc_id", 'doc', 'SUCCESS',
       NULLIF(a."payload"->>'zohoId', ''), a."created_at", a."created_at", a."user_id"
FROM "app_audit_log" a
WHERE a."action" = 'ZOHO_DRAFT_CREATED'
  AND a."doc_type" = 'INV_ADJUSTMENT'
  AND a."doc_id" IS NOT NULL
ORDER BY a."doc_id", a."id" ASC
ON CONFLICT ("kind", "doc_type", "doc_id", "sub_key") DO NOTHING;
--> statement-breakpoint

-- 3) Failures — only land where no success exists (successes inserted above win
--    via the unique key). Latest failure per key carries the freshest error.
INSERT INTO "zoho_push" ("kind", "doc_type", "doc_id", "sub_key", "status", "error", "created_at", "created_by")
SELECT DISTINCT ON (split_part(a."action", ':', 2), a."doc_type", a."doc_id", regexp_replace(a."action", '^ZOHO_PUSH_FAIL:[^:]+:', ''))
       split_part(a."action", ':', 2),
       a."doc_type",
       a."doc_id",
       regexp_replace(a."action", '^ZOHO_PUSH_FAIL:[^:]+:', ''),
       'FAILED',
       LEFT(COALESCE(a."payload"->>'error', ''), 2000),
       a."created_at",
       a."user_id"
FROM "app_audit_log" a
WHERE a."action" LIKE 'ZOHO_PUSH_FAIL:%'
  AND a."doc_type" IS NOT NULL
  AND a."doc_id" IS NOT NULL
ORDER BY split_part(a."action", ':', 2), a."doc_type", a."doc_id", regexp_replace(a."action", '^ZOHO_PUSH_FAIL:[^:]+:', ''), a."id" DESC
ON CONFLICT ("kind", "doc_type", "doc_id", "sub_key") DO NOTHING;
--> statement-breakpoint

-- 4) Pushed PO drafts whose audit row is missing: po_draft_doc.zoho_po_id is
--    an independent record of success. Also repairs rows landed by (1) that
--    have no zoho_id captured.
INSERT INTO "zoho_push" ("kind", "doc_type", "doc_id", "sub_key", "status", "zoho_id", "pushed_at", "created_at", "created_by")
SELECT 'podraft.create', 'PO_DRAFT', d."id", 'doc', 'SUCCESS', d."zoho_po_id", now(), now(), d."created_by_user_id"
FROM "po_draft_doc" d
WHERE d."zoho_po_id" IS NOT NULL
ON CONFLICT ("kind", "doc_type", "doc_id", "sub_key")
DO UPDATE SET "status" = 'SUCCESS',
              "zoho_id" = COALESCE("zoho_push"."zoho_id", EXCLUDED."zoho_id"),
              "pushed_at" = COALESCE("zoho_push"."pushed_at", EXCLUDED."pushed_at"),
              "updated_at" = now();
--> statement-breakpoint

-- 5) Seed the cron-sync mutex singleton.
INSERT INTO "sync_mutex" ("id", "locked_at", "locked_by") VALUES (1, NULL, NULL)
ON CONFLICT ("id") DO NOTHING;
