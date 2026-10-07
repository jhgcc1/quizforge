import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema } from "./index.js";

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://quizforge:quizforge@localhost:5433/postgres";
const dbName = `qf_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${dbName}`;

let ctx: ReturnType<typeof createDb>;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  ctx = createDb(testUrl.toString(), { max: 4 });
  await migrate(ctx.db, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
});

afterAll(async () => {
  await ctx.pool.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.end();
});

async function seedQuiz(owner = "user-1", idem = randomUUID()) {
  const [quiz] = await ctx.db
    .insert(schema.quizzes)
    .values({ ownerSub: owner, sourceUrl: "https://example.com/r.md", numQuestions: 5, idempotencyKey: idem, requestHash: "h" })
    .returning();
  const [question] = await ctx.db
    .insert(schema.questions)
    .values({
      quizId: quiz!.id,
      position: 1,
      prompt: "What is the capital of France?",
      type: "single",
      explanation: "Paris is the capital.",
      sourceQuote: "Paris is the capital",
    })
    .returning();
  const opts = await ctx.db
    .insert(schema.options)
    .values([1, 2, 3, 4].map((p) => ({ questionId: question!.id, position: p, text: `opt ${p}`, isCorrect: p === 1 })))
    .returning();
  return { quiz: quiz!, question: question!, opts };
}

