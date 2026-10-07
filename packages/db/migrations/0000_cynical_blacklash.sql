CREATE TYPE "public"."attempt_status" AS ENUM('in_progress', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."eval_target" AS ENUM('quiz', 'question', 'attempt');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('single', 'multiple');--> statement-breakpoint
CREATE TYPE "public"."quiz_status" AS ENUM('queued', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "answer_selections" (
	"answer_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	CONSTRAINT "answer_selections_answer_id_option_id_pk" PRIMARY KEY("answer_id","option_id")
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"score" numeric(6, 5),
	"weight" numeric(8, 6),
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "answers_attempt_question_uq" UNIQUE("attempt_id","question_id"),
	CONSTRAINT "answers_score_ck" CHECK ("answers"."score" is null or "answers"."score" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_sub" text NOT NULL,
	"status" "attempt_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"final_score" numeric(7, 5),
	"scoring_version" smallint DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	CONSTRAINT "attempts_user_idem_uq" UNIQUE("user_sub","idempotency_key"),
	CONSTRAINT "attempts_final_score_ck" CHECK ("attempts"."final_score" is null or "attempts"."final_score" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "eval_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "eval_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"evaluator" text NOT NULL,
	"value" numeric(6, 4) NOT NULL,
	"reasoning" text,
	"langfuse_score_id" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"sqs_message_id" text,
	"langfuse_trace_id" text,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer,
	"cost_usd" numeric(10, 6),
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"text" text NOT NULL,
	"is_correct" boolean NOT NULL,
	CONSTRAINT "options_question_position_uq" UNIQUE("question_id","position"),
	CONSTRAINT "options_position_ck" CHECK ("options"."position" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"prompt" text NOT NULL,
	"type" "question_type" NOT NULL,
	"explanation" text NOT NULL,
	"source_quote" text NOT NULL,
	"difficulty" "difficulty" DEFAULT 'medium' NOT NULL,
	CONSTRAINT "questions_quiz_position_uq" UNIQUE("quiz_id","position"),
	CONSTRAINT "questions_position_ck" CHECK ("questions"."position" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_sub" text NOT NULL,
	"source_id" uuid,
	"source_url" text NOT NULL,
	"topic" text,
	"language" text,
	"num_questions" smallint NOT NULL,
	"strategy_requested" text DEFAULT 'auto' NOT NULL,
	"strategy_used" text,
	"critique" boolean DEFAULT true NOT NULL,
	"status" "quiz_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_owner_idem_uq" UNIQUE("owner_sub","idempotency_key"),
	CONSTRAINT "quizzes_num_questions_ck" CHECK ("quizzes"."num_questions" between 5 and 8)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"raw_url" text NOT NULL,
	"content_sha256" text NOT NULL,
	"content_text" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_content_sha256_unique" UNIQUE("content_sha256")
);
--> statement-breakpoint
ALTER TABLE "answer_selections" ADD CONSTRAINT "answer_selections_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_selections" ADD CONSTRAINT "answer_selections_option_id_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "options" ADD CONSTRAINT "options_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_active_uq" ON "attempts" USING btree ("quiz_id","user_sub") WHERE "attempts"."status" = 'in_progress';