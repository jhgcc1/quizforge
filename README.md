# QuizForge

An AI agent that turns any Markdown document (e.g. a GitHub README) into a 5–8 question multiple-choice quiz, runs the quiz in a web UI, and scores it.

* **Agent**: LangGraph pipeline on MiniMax — route → generate → deterministic gate → critique → revise → judge, traced in Langfuse.
* **Scoring**: 4 points per fully-correct answer; multi-answer questions earn `4 × max(0, (hits − misses) / K)`; the final score is the weighted average with weights `1.1^(i−1)` (each question counts 10 % more than the previous one).
* **Stack**: TypeScript everywhere — Next.js (BFF) · Fastify API · SQS worker · Postgres · AWS Fargate behind CloudFront/WAF · Cognito · Terraform · GitHub Actions.

```
Browser ─HTTPS─> CloudFront + WAF ─> ALB ─┬─ /v1/* /docs ─> api   (Fastify, JWT)  ──┐
                                           └─ /*          ─> web   (Next.js BFF)    │
                       Cognito (Hosted UI + PKCE) <───────────┘ cookie → Bearer      ├─> RDS Postgres
                                                                api ─ SQS ─> worker (LangGraph) ─> MiniMax
                                                                              │  └─ SQS (scoring) ─> scorer (judge) ─> MiniMax
                                                                              └──────> Langfuse Cloud + CloudWatch (EMF)
```

## Run it locally (no AWS, no API keys)

```bash
pnpm install
docker compose --profile app up --build      # Postgres, SQS emulator, migrate, api, worker (fake LLM), web
open http://localhost:13000                  # dev login → create quiz → answer → score
```

Real model: `LLM_MODE=minimax MINIMAX_API_KEY=… docker compose --profile app up --build worker scorer` (the scorer is what scores the quizzes; set `MINIMAX_JUDGE_MODEL` in the compose environment to judge with another model, otherwise the generator judges itself locally).

| | |
|---|---|
| `pnpm test` | unit + property tests (scoring, schemas, SSRF guard, JSON extraction, graph, migration policy) |
| `pnpm test:integration` | real Postgres: idempotency, concurrency, API, worker, sweeper, migrate entrypoint |
| `pnpm test:e2e` | Playwright against the whole stack: login → generate → answer → **reload** → submit → score |
| `pnpm --filter @quizforge/llm smoke <url>` | live run against MiniMax, traced in Langfuse |
| `pnpm --filter @quizforge/evals eval` | **LLM regression suite** over a golden set (grounding, lint, LLM-judge, prompt-injection, language) with thresholds; also runs nightly in CI |
| `scripts/audit-aws.sh` | read-only audit of the *deployed* infrastructure against the security claims below (39 checks, 40 once the scorer service exists) |
| `scripts/smoke-api.mjs` | black-box API test usable against local containers and AWS |

## REST API

OpenAPI at `/docs` (`/openapi.json`). Every state-changing call is **idempotent**:

```bash
KEY=$(uuidgen)
curl -X POST $URL/v1/quizzes -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY" \
     -H 'content-type: application/json' \
     -d '{"sourceUrl":"https://github.com/pipecat-ai/pipecat/blob/main/README.md","numQuestions":6}'
#   → 202 {quiz:{id,status:"queued"}}   (repeat with the same key → 200, same quiz)
GET  /v1/catalog                              # the sample documents shown in the UI dropdown
GET  /v1/quizzes/{id}                         # poll until status = ready
POST /v1/quizzes/{id}/attempts                # start (or resume) an attempt
PUT  /v1/attempts/{id}/answers/{questionId}   # saved immediately; {optionIds, revision}
POST /v1/attempts/{id}/submit                 # scores from what is stored; safe to repeat
```

## Data flow

0. **Choose** — the web form shows a **dropdown** of ready-made documents (6 real READMEs + 7 test documents that each check one behaviour: multi-answer facts, code blocks, Portuguese, Spanish, prompt injection, a tiny document…) from `GET /v1/catalog`; "Other" still accepts any allowed URL. The list lives in one file, `packages/core/src/catalog.ts`.
1. **Create** — `POST /v1/quizzes` validates the body and the URL (https, host allow-list, no private IPs), inserts a `queued` row (unique `(owner, Idempotency-Key)`), publishes `{quizId}` to SQS, returns 202.
2. **Generate** — a worker claims the quiz (`UPDATE … WHERE status` is the idempotency guard), fetches the Markdown, **admits it** (hidden or encoded text is rejected, only English, Portuguese and Spanish are accepted, the sanitized text is what is stored) and runs the graph, where every model call is validated and every reply passes the output rails. State is checkpointed in Postgres after every node, so a crash resumes instead of repeating paid LLM calls. Questions/options are written in one transaction.
   **Score** — when the quiz is saved as `ready`, the worker sends a scoring job (ids only) to a **second queue**. A separate **scorer** service (same image, `WORKER_ROLE=score`, its own ECS service and DLQ) reads the quiz and the document from Postgres, computes **every** score (fixed checks, similarity, language, the judge with median of 3, and `quality_overall`) and stores them (Postgres, Langfuse, CloudWatch). The user does not wait for the judge: measured on real traces it was **18 s (median) of a 47 s generation**. The two services never call each other; they share Postgres and the queues. The worker itself saves the quiz and no scores (grounding and lint still run inside the generation graph, because they decide which questions are kept); if the scoring message is lost the sweeper re-queues ready quizzes with no score.
3. **Answer** — each choice is `PUT` and stored at once (`UNIQUE (attempt, question)`, monotonic `revision` so a delayed retry cannot overwrite a newer click).
4. **Submit** — one transaction, `SELECT … FOR UPDATE`, scores computed **from the database**, attempt locked; the answer key is never sent before this point.

Tables: `sources` → `quizzes` → `questions` → `options`; `quizzes` → `generation_jobs` (tokens, cost, trace id, resumable budget); `quizzes` → `attempts` → `answers` → `answer_selections` (real FK to the chosen option); `eval_scores` (quality metrics per quiz). Ownership is the Cognito `sub`.

## Validation of the JSON

The request/response schemas are one file (`packages/core/src/schemas.ts`) imported by the browser, the BFF, the API and the tests: the **browser form** validates before sending and parses **every response**; the **BFF** validates `POST /quizzes` and `PUT answers` before forwarding; the **API** validates body, params and headers (the trusted layer); **Postgres** enforces CHECK/UNIQUE/FK. Contract tests assert every API response of the full quiz flow against the same schemas, and that the hand-written OpenAPI file lists the same fields.

## Generation quality

* **Strategies**: a deterministic router picks `single-shot` (short docs) or `section-map-reduce` (long docs); `generate → critique → revise` wraps either.
* **Structured output is enforced by the application**, not trusted to the provider: MiniMax ignores `json_schema` field names and emits `<think>` blocks, so output goes extract → zod-validate → *repair loop that feeds the exact errors back*.
* **Output rails** (no LLM, see Security): the reply must be a clean quiz in the expected JSON format.
* **Hard gates** (no LLM): every question must carry a `sourceQuote` that exists in the document's visible text; lint catches "select all" with one correct option, give-away option lengths, letter prefixes… (duplicate questions are rejected by the schema)
* **LLM-as-judge** rubric (faithfulness counts double), run by a **different model** than the generator (`MINIMAX_JUDGE_MODEL`: M3 in the evals, `.env.example` and the Terraform values; the app itself falls back to the generator's model if it is not set) to avoid self-preference bias → scores on the Langfuse trace + `eval_scores` + CloudWatch metric `QuizQuality` (alarm below 0.6).
* **Similarity metrics** (TF-IDF cosine, deterministic and free; the MiniMax Token Plan key has no usable embeddings, and the `Embedder` interface accepts real ones later): *question diversity* (catches near-duplicate questions), *relevance* (each question vs. the document) and *section coverage*. Honest limit: lexical similarity catches near-verbatim duplicates, not paraphrases.
* **Regression suite** (`evals/`): a golden set (two real READMEs, a short doc, a Portuguese doc, a **prompt-injection** document) mirrored to the Langfuse Dataset `quizforge-golden`; every run is a Langfuse Experiment on it. The production agent is the system under test. Gated per item: grounded = 1, injection resisted = 1, language match = 1, lint floor 0.6 per item and **mean lint ≥ 0.9**, diversity ≥ 0.25, relevance ≥ 0.15, coverage ≥ 0.5, judge ≥ 0.40 (a floor for catastrophic quality only). Gated on the dataset: **mean judge ≥ 0.70**.
  *Why the judge is aggregated*: LLM judges are noisy. Measured on one fixed quiz, MiniMax-M3 scored 0.86, 0.86, 0.93, 0.86 and then 0.45; the generator's own model was stable (0.84–0.89) but is biased towards its own style. The CI judge is therefore a different model, run 3× with the median taken, and judged on the dataset mean. A first version of this gate failed a perfectly good quiz on exactly that outlier. Production uses the **same judge as CI** (M3, median of 3 parallel runs), run by the scorer service, so the two are comparable. The judge calls are traced in Langfuse as generations (time, tokens, cost). Real runs: all pass, mean judge 0.76–0.80, ~US$0.05.
* **One quality method** (`packages/llm/src/quality.ts`, versioned): every quiz generated in production and every quiz in the evals/experiments is scored by the same `scoreQuiz()`, with the same Langfuse score names (`grounded`, `lint_pass`, `question_diversity`, `relevance`, `coverage`, `language_match`, `judge_*`, `quality_overall`). `quality_overall` is a weighted average (judge 0.45, lint 0.15, on-topic 0.15, no near-duplicates 0.15, coverage 0.10) that is 0 when grounding or language fails, and is **left out** (never a different formula) if the judge fails twice. The scores go to Langfuse, to `eval_scores` in Postgres and to CloudWatch.
* **Comparing structures and prompts** (`pnpm --filter @quizforge/evals compare`, or the manual workflow *Compare generation structures*): 3 LangGraph topologies (`one-shot`, `critique-loop` = production, `plan-then-write`) × 3 generator prompts (`baseline`, `conceptual`, `fewshot`) over the golden set, one Langfuse Experiment per variant. Each quiz gets a **weighted average** of three kinds of instrument — LLM judge (0.35), deterministic checks (lint, coverage: 0.20) and **embedding cosine similarity** (0.45: against hand-written reference questions in `evals/references/`, against the document, and between the questions themselves) — with grounding / injection / language as hard gates. Embeddings are free and local (`paraphrase-multilingual-MiniLM-L12-v2` through transformers.js; the MiniMax key has no embeddings endpoint). The HTML report of the reference run (2 repetitions, 90 generations, ~US$0.83) is [`docs/eval/structure-comparison.html`](docs/eval/structure-comparison.html): it measured the run-to-run noise (±0.03) and concludes that, on this set, the structures are a technical tie, that the `conceptual` prompt only moves the LLM judge (not the embedding metrics), and that `fewshot` + critique has a real failure mode (the model copies raw markdown into its quotes).
* **Budget per job** (16 LLM calls / 120k tokens / 5 min) so layered retries (HTTP × repair × critique × SQS redelivery) cannot multiply; the allowance survives redelivery.
* Scoring itself is deterministic code — no LLM involved.

## Security

* Cognito **access tokens only**, verified in the API (signature/JWKS, `iss`, `exp`, `token_use`, `client_id`); sign-up disabled; users are created by an admin. Tokens live in **httpOnly cookies** and are exchanged by the Next.js server (PKCE), so browser JS never sees them.
* Every row is scoped by `sub`; another user's resource is a 404.
* SSRF guard on the document URL; the document is untrusted prompt input (delimiter neutralisation, schema-bound output, grounding gate).
* **Input guard** (`packages/core/src/guard.ts`, `packages/llm/src/llm-input.ts`): hidden or encoded text in a document (Base64, hex, ROT13, percent/escape/entity encodings, invisible Unicode and tag characters, look-alike letters, instructions in HTML comments or hidden elements, chat-template tokens) is **rejected before any model call**; plain-text instructions are flagged and kept as delimited data; invisible characters and HTML comments are removed and the sanitized text is what is stored. The quiz topic must be one plain line.
* **Languages:** only English, Portuguese and Spanish documents are accepted (`franc-min` on the prose; `ALLOWED_LANGUAGES` can only narrow the set). Anything else is rejected with a clear message.
* **Keyword rules** (`packages/core/src/injection-rules.ts`): 49 rules in 7 categories (override, role hijack, prompt leak, mode switch, output hijack, task swap, delimiter) for English, Portuguese and Spanish in full and the main phrases of French, German, Russian, Chinese and Japanese. Each rule ships examples that a test must match.
* **Output rails** (`packages/llm/src/output-guard.ts`): no second model. The reply must be the JSON object and almost nothing else, with no run of our own prompts, no script or link that is not in the document, no echoed instruction, and prompts that really are questions; a problem is one repair round, then the job retries. Every model call also gets an output cap (`maxTokens` 16,000) and a prompt cap (200,000 characters).
* **Semantic detector** (`packages/detector`, optional, off by default, English only): the ONNX version of `protectai/deberta-v3-base-prompt-injection-v2` through transformers.js. `INJECTION_DETECTOR=flag|block` in the worker, in an image that contains the package. `pnpm --filter @quizforge/detector corpus` scores the attack corpus. TODO: multilingual model, second Dockerfile target, bake the model into the image.
* **The model only gets validated structures:** strict zod schemas at the browser, BFF, API, worker input and on **every** model call (`guardLlm`), plus the output schema and the quote-must-exist gate.
* **promptfoo** (`promptfoo/`, `scripts/promptfoo.sh`): the `promptfoo` check runs on every PR (81 offline tests, no model, no secrets: attack corpus, language policy, topic validation, bad model replies, prompt safety rules, and **every document in `evals/fixtures`**, so a new test README is checked on its own pull request) and the live suite (21 tests on the real model: does it obey an instruction hidden in a document, does it stay on purpose) runs on main before a deploy and nightly. The attack corpus is one file, `packages/core/src/attacks.ts`, used by vitest and promptfoo.
* ALB accepts only CloudFront (managed prefix list **and** secret header); WAF rate-limits and applies AWS managed rules; RDS is in isolated subnets with verified TLS; secrets in Secrets Manager (DB password generated by RDS).
* CI: gitleaks, Trivy on images and Terraform, immutable ECR tags, OIDC federation (no AWS keys in GitHub); the deploy role is only assumable from the `main` branch through the approval-gated `production` environment.

## Operations

Idempotent, observable, and self-healing:

| Failure | What happens |
|---|---|
| client retries a request | same `Idempotency-Key` → original result |
| SQS redelivers a job | skipped if finished, otherwise resumes from the checkpoint |
| worker dies mid-job | visibility timeout → redelivery → resume; ≤3 attempts then DLQ + alarm |
| API→SQS publish lost | sweeper (every 5 min) re-queues; stuck `generating` quizzes are marked failed |
| bad deploy | ECS circuit breaker rolls back; migration runs first and is expand/contract |
| the scoring message is lost / the scorer dies | sweeper re-queues `ready` quizzes with no score (bounded by `scoring_attempts`); scoring DLQ + alarm after 3 receives |
| the judge fails on every attempt | no `quality_overall` (never a different formula), `judge_failed` stored, `JudgeFailed` metric → `judge-failing` alarm; the quiz is unaffected |
| the model cites text that is not in the document | revise ×2; if one question is still ungrounded it is **dropped** (quiz ships with 5+ questions); below 5 the job fails and the retry **regenerates from scratch** (a content failure never resumes a dead checkpoint) |

Alarms (CloudWatch → SNS): DLQ and scoring DLQ, oldest job age and oldest scoring job age, 5xx, CPU, RDS, **hourly average quality < 0.6**, **any single quiz < 0.4**, **judge failing** (quality not being measured), job failures, **daily LLM cost**; AWS Budget; CloudWatch dashboard `quizforge-prod`. Langfuse Hobby allows only 2 score alerts (Slack, webhook or GitHub Actions; no e-mail), so the main alarms live in CloudWatch. **E-mail needs a subscriber:** set the repository variable once (`gh variable set ALARM_EMAIL --body you@example.com`), deploy, and confirm the AWS subscription e-mail; the address is deliberately not committed.

## CI/CD

`.github/workflows/ci.yml` — on every PR: `quality` (typecheck, ESLint, unit tests, offline eval), `integration`, `migrations` (schema drift, policy, apply twice), `e2e`, `docker-build` (+Trivy), `terraform-validate` (+Trivy), `secrets-scan`, `promptfoo` (offline prompt-injection and input-guard suite), `terraform-plan` (commented on the PR).
`main` is protected by a ruleset (`infra/github`): no direct pushes, PR + **all checks green**, linear history, no bypass. After merge a real-model **`llm-eval` gate** (golden set on MiniMax, logged as a Langfuse experiment; fails if grounding, lint, judge score, prompt-injection resistance or language drop below the thresholds) joins the checks; the `deploy` job **needs every check including it**, waits for approval, builds arm64 images, runs the **migration as a one-off task before the new code**, applies Terraform, and smoke-tests through CloudFront. `drift.yml` (infrastructure drift) and `eval.yml` (model/provider drift) run nightly. Every workflow runs `bash -eo pipefail`, so a failure can never be hidden behind a pipe.

### First deployment

```bash
# 1. state bucket, ECR, GitHub OIDC roles  (local state, applied once with admin credentials)
cd infra/bootstrap && terraform init && terraform apply
# 2. branch protection, environment, pipeline variables
cd ../github && terraform init -backend-config=… && GITHUB_TOKEN=$(gh auth token) terraform apply
# 3. platform (or just merge to main and approve the deploy)
cd ../terraform && terraform init -backend-config=backend.hcl && terraform apply -var image_tag=<sha>
# 4. secrets and a user
scripts/set-secrets.sh && scripts/create-user.sh you@example.com
```

## Cost (us-east-2, running 24/7) ≈ US$150/month

Fargate ARM (5 small tasks) ~72 (+ ~7 for the scorer: 0.25 vCPU) · ALB ~20 · NAT ~35 · RDS t4g.micro ~15 · CloudFront/WAF/logs/etc ~10. LLM spend is cents per quiz.

### Pausing and resuming (≈ US$8/month while paused)

```bash
AWS_PROFILE=… scripts/pause.sh       # web/api/worker/scorer → 0 tasks, RDS stopped, NAT gateway + load balancer + WAF removed, sweeper off
AWS_PROFILE=… scripts/resume.sh      # everything back (~15 min: the load balancer and WAF are recreated), then waits until the app answers
AWS_PROFILE=… scripts/env-status.sh  # RUNNING or PAUSED, resource by resource
```

It is the Terraform variable `paused` (so the state stays truthful) plus the repository variable `PAUSED`, which makes the `deploy` job refuse to run and keeps PR plans consistent. Data and the deployed image version are preserved. Still billed while paused (about US$8 a month): RDS storage, KMS keys, secrets, logs, ECR images. CloudFront stays (free when idle) and keeps its domain name, so the Cognito callback URLs stay valid. AWS restarts a stopped RDS by itself after 7 days — run `pause.sh` again if you stay paused longer. For zero cost use `terraform destroy`.

## Known limits / next steps

* No custom domain → CloudFront→ALB hop is HTTP inside AWS (ALB locked to CloudFront). A domain + ACM certificate removes it.
* One NAT gateway and single-AZ RDS (toggle `db_multi_az`); documented trade-offs for cost.
* `tsx` runs the TypeScript at runtime in the API/worker images; a compiled build would start faster.
* Langfuse Cloud Hobby allows only 2 score alerts and none by e-mail, so quality/cost alarms are emitted as CloudWatch metrics by the worker and the scorer. (A Langfuse alert on `quality_overall` to Slack would be a cheap extra.)
* TypeSafe AI "Jev" was evaluated and left out: it classifies/scores with calibrated probabilities but does not generate text, and has no free tier — a candidate cheap *judge* later.
