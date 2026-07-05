ALTER TABLE "users" ADD COLUMN "pin_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "allowed_pages" jsonb;