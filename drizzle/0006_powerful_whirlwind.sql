CREATE TABLE "pick_list_line_source" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pick_list_line_source_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"pick_list_line_id" bigint NOT NULL,
	"source_type" "pick_source_type" NOT NULL,
	"zoho_so_id" text,
	"manual_order_doc_id" bigint,
	"order_no" text,
	"qty" numeric(14, 3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pick_list_source" ADD COLUMN "order_no" text;--> statement-breakpoint
ALTER TABLE "pick_list_source" ADD COLUMN "matched" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pick_list_line_source" ADD CONSTRAINT "pick_list_line_source_pick_list_line_id_pick_list_line_id_fk" FOREIGN KEY ("pick_list_line_id") REFERENCES "public"."pick_list_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line_source" ADD CONSTRAINT "pick_list_line_source_manual_order_doc_id_manual_order_doc_id_fk" FOREIGN KEY ("manual_order_doc_id") REFERENCES "public"."manual_order_doc"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plls_line" ON "pick_list_line_source" USING btree ("pick_list_line_id");