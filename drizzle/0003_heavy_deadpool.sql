CREATE TABLE "sync_mutex" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text
);
--> statement-breakpoint
CREATE TABLE "system_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "system_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"level" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"ctx" jsonb,
	"user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zoho_call_counter" (
	"day" date PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zoho_push" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "zoho_push_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" bigint NOT NULL,
	"sub_key" text DEFAULT 'doc' NOT NULL,
	"idem_ref" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"zoho_id" text,
	"zoho_number" text,
	"error" text,
	"request_payload" jsonb,
	"zoho_response" jsonb,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone,
	CONSTRAINT "ck_zoho_push_status" CHECK ("zoho_push"."status" IN ('PENDING','IN_FLIGHT','SUCCESS','FAILED','UNKNOWN','SKIPPED'))
);
--> statement-breakpoint
CREATE INDEX "idx_system_log_level_time" ON "system_log" USING btree ("level","created_at");--> statement-breakpoint
CREATE INDEX "idx_system_log_source_time" ON "system_log" USING btree ("source","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_zoho_push_key" ON "zoho_push" USING btree ("kind","doc_type","doc_id","sub_key");--> statement-breakpoint
CREATE INDEX "idx_zoho_push_status" ON "zoho_push" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_zoho_push_doc" ON "zoho_push" USING btree ("doc_type","doc_id");