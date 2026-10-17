ALTER TABLE "sources" ADD COLUMN "listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "list_title" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "list_language" text;--> statement-breakpoint
CREATE INDEX "sources_listed_idx" ON "sources" USING btree ("listed_at");