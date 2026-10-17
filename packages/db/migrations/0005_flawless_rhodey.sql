CREATE TABLE "document_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"note" text,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detector_score" numeric(5, 4),
	"excerpt" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "document_requests_status_idx" ON "document_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_requests_pending_url_idx" ON "document_requests" USING btree ("url") WHERE status = 'pending';