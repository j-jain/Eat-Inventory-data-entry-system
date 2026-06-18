CREATE TYPE "public"."adj_kind" AS ENUM('TIE_OUT', 'OVERRIDE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('MOTHER', 'BULK_FRUIT', 'BLINKIT', 'SPENCERS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."doc_status" AS ENUM('DRAFT', 'POSTED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('RECEIVING', 'SORTING', 'ASSEMBLY', 'WASTAGE', 'RETURN', 'INV_ADJUSTMENT', 'DISPATCH', 'PURCHASE_ORDER', 'OPENING');--> statement-breakpoint
CREATE TYPE "public"."location_kind" AS ENUM('COLD_ROOM', 'DC_FLOOR_FG', 'VIRTUAL');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('OPENING_BALANCE', 'RECEIPT', 'SORT_WASTE', 'REGRADE_WASTE', 'ASSEMBLY_CONSUME', 'PACK_PRODUCE', 'DISPATCH', 'RETURN_TO_MOTHER', 'RETURN_WASTE', 'WASTAGE', 'ADJUSTMENT_PLUS', 'ADJUSTMENT_MINUS', 'VOID_REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."return_disposition" AS ENUM('RESALABLE', 'WASTE');--> statement-breakpoint
CREATE TYPE "public"."return_match" AS ENUM('MATCHED', 'PENDING_MATCH');--> statement-breakpoint
CREATE TYPE "public"."sku_kind" AS ENUM('MOTHER', 'DERIVATIVE');--> statement-breakpoint
CREATE TYPE "public"."uom" AS ENUM('kg', 'g', 'pc', 'box', 'bunch', 'unit');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('FLOOR', 'SUPERVISOR', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."wastage_source" AS ENUM('SORTING', 'REGRADE', 'ASSEMBLY', 'RETURN', 'EXPIRY', 'GENERAL');--> statement-breakpoint
CREATE TABLE "app_audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"action" text NOT NULL,
	"doc_type" text,
	"doc_id" bigint,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assembly_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "assembly_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel" "channel" NOT NULL,
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
CREATE TABLE "assembly_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "assembly_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"mother_sku_id" bigint NOT NULL,
	"pack_sku_id" bigint NOT NULL,
	"qty_out" numeric(14, 3) NOT NULL,
	"qty_in" numeric(14, 3) DEFAULT '0' NOT NULL,
	"total_used" numeric(14, 3) NOT NULL,
	"packs_made" numeric(12, 2) NOT NULL,
	"pack_size_text" text,
	CONSTRAINT "ck_assembly_used" CHECK ("assembly_line"."total_used" = "assembly_line"."qty_out" - "assembly_line"."qty_in"),
	CONSTRAINT "ck_assembly_in_le_out" CHECK ("assembly_line"."qty_in" <= "assembly_line"."qty_out")
);
--> statement-breakpoint
CREATE TABLE "dispatch_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dispatch_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint,
	"channel" "channel",
	"dispatch_ref" text,
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
CREATE TABLE "dispatch_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dispatch_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"pack_sku_id" bigint NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"uom" "uom" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_adjustment_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inv_adjustment_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vendor_id" bigint,
	"against" text,
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
CREATE TABLE "inv_adjustment_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inv_adjustment_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"qty_as_per_po" numeric(14, 3),
	"actual_received" numeric(14, 3),
	"qty_as_per_bill" numeric(14, 3),
	"qty_to_adjust" numeric(14, 3) NOT NULL,
	"adj_kind" "adj_kind" DEFAULT 'MANUAL' NOT NULL,
	"unit_cost" numeric(14, 2) DEFAULT '0',
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "locations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "location_kind" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "locations_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "opening_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "opening_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
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
CREATE TABLE "receiving_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "receiving_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vendor_id" bigint,
	"po_no" text,
	"pr_no" text,
	"zoho_po_id" text,
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
CREATE TABLE "receiving_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "receiving_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"accepted_qty" numeric(14, 3) NOT NULL,
	"po_expected_qty" numeric(14, 3),
	"uom" "uom" DEFAULT 'kg' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "return_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint,
	"zoho_invoice_id" text,
	"inv_no" text,
	"match_status" "return_match" DEFAULT 'PENDING_MATCH' NOT NULL,
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
CREATE TABLE "return_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"qty_return" numeric(14, 3) NOT NULL,
	"qty_weight" numeric(14, 3) DEFAULT '0' NOT NULL,
	"back_to_mother_sku_id" bigint,
	"disposition" "return_disposition" NOT NULL,
	"uom" "uom" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "skus_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"normalized_code" text NOT NULL,
	"name" text NOT NULL,
	"family" text DEFAULT 'EAT' NOT NULL,
	"sku_kind" "sku_kind" NOT NULL,
	"channel" "channel" NOT NULL,
	"mother_sku_id" bigint,
	"mother_core" text NOT NULL,
	"pack_size_text" text,
	"pack_g_min" numeric(14, 3),
	"pack_g_max" numeric(14, 3),
	"pack_pieces" numeric(10, 2),
	"uom" "uom" NOT NULL,
	"category" text DEFAULT '',
	"shelf_life_days" integer,
	"zoho_item_id" text,
	"source" text DEFAULT 'LOCAL' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sorting_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sorting_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"is_recheck" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "sorting_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sorting_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"sorted_qty" numeric(14, 3) NOT NULL,
	"qty_a" numeric(14, 3) DEFAULT '0' NOT NULL,
	"qty_b" numeric(14, 3) DEFAULT '0' NOT NULL,
	"qty_c" numeric(14, 3) DEFAULT '0' NOT NULL,
	"qty_waste" numeric(14, 3) GENERATED ALWAYS AS (sorted_qty - (qty_a + qty_b + qty_c)) STORED,
	CONSTRAINT "ck_sorting_split" CHECK ("sorting_line"."qty_a" + "sorting_line"."qty_b" + "sorting_line"."qty_c" <= "sorting_line"."sorted_qty")
);
--> statement-breakpoint
CREATE TABLE "stock_balance" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_balance_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sku_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"qty" numeric(14, 3) DEFAULT '0' NOT NULL,
	"uom" "uom" NOT NULL,
	"last_movement_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_balance_key" UNIQUE("sku_id","location_id"),
	CONSTRAINT "ck_balance_nonneg" CHECK ("stock_balance"."qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"movement_type" "movement_type" NOT NULL,
	"sku_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"qty_signed" numeric(14, 3) NOT NULL,
	"uom" "uom" NOT NULL,
	"balance_after" numeric(14, 3) NOT NULL,
	"doc_type" "doc_type" NOT NULL,
	"doc_id" bigint NOT NULL,
	"doc_line_id" bigint,
	"reverses_ledger_id" bigint,
	"business_date" date NOT NULL,
	"user_id" bigint NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_ledger_qty_nonzero" CHECK ("stock_ledger"."qty_signed" <> 0)
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_pulled" integer DEFAULT 0,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"full_name" text NOT NULL,
	"pin_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'FLOOR' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wastage_doc" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wastage_doc_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
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
CREATE TABLE "wastage_line" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wastage_line_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doc_id" bigint NOT NULL,
	"sku_id" bigint NOT NULL,
	"location_id" bigint NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"uom" "uom" NOT NULL,
	"reason" text NOT NULL,
	"source" "wastage_source" DEFAULT 'GENERAL' NOT NULL,
	"source_doc_type" "doc_type",
	"source_doc_id" bigint
);
--> statement-breakpoint
CREATE TABLE "zoho_customer_cache" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "zoho_customer_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"zoho_contact_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zoho_customer_cache_zoho_contact_id_unique" UNIQUE("zoho_contact_id")
);
--> statement-breakpoint
CREATE TABLE "zoho_invoice_cache" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "zoho_invoice_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"zoho_invoice_id" text NOT NULL,
	"invoice_number" text,
	"customer_zoho_id" text,
	"customer_name" text,
	"invoice_date" date,
	"line_items" jsonb,
	"last_modified_time" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zoho_invoice_cache_zoho_invoice_id_unique" UNIQUE("zoho_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "zoho_item_cache" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "zoho_item_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"zoho_item_id" text NOT NULL,
	"item_name" text,
	"sku_text" text,
	"stock_on_hand" numeric(14, 3),
	"rate" numeric(14, 2),
	"last_modified_time" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zoho_item_cache_zoho_item_id_unique" UNIQUE("zoho_item_id")
);
--> statement-breakpoint
CREATE TABLE "zoho_po_cache" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "zoho_po_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"zoho_po_id" text NOT NULL,
	"po_number" text,
	"vendor_zoho_id" text,
	"vendor_name" text,
	"po_date" date,
	"status" text,
	"line_items" jsonb,
	"last_modified_time" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zoho_po_cache_zoho_po_id_unique" UNIQUE("zoho_po_id")
);
--> statement-breakpoint
CREATE TABLE "zoho_token" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"access_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zoho_vendor_cache" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "zoho_vendor_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"zoho_contact_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zoho_vendor_cache_zoho_contact_id_unique" UNIQUE("zoho_contact_id")
);
--> statement-breakpoint
ALTER TABLE "assembly_doc" ADD CONSTRAINT "assembly_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_line" ADD CONSTRAINT "assembly_line_doc_id_assembly_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."assembly_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_line" ADD CONSTRAINT "assembly_line_mother_sku_id_skus_id_fk" FOREIGN KEY ("mother_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assembly_line" ADD CONSTRAINT "assembly_line_pack_sku_id_skus_id_fk" FOREIGN KEY ("pack_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_doc" ADD CONSTRAINT "dispatch_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_line" ADD CONSTRAINT "dispatch_line_doc_id_dispatch_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."dispatch_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_line" ADD CONSTRAINT "dispatch_line_pack_sku_id_skus_id_fk" FOREIGN KEY ("pack_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_adjustment_doc" ADD CONSTRAINT "inv_adjustment_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_adjustment_line" ADD CONSTRAINT "inv_adjustment_line_doc_id_inv_adjustment_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."inv_adjustment_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_adjustment_line" ADD CONSTRAINT "inv_adjustment_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_adjustment_line" ADD CONSTRAINT "inv_adjustment_line_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_doc" ADD CONSTRAINT "opening_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_doc" ADD CONSTRAINT "receiving_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_line" ADD CONSTRAINT "receiving_line_doc_id_receiving_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."receiving_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_line" ADD CONSTRAINT "receiving_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_doc" ADD CONSTRAINT "return_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_line" ADD CONSTRAINT "return_line_doc_id_return_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."return_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_line" ADD CONSTRAINT "return_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_line" ADD CONSTRAINT "return_line_back_to_mother_sku_id_skus_id_fk" FOREIGN KEY ("back_to_mother_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_mother_sku_id_skus_id_fk" FOREIGN KEY ("mother_sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sorting_doc" ADD CONSTRAINT "sorting_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sorting_line" ADD CONSTRAINT "sorting_line_doc_id_sorting_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."sorting_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sorting_line" ADD CONSTRAINT "sorting_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_reverses_ledger_id_stock_ledger_id_fk" FOREIGN KEY ("reverses_ledger_id") REFERENCES "public"."stock_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_doc" ADD CONSTRAINT "wastage_doc_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_line" ADD CONSTRAINT "wastage_line_doc_id_wastage_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."wastage_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_line" ADD CONSTRAINT "wastage_line_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wastage_line" ADD CONSTRAINT "wastage_line_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_assembly_token" ON "assembly_doc" USING btree ("client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dispatch_token" ON "dispatch_doc" USING btree ("client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invadj_token" ON "inv_adjustment_doc" USING btree ("client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_receiving_token" ON "receiving_doc" USING btree ("client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_return_token" ON "return_doc" USING btree ("client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skus_code" ON "skus" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skus_normalized" ON "skus" USING btree ("normalized_code");--> statement-breakpoint
CREATE INDEX "idx_skus_mother" ON "skus" USING btree ("mother_sku_id");--> statement-breakpoint
CREATE INDEX "idx_skus_mother_core" ON "skus" USING btree ("mother_core");--> statement-breakpoint
CREATE INDEX "idx_skus_zoho" ON "skus" USING btree ("zoho_item_id");--> statement-breakpoint
CREATE INDEX "idx_skus_channel" ON "skus" USING btree ("channel");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sorting_token" ON "sorting_doc" USING btree ("client_token");--> statement-breakpoint
CREATE INDEX "idx_ledger_balkey" ON "stock_ledger" USING btree ("sku_id","location_id","id");--> statement-breakpoint
CREATE INDEX "idx_ledger_doc" ON "stock_ledger" USING btree ("doc_type","doc_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_bizdate" ON "stock_ledger" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "idx_ledger_type" ON "stock_ledger" USING btree ("movement_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_name" ON "users" USING btree (lower("full_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wastage_token" ON "wastage_doc" USING btree ("client_token");--> statement-breakpoint
CREATE INDEX "idx_inv_number" ON "zoho_invoice_cache" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "idx_inv_customer" ON "zoho_invoice_cache" USING btree ("customer_zoho_id");