/**
 * Database rows turned into the JSON the API promises. Nothing here touches the database or the request:
 * given a row, each function returns the object the contract describes, which is what makes them easy to
 * test and impossible to get subtly different between two routes that return the same thing.
 *
 * The quiz summary is returned by four routes (create, replay, list, read). It used to be a closure inside
 * the route file, and that is how a field ends up present on one route and missing on another.
 */
import type { AttemptSummary, QuizRow } from "@quizforge/db";
import { classifierFinding, userFacingError } from "../user-errors.js";

/** A score is 0-4 per question; the UI shows a percentage. */
export const percent = (score: number): number => (score / 4) * 100;

/** What the user did with a quiz, from its attempts (newest first): count, the open one, the last submitted score, the best score. */
export function progress(attempts: AttemptSummary[]) {
  const submitted = attempts.filter((a) => a.status === "submitted" && a.finalScore !== null);
  const last = submitted.sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0))[0];
  return {
    attempts: attempts.length,
    inProgressAttemptId: attempts.find((a) => a.status === "in_progress")?.id ?? null,
    last: last ? { attemptId: last.id, finalScore: last.finalScore!, percent: percent(last.finalScore!), submittedAt: last.submittedAt!.toISOString() } : null,
    best: submitted.length ? Math.max(...submitted.map((a) => a.finalScore!)) : null,
  };
}

/** The public view of a quiz row: no raw error text, no internal columns. */
export function summary(q: QuizRow) {
  return {
    id: q.id,
    status: q.status,
    sourceUrl: q.sourceUrl,
    topic: q.topic,
    numQuestions: q.numQuestions,
    strategyRequested: q.strategyRequested,
    strategyUsed: q.strategyUsed,
    critique: q.critique,
    error: q.status === "failed" ? userFacingError(q.error) : null, // raw detail stays in the database and logs
    reviewable: q.status === "failed" && classifierFinding(q.error) !== undefined, // the client offers the review path on this, not on the wording
    createdAt: q.createdAt,
    generationProgress: generationProgress(q),
  };
}

/** Only while the worker is generating and has reported a phase; null for queued, ready and failed quizzes. */
export function generationProgress(q: QuizRow) {
  if (q.status !== "generating" || q.phase === null || q.phaseStep === null || q.phaseTotal === null) return null;
  return { phase: q.phase, step: q.phaseStep, totalSteps: q.phaseTotal, ...(q.phaseDetail ? { detail: q.phaseDetail } : {}) };
}

/** One row of `GET /v1/quizzes/:id/attempts`. */
export function attemptRow(a: AttemptSummary) {
  return {
    id: a.id,
    status: a.status,
    startedAt: a.startedAt.toISOString(),
    submittedAt: a.submittedAt?.toISOString() ?? null,
    finalScore: a.finalScore,
    percent: a.finalScore === null ? null : percent(a.finalScore),
  };
}
