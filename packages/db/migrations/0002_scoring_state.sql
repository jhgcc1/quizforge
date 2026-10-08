ALTER TABLE "generation_jobs" ADD COLUMN "scored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "scoring_attempts" integer DEFAULT 0 NOT NULL;