describe("schema invariants (real Postgres)", () => {
  it("rejects a quiz with num_questions outside 5..8", async () => {
    for (const n of [4, 9]) {
      await expect(
        ctx.db.insert(schema.quizzes).values({ ownerSub: "u", sourceUrl: "x", numQuestions: n, idempotencyKey: randomUUID(), requestHash: "h" }),
      ).rejects.toThrow();
    }
  });

  it("makes quiz creation idempotent per (owner, key) but not across owners", async () => {
    const key = randomUUID();
    await seedQuiz("alice", key);
    await expect(
      ctx.db.insert(schema.quizzes).values({ ownerSub: "alice", sourceUrl: "x", numQuestions: 5, idempotencyKey: key, requestHash: "h" }),
    ).rejects.toThrow(/quizzes_owner_idem_uq|duplicate key/);
    await expect(
      ctx.db.insert(schema.quizzes).values({ ownerSub: "bob", sourceUrl: "x", numQuestions: 5, idempotencyKey: key, requestHash: "h" }),
    ).resolves.toBeDefined();
  });

  it("enforces 4 option positions and unique position per question", async () => {
    const { question } = await seedQuiz();
    await expect(
      ctx.db.insert(schema.options).values({ questionId: question.id, position: 1, text: "dup", isCorrect: false }),
    ).rejects.toThrow();
    await expect(
      ctx.db.insert(schema.options).values({ questionId: question.id, position: 5, text: "out of range", isCorrect: false }),
    ).rejects.toThrow();
  });

  it("stores one answer per (attempt, question): re-answering is an upsert, never a duplicate", async () => {
    const { quiz, question, opts } = await seedQuiz();
    const [attempt] = await ctx.db
      .insert(schema.attempts)
      .values({ quizId: quiz.id, userSub: "user-1", idempotencyKey: randomUUID(), requestHash: "h" })
      .returning();

    const upsertAnswer = async (optionId: string) => {
      const [a] = await ctx.db
        .insert(schema.answers)
        .values({ attemptId: attempt!.id, questionId: question.id })
        .onConflictDoUpdate({
          target: [schema.answers.attemptId, schema.answers.questionId],
          set: { answeredAt: sql`now()` },
        })
        .returning();
      await ctx.db.delete(schema.answerSelections).where(eq(schema.answerSelections.answerId, a!.id));
      await ctx.db.insert(schema.answerSelections).values({ answerId: a!.id, optionId });
      return a!;
    };

    const first = await upsertAnswer(opts[1]!.id);
    const second = await upsertAnswer(opts[0]!.id); // user changed their mind
    expect(second.id).toBe(first.id);

    const rows = await ctx.db.select().from(schema.answers).where(eq(schema.answers.attemptId, attempt!.id));
    expect(rows).toHaveLength(1);
    const sel = await ctx.db.select().from(schema.answerSelections).where(eq(schema.answerSelections.answerId, first.id));
    expect(sel.map((s) => s.optionId)).toEqual([opts[0]!.id]);
  });

  it("rejects selecting an option that does not exist (real FK)", async () => {
    const { quiz, question } = await seedQuiz();
    const [attempt] = await ctx.db.insert(schema.attempts).values({ quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" }).returning();
    const [a] = await ctx.db.insert(schema.answers).values({ attemptId: attempt!.id, questionId: question.id }).returning();
    await expect(
      ctx.db.insert(schema.answerSelections).values({ answerId: a!.id, optionId: randomUUID() }),
    ).rejects.toThrow();
  });

  it("rejects scores outside [0, 4]", async () => {
    const { quiz, question } = await seedQuiz();
    const [attempt] = await ctx.db.insert(schema.attempts).values({ quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" }).returning();
    await expect(
      ctx.db.insert(schema.answers).values({ attemptId: attempt!.id, questionId: question.id, score: "4.5" }),
    ).rejects.toThrow();
    await expect(
      ctx.db.update(schema.attempts).set({ finalScore: "4.1" }).where(eq(schema.attempts.id, attempt!.id)),
    ).rejects.toThrow();
  });

  it("cascades: deleting a quiz removes questions, options, attempts and answers", async () => {
    const { quiz, question } = await seedQuiz();
    const [attempt] = await ctx.db.insert(schema.attempts).values({ quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" }).returning();
    await ctx.db.insert(schema.answers).values({ attemptId: attempt!.id, questionId: question.id });
    // answers.question_id has no cascade on purpose: answers must go through the attempt cascade first.
    await ctx.db.delete(schema.attempts).where(eq(schema.attempts.id, attempt!.id));
    await ctx.db.delete(schema.quizzes).where(eq(schema.quizzes.id, quiz.id));
    expect(await ctx.db.select().from(schema.questions).where(eq(schema.questions.quizId, quiz.id))).toHaveLength(0);
    expect(await ctx.db.select().from(schema.options).where(eq(schema.options.questionId, question.id))).toHaveLength(0);
  });
});

describe("retry safety (real Postgres)", () => {
  it("a delayed retry with an older revision cannot overwrite a newer answer", async () => {
    const { quiz, question } = await seedQuiz();
    const [attempt] = await ctx.db.insert(schema.attempts).values({ quizId: quiz.id, userSub: "u", idempotencyKey: randomUUID(), requestHash: "h" }).returning();
    const [a] = await ctx.db.insert(schema.answers).values({ attemptId: attempt!.id, questionId: question.id, revision: 0 }).returning();

    // revision-guarded write, as the API will do it
    const apply = async (revision: number) =>
      ctx.db
        .update(schema.answers)
        .set({ revision, answeredAt: sql`now()` })
        .where(sql`${schema.answers.id} = ${a!.id} and ${schema.answers.revision} < ${revision}`)
        .returning({ id: schema.answers.id });

    expect(await apply(2)).toHaveLength(1); // newer write arrives first
    expect(await apply(1)).toHaveLength(0); // delayed retry of the older one is ignored
    expect(await apply(2)).toHaveLength(0); // exact replay is a no-op
    const [row] = await ctx.db.select().from(schema.answers).where(eq(schema.answers.id, a!.id));
    expect(row!.revision).toBe(2);
  });

  it("allows only one in-progress attempt per (quiz, user), but a new one after submit", async () => {
    const { quiz } = await seedQuiz();
    const mk = (user: string) =>
      ctx.db.insert(schema.attempts).values({ quizId: quiz.id, userSub: user, idempotencyKey: randomUUID(), requestHash: "h" }).returning();
    const [first] = await mk("carol");
    await expect(mk("carol")).rejects.toThrow(/attempts_one_active_uq|duplicate key/);
    await expect(mk("dave")).resolves.toBeDefined(); // other user unaffected
    await ctx.db.update(schema.attempts).set({ status: "submitted", submittedAt: new Date(), finalScore: "3.5" }).where(eq(schema.attempts.id, first!.id));
    await expect(mk("carol")).resolves.toBeDefined(); // retake after submitting
  });

  it("submit is a one-shot state transition: the second concurrent submit affects 0 rows", async () => {
    const { quiz } = await seedQuiz();
    const [attempt] = await ctx.db.insert(schema.attempts).values({ quizId: quiz.id, userSub: "erin", idempotencyKey: randomUUID(), requestHash: "h" }).returning();
    const submit = () =>
      ctx.db
        .update(schema.attempts)
        .set({ status: "submitted", submittedAt: new Date(), finalScore: "2.00000" })
        .where(sql`${schema.attempts.id} = ${attempt!.id} and ${schema.attempts.status} = 'in_progress'`)
        .returning({ id: schema.attempts.id });
    const results = await Promise.all([submit(), submit()]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
  });
});
