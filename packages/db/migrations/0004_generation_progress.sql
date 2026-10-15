ALTER TABLE "quizzes" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "phase_step" smallint;--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "phase_total" smallint;--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "phase_detail" text;--> statement-breakpoint
ALTER TABLE "quizzes" ADD COLUMN "phase_updated_at" timestamp with time zone;