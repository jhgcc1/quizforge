import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Data flow:
 *   sources --< quizzes --< questions --< options
 *                  |  \--< generation_jobs
 *                  \--< attempts --< answers --< answer_selections >-- options
 *   eval_scores: polymorphic quality scores for quizzes / questions / attempts.
 * Ownership is the Cognito `sub` (text) - there is no users table on purpose.
 */

export const quizStatus = pgEnum("quiz_status", ["queued", "generating", "ready", "failed"]);
export const questionType = pgEnum("question_type", ["single", "multiple"]);
export const difficulty = pgEnum("difficulty", ["easy", "medium", "hard"]);
export const attemptStatus = pgEnum("attempt_status", ["in_progress", "submitted"]);
export const jobStatus = pgEnum("job_status", ["running", "succeeded", "failed"]);
export const evalTarget = pgEnum("eval_target", ["quiz", "question", "attempt"]);

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Fetched markdown documents; deduplicated by content hash so identical READMEs are stored once. */
export const sources = pgTable("sources", {
  id: id(),
  url: text("url").notNull(),
  rawUrl: text("raw_url").notNull(),
  contentSha256: text("content_sha256").notNull().unique(),
  contentText: text("content_text").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const quizzes = pgTable(
  "quizzes",
  {
    id: id(),
    ownerSub: text("owner_sub").notNull(),
    sourceId: uuid("source_id").references(() => sources.id),
    sourceUrl: text("source_url").notNull(),
    topic: text("topic"),
    language: text("language"),
    numQuestions: smallint("num_questions").notNull(),
    strategyRequested: text("strategy_requested").notNull().default("auto"),
    strategyUsed: text("strategy_used"),
    critique: boolean("critique").notNull().default(true),
    status: quizStatus("status").notNull().default("queued"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** sha256 of the normalized request body; same key + different hash => 422. */
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("quizzes_owner_idem_uq").on(t.ownerSub, t.idempotencyKey),
    check("quizzes_num_questions_ck", sql`${t.numQuestions} between 5 and 8`),
  ],
);

/** One row per generation run (a quiz can be retried); holds cost/token accounting. */
export const generationJobs = pgTable("generation_jobs", {
  id: id(),
  quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
  attemptNo: integer("attempt_no").notNull().default(1),
  status: jobStatus("status").notNull().default("running"),
  sqsMessageId: text("sqs_message_id"),
  langfuseTraceId: text("langfuse_trace_id"),
  model: text("model"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  cachedTokens: integer("cached_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const questions = pgTable(
  "questions",
  {
    id: id(),
    quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    prompt: text("prompt").notNull(),
    type: questionType("type").notNull(),
    explanation: text("explanation").notNull(),
    sourceQuote: text("source_quote").notNull(),
    difficulty: difficulty("difficulty").notNull().default("medium"),
  },
  (t) => [
    unique("questions_quiz_position_uq").on(t.quizId, t.position),
    check("questions_position_ck", sql`${t.position} between 1 and 8`),
  ],
);

export const options = pgTable(
  "options",
  {
    id: id(),
    questionId: uuid("question_id").notNull().references(() => questions.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    text: text("text").notNull(),
    /** Never serialized to the client before the attempt is submitted. */
    isCorrect: boolean("is_correct").notNull(),
  },
  (t) => [
    unique("options_question_position_uq").on(t.questionId, t.position),
    check("options_position_ck", sql`${t.position} between 1 and 4`),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    id: id(),
    quizId: uuid("quiz_id").notNull().references(() => quizzes.id, { onDelete: "cascade" }),
    userSub: text("user_sub").notNull(),
    status: attemptStatus("status").notNull().default("in_progress"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** Weighted average in [0, 4]; null until submitted. */
    finalScore: numeric("final_score", { precision: 7, scale: 5 }),
    scoringVersion: smallint("scoring_version").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
  },
  (t) => [
    unique("attempts_user_idem_uq").on(t.userSub, t.idempotencyKey),
    /** Natural idempotency: at most one in-progress attempt per user and quiz. */
    uniqueIndex("attempts_one_active_uq").on(t.quizId, t.userSub).where(sql`${t.status} = 'in_progress'`),
    check("attempts_final_score_ck", sql`${t.finalScore} is null or ${t.finalScore} between 0 and 4`),
  ],
);

/** One row per (attempt, question): persisted the moment the user answers. */
export const answers = pgTable(
  "answers",
  {
    id: id(),
    attemptId: uuid("attempt_id").notNull().references(() => attempts.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull().references(() => questions.id),
    /** Per-question score in [0, 4] and its weight; filled at submit. */
    score: numeric("score", { precision: 6, scale: 5 }),
    weight: numeric("weight", { precision: 8, scale: 6 }),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
    /** Client-sent monotonic counter: a delayed retry with an older revision must not overwrite a newer answer. */
    revision: integer("revision").notNull().default(0),
  },
  (t) => [
    unique("answers_attempt_question_uq").on(t.attemptId, t.questionId),
    check("answers_score_ck", sql`${t.score} is null or ${t.score} between 0 and 4`),
  ],
);

export const answerSelections = pgTable(
  "answer_selections",
  {
    answerId: uuid("answer_id").notNull().references(() => answers.id, { onDelete: "cascade" }),
    optionId: uuid("option_id").notNull().references(() => options.id),
  },
  (t) => [primaryKey({ columns: [t.answerId, t.optionId] })],
);

export const evalScores = pgTable("eval_scores", {
  id: id(),
  targetType: evalTarget("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  evaluator: text("evaluator").notNull(),
  value: numeric("value", { precision: 6, scale: 4 }).notNull(),
  reasoning: text("reasoning"),
  langfuseScoreId: text("langfuse_score_id"),
  meta: jsonb("meta"),
  createdAt: createdAt(),
});
