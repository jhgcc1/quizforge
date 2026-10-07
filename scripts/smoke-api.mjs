#!/usr/bin/env node
// End-to-end smoke test of the public REST API. Works against local containers and AWS alike.
//   BASE_URL=http://localhost:18080 TOKEN=<bearer> node scripts/smoke-api.mjs [sourceUrl]
import { randomUUID } from "node:crypto";

const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.TOKEN;
if (!base || !token) throw new Error("set BASE_URL and TOKEN");
const source = process.argv[2];

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

const health = await fetch(base + "/readyz");
check(health.status === 200, "GET /readyz");
check((await fetch(base + "/v1/quizzes")).status === 401, "no token -> 401");

const key = randomUUID();
const payload = { numQuestions: 5, critique: false, ...(source ? { sourceUrl: source } : {}) };
const created = await call("POST", "/v1/quizzes", payload, { "idempotency-key": key });
check(created.status === 202, "POST /v1/quizzes -> 202", created.body?.error?.message ?? "");
const quizId = created.body?.quiz?.id;
const replay = await call("POST", "/v1/quizzes", payload, { "idempotency-key": key });
check(replay.status === 200 && replay.body?.quiz?.id === quizId, "same Idempotency-Key -> same quiz (200)");

let quiz;
const t0 = Date.now();
for (let i = 0; i < 120; i++) {
  quiz = (await call("GET", `/v1/quizzes/${quizId}`)).body;
  if (["ready", "failed"].includes(quiz.quiz.status)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
check(quiz?.quiz?.status === "ready", `quiz generated (${((Date.now() - t0) / 1000).toFixed(0)}s, strategy=${quiz?.quiz?.strategyUsed})`, quiz?.quiz?.error ?? "");
if (quiz?.quiz?.status !== "ready") process.exit(1);
check(quiz.questions.length === 5 && quiz.questions.every((q) => q.options.length === 4), "5 questions with 4 options each");
check(!JSON.stringify(quiz).match(/isCorrect|explanation/), "answer key is not exposed before submit");

const att = await call("POST", `/v1/quizzes/${quizId}/attempts`, {}, { "idempotency-key": randomUUID() });
check(att.status === 201, "start attempt -> 201");
const attemptId = att.body.attempt.id;
for (const q of quiz.questions) {
  const r = await call("PUT", `/v1/attempts/${attemptId}/answers/${q.id}`, { optionIds: [q.options[0].id], revision: 1 });
  if (r.body?.status !== "saved") check(false, `save answer ${q.position}`, JSON.stringify(r.body));
}
const stale = await call("PUT", `/v1/attempts/${attemptId}/answers/${quiz.questions[0].id}`, { optionIds: [quiz.questions[0].options[1].id], revision: 1 });
check(stale.body?.status === "ignored", "stale revision is ignored");

const sub = await call("POST", `/v1/attempts/${attemptId}/submit`);
const score = sub.body?.result?.finalScore;
check(sub.status === 200 && typeof score === "number" && score >= 0 && score <= 4, `submit -> weighted score ${score?.toFixed?.(3)} / 4 (${sub.body?.result?.percent?.toFixed?.(1)}%)`);
const sub2 = await call("POST", `/v1/attempts/${attemptId}/submit`);
check(sub2.body?.replayed === true && sub2.body.result.finalScore === score, "submit replay returns the same result");
check((await call("PUT", `/v1/attempts/${attemptId}/answers/${quiz.questions[0].id}`, { optionIds: [quiz.questions[0].options[0].id], revision: 9 })).status === 409, "answers are locked after submit");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
