CREATE TYPE "public"."delivery_status" AS ENUM('PENDING', 'PARTIAL', 'DELIVERED');--> statement-breakpoint
CREATE TYPE "public"."pick_list_status" AS ENUM('OPEN', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."pick_source_type" AS ENUM('ZOHO_SO', 'MANUAL_ORDER');--> statement-breakpoint
CREATE TYPE "public"."receiving_variance" AS ENUM('NONE', 'S1_FREE_LEFTOVER', 'S2_OVER_RECEIPT', 'S4_SHORT_BILLED_FULL');--> statement-breakpoint
ALTER TYPE "public"."doc_type" ADD VALUE 'MANUAL_ORDER';--> statement-breakpoint
ALTER TYPE "public"."doc_type" ADD VALUE 'PO_DRAFT';--> statement-breakpoint
ALTER TYPE "public"."doc_type" ADD VALUE 'PICK_LIST';--> statement-breakpoint
ALTER TYPE "public"."location_kind" ADD VALUE 'RECEIVING_BAY';--> statement-breakpoint
ALTER TYPE "public"."movement_type" ADD VALUE 'SORT_OUT';--> statement-breakpoint
ALTER TYPE "public"."movement_type" ADD VALUE 'SORT_IN';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'MANAGER';--> statement-breakpoint
ALTER TYPE "public"."wastage_source" ADD VALUE 'RECEIVING';--> statement-breakpoint
CREATE TABLE "manual_order_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "manual_order_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint,
	"channel" "channel",
	"order_ref" text,
	"doc_status" "doc_status" DEFAULT 'DRAFT' NOT NULL,
	"business_date" date NOT NULL,
	"note" text,
	"created_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_token" text,
	"voided_by_user_id" bigint,
	"voided_at" timestamp with time zone,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "manual_order_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "manual_order_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"uom" "uom" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pick_list" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pick_list_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_date" date NOT NULL,
	"status" "pick_list_status" DEFAULT 'OPEN' NOT NULL,
	"note" text,
	"created_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_token" text,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" bigint,
	"short_complete_reason" text
);
--> statement-breakpoint
CREATE TABLE "pick_list_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pick_list_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"pick_list_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"qty_to_pick" numeric(14, 3) NOT NULL,
	"qty_picked" numeric(14, 3) DEFAULT '0' NOT NULL,
	"uom" "uom" NOT NULL,
	CONSTRAINT "uq_pick_list_line" UNIQUE("pick_list_id","sku_id"),
	CONSTRAINT "ck_pick_picked_nonneg" CHECK ("pick_list_line"."qty_picked" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pick_list_source" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pick_list_source_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"pick_list_id" bigint NOT NULL,
	"source_type" "pick_source_type" NOT NULL,
	"zoho_so_id" text,
	"manual_order_doc_id" bigint,
	CONSTRAINT "ck_pick_source_one_ref" CHECK (("pick_list_source"."source_type" = 'ZOHO_SO' AND "pick_list_source"."zoho_so_id" IS NOT NULL AND "pick_list_source"."manual_order_doc_id" IS NULL)
       OR ("pick_list_source"."source_type" = 'MANUAL_ORDER' AND "pick_list_source"."manual_order_doc_id" IS NOT NULL AND "pick_list_source"."zoho_so_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "po_draft_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_draft_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vendor_zoho_id" text,
	"vendor_name" text,
	"delivery_date" date,
	"zoho_po_id" text,
	"push_status" text DEFAULT 'LOCAL' NOT NULL,
	"doc_status" "doc_status" DEFAULT 'DRAFT' NOT NULL,
	"business_date" date NOT NULL,
	"note" text,
	"created_by_user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_token" text,
	"voided_by_user_id" bigint,
	"voided_at" timestamp with time zone,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "po_draft_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_draft_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"rate" numeric(14, 2),
	"uom" "uom" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zoho_so_cache" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "zoho_so_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"zoho_so_id" text NOT NULL,
	"so_number" text,
	"customer_zoho_id" text,
	"customer_name" text,
	"so_date" date,
	"status" text,
	"line_items" jsonb,
	"last_modified_time" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zoho_so_cache_zoho_so_id_unique" UNIQUE("zoho_so_id")
);
--> statement-breakpoint
ALTER TABLE "assembly_line" ADD COLUMN "qty_waste" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_doc" ADD COLUMN "pick_list_id" bigint;--> statement-breakpoint
ALTER TABLE "dispatch_doc" ADD COLUMN "delivery_status" "delivery_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_doc" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_doc" ADD COLUMN "delivered_by_user_id" bigint;--> statement-breakpoint
ALTER TABLE "dispatch_doc" ADD COLUMN "delivery_note" text;--> statement-breakpoint
ALTER TABLE "dispatch_line" ADD COLUMN "delivered_qty" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_doc" ADD COLUMN "variance" "receiving_variance" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "receiving_doc" ADD COLUMN "variance_note" text;--> statement-breakpoint
ALTER TABLE "skus" ADD COLUMN "requires_sorting" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "manual_order_doc" ADD CONSTRAINT "manual_order_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_order_line" ADD CONSTRAINT "manual_order_line_doc_id_manual_order_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."manual_order_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_order_line" ADD CONSTRAINT "manual_order_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line" ADD CONSTRAINT "pick_list_line_pick_list_id_pick_list_id_fk" FOREIGN KEY ("pick_list_id") REFERENCES "public"."pick_list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line" ADD CONSTRAINT "pick_list_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_source" ADD CONSTRAINT "pick_list_source_pick_list_id_pick_list_id_fk" FOREIGN KEY ("pick_list_id") REFERENCES "public"."pick_list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_source" ADD CONSTRAINT "pick_list_source_manual_order_doc_id_manual_order_doc_id_fk" FOREIGN KEY ("manual_order_doc_id") REFERENCES "public"."manual_order_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_draft_doc" ADD CONSTRAINT "po_draft_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_draft_line" ADD CONSTRAINT "po_draft_line_doc_id_po_draft_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."po_draft_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_draft_line" ADD CONSTRAINT "po_draft_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_manual_order_token" ON "manual_order_doc" USING btree ("client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pick_list_token" ON "pick_list" USING btree ("client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pick_list_single_open" ON "pick_list" USING btree ("status") WHERE "pick_list"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "idx_pick_list_date" ON "pick_list" USING btree ("business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pick_source_so" ON "pick_list_source" USING btree ("zoho_so_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pick_source_manual" ON "pick_list_source" USING btree ("manual_order_doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_po_draft_token" ON "po_draft_doc" USING btree ("client_token");--> statement-breakpoint
ALTER TABLE "dispatch_doc" ADD CONSTRAINT "dispatch_doc_pick_list_id_pick_list_id_fk" FOREIGN KEY ("pick_list_id") REFERENCES "public"."pick_list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_action_doc" ON "app_audit_log" USING btree ("action","doc_type","doc_id");--> statement-breakpoint
CREATE INDEX "idx_receiving_line_doc_sku" ON "receiving_line" USING btree ("doc_id","sku_id");--> statement-breakpoint
ALTER TABLE "assembly_line" ADD CONSTRAINT "ck_assembly_waste" CHECK ("assembly_line"."qty_waste" >= 0 AND "assembly_line"."qty_waste" <= "assembly_line"."total_used");--> statement-breakpoint
ALTER TABLE "dispatch_line" ADD CONSTRAINT "ck_dispatch_delivered" CHECK ("dispatch_line"."delivered_qty" >= 0 AND "dispatch_line"."delivered_qty" <= "dispatch_line"."qty");