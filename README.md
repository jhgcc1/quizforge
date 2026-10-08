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
                                                                              └──────> Langfuse Cloud + CloudWatch (EMF)
```

## Run it locally (no AWS, no API keys)

```bash
pnpm install
docker compose --profile app up --build      # Postgres, SQS emulator, migrate, api, worker (fake LLM), web
open http://localhost:13000                  # dev login → create quiz → answer → score
```

Real model: `LLM_MODE=minimax MINIMAX_API_KEY=… docker compose --profile app up --build worker`.

| | |
|---|---|
| `pnpm test` | unit + property tests (scoring, schemas, SSRF guard, JSON extraction, graph, migration policy) |
| `pnpm test:integration` | real Postgres: idempotency, concurrency, API, worker, sweeper, migrate entrypoint |
| `pnpm test:e2e` | Playwright against the whole stack: login → generate → answer → **reload** → submit → score |
| `pnpm --filter @quizforge/llm smoke <url>` | live run against MiniMax, traced in Langfuse |
| `pnpm --filter @quizforge/evals eval` | **LLM regression suite** over a golden set (grounding, lint, LLM-judge, prompt-injection, language) with thresholds; also runs nightly in CI |
| `scripts/audit-aws.sh` | read-only audit of the *deployed* infrastructure against the security claims below (39 checks) |
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
2. **Generate** — a worker claims the quiz (`UPDATE … WHERE status` is the idempotency guard), fetches the Markdown, and runs the graph. State is checkpointed in Postgres after every node, so a crash resumes instead of repeating paid LLM calls. Questions/options are written in one transaction.
3. **Answer** — each choice is `PUT` and stored at once (`UNIQUE (attempt, question)`, monotonic `revision` so a delayed retry cannot overwrite a newer click).
4. **Submit** — one transaction, `SELECT … FOR UPDATE`, scores computed **from the database**, attempt locked; the answer key is never sent before this point.

Tables: `sources` → `quizzes` → `questions` → `options`; `quizzes` → `generation_jobs` (tokens, cost, trace id, resumable budget); `quizzes` → `attempts` → `answers` → `answer_selections` (real FK to the chosen option); `eval_scores` (quality metrics per quiz). Ownership is the Cognito `sub`.

## Validation of the JSON

The request/response schemas are one file (`packages/core/src/schemas.ts`) imported by the browser, the BFF, the API and the tests: the **browser form** validates before sending and parses **every response**; the **BFF** validates `POST /quizzes` and `PUT answers` before forwarding; the **API** validates body, params and headers (the trusted layer); **Postgres** enforces CHECK/UNIQUE/FK. Contract tests assert every API response of the full quiz flow against the same schemas, and that the hand-written OpenAPI file lists the same fields.

## Generation quality

* **Strategies**: a deterministic router picks `single-shot` (short docs) or `section-map-reduce` (long docs); `generate → critique → revise` wraps either.
* **Structured output is enforced by the application**, not trusted to the provider: MiniMax ignores `json_schema` field names and emits `<think>` blocks, so output goes extract → zod-validate → *repair loop that feeds the exact errors back*.
* **Hard gates** (no LLM): every question must carry a `sourceQuote` that exists in the document's visible text; lint catches "select all" with one correct option, give-away option lengths, duplicates…
* **LLM-as-judge** rubric (faithfulness counts double), run by a **different model** than the generator (`MINIMAX_JUDGE_MODEL`, default M3) to avoid self-preference bias → scores on the Langfuse trace + `eval_scores` + CloudWatch metric `QuizQuality` (alarm below 0.6).
* **Similarity metrics** (TF-IDF cosine, deterministic and free; the MiniMax Token Plan key has no usable embeddings, and the `Embedder` interface accepts real ones later): *question diversity* (catches near-duplicate questions), *relevance* (each question vs. the document) and *section coverage*. Honest limit: lexical similarity catches near-verbatim duplicates, not paraphrases.
* **Regression suite** (`evals/`): a golden set (two real READMEs, a short doc, a Portuguese doc, a **prompt-injection** document) mirrored to the Langfuse Dataset `quizforge-golden`; every run is a Langfuse Experiment on it. The production agent is the system under test. Gated per item: grounded = 1, injection resisted = 1, language match = 1, lint ≥ 0.85, diversity ≥ 0.25, relevance ≥ 0.15, coverage ≥ 0.5, judge ≥ 0.40 (a floor for catastrophic quality only). Gated on the dataset: **mean judge ≥ 0.70**.
  *Why the judge is aggregated*: LLM judges are noisy. Measured on one fixed quiz, MiniMax-M3 scored 0.86, 0.86, 0.93, 0.86 and then 0.45; the generator's own model was stable (0.84–0.89) but is biased towards its own style. The CI judge is therefore a different model, run 3× with the median taken, and judged on the dataset mean. A first version of this gate failed a perfectly good quiz on exactly that outlier. Production now uses the **same judge as CI** (M3, median of 3 parallel runs), so the two are comparable. Real runs: all pass, mean judge 0.76–0.80, ~US$0.05.
* **One quality method** (`packages/llm/src/quality.ts`, versioned): every quiz generated in production and every quiz in the evals/experiments is scored by the same `scoreQuiz()`, with the same Langfuse score names (`grounded`, `lint_pass`, `question_diversity`, `relevance`, `coverage`, `language_match`, `judge_*`, `quality_overall`). `quality_overall` is a weighted average (judge 0.45, lint 0.15, on-topic 0.15, no near-duplicates 0.15, coverage 0.10) that is 0 when grounding or language fails, and is **left out** (never a different formula) if the judge fails twice. The scores go to Langfuse, to `eval_scores` in Postgres and to CloudWatch.
* **Comparing structures and prompts** (`pnpm --filter @quizforge/evals compare`, or the manual workflow *Compare generation structures*): 3 LangGraph topologies (`one-shot`, `critique-loop` = production, `plan-then-write`) × 3 generator prompts (`baseline`, `conceptual`, `fewshot`) over the golden set, one Langfuse Experiment per variant. Each quiz gets a **weighted average** of three kinds of instrument — LLM judge (0.35), deterministic checks (lint, coverage: 0.20) and **embedding cosine similarity** (0.45: against hand-written reference questions in `evals/references/`, against the document, and between the questions themselves) — with grounding / injection / language as hard gates. Embeddings are free and local (`paraphrase-multilingual-MiniLM-L12-v2` through transformers.js; the MiniMax key has no embeddings endpoint). The HTML report of the reference run (2 repetitions, 90 generations, ~US$0.83) is [`docs/eval/structure-comparison.html`](docs/eval/structure-comparison.html): it measured the run-to-run noise (±0.03) and concludes that, on this set, the structures are a technical tie, that the `conceptual` prompt only moves the LLM judge (not the embedding metrics), and that `fewshot` + critique has a real failure mode (the model copies raw markdown into its quotes).
* **Budget per job** (16 LLM calls / 120k tokens / 5 min) so layered retries (HTTP × repair × critique × SQS redelivery) cannot multiply; the allowance survives redelivery.
* Scoring itself is deterministic code — no LLM involved.

## Security

* Cognito **access tokens only**, verified in the API (signature/JWKS, `iss`, `exp`, `token_use`, `client_id`); sign-up disabled; users are created by an admin. Tokens live in **httpOnly cookies** and are exchanged by the Next.js server (PKCE), so browser JS never sees them.
* Every row is scoped by `sub`; another user's resource is a 404.
* SSRF guard on the document URL; the document is untrusted prompt input (delimiter neutralisation, schema-bound output, grounding gate).
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
| the model cites text that is not in the document | revise ×2; if one question is still ungrounded it is **dropped** (quiz ships with 5+ questions); below 5 the job fails and the retry **regenerates from scratch** (a content failure never resumes a dead checkpoint) |

Alarms (CloudWatch → SNS): DLQ, oldest job age, 5xx, CPU, RDS, **hourly average quality < 0.6**, **any single quiz < 0.4**, **judge failing** (quality not being measured), job failures, **daily LLM cost**; AWS Budget; CloudWatch dashboard `quizforge-prod`. Langfuse Hobby allows only 2 score alerts (Slack, webhook or GitHub Actions; no e-mail), so the main alarms live in CloudWatch. **E-mail needs a subscriber:** set the repository variable once (`gh variable set ALARM_EMAIL --body you@example.com`), deploy, and confirm the AWS subscription e-mail; the address is deliberately not committed.

## CI/CD

`.github/workflows/ci.yml` — on every PR: `quality`, `integration`, `migrations` (schema drift, policy, apply twice), `e2e`, `docker-build` (+Trivy), `terraform-validate` (+Trivy), `secrets-scan`, `terraform-plan` (commented on the PR).
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

Fargate ARM (5 small tasks) ~72 · ALB ~20 · NAT ~35 · RDS t4g.micro ~15 · CloudFront/WAF/logs/etc ~10. LLM spend is cents per quiz.

### Pausing and resuming (≈ US$1–2/day while paused)

```bash
AWS_PROFILE=… scripts/pause.sh       # web/api/worker → 0 tasks, RDS stopped, NAT gateway removed, sweeper off
AWS_PROFILE=… scripts/resume.sh      # everything back (~10 min), then waits until the app answers
AWS_PROFILE=… scripts/env-status.sh  # RUNNING or PAUSED, resource by resource
```

It is the Terraform variable `paused` (so the state stays truthful) plus the repository variable `PAUSED`, which makes the `deploy` job refuse to run and keeps PR plans consistent. Data and the deployed image version are preserved. Still billed while paused: ALB, WAF, RDS storage, KMS keys, secrets. AWS restarts a stopped RDS by itself after 7 days — run `pause.sh` again if you stay paused longer. For zero cost use `terraform destroy`.

## Known limits / next steps

* No custom domain → CloudFront→ALB hop is HTTP inside AWS (ALB locked to CloudFront). A domain + ACM certificate removes it.
* One NAT gateway and single-AZ RDS (toggle `db_multi_az`); documented trade-offs for cost.
* `tsx` runs the TypeScript at runtime in the API/worker images; a compiled build would start faster.
* Langfuse Cloud Hobby allows only 2 score alerts and none by e-mail, so quality/cost alarms are emitted as CloudWatch metrics by the worker. (A Langfuse alert on `quality_overall` to Slack would be a cheap extra.)
* TypeSafe AI "Jev" was evaluated and left out: it classifies/scores with calibrated probabilities but does not generate text, and has no free tier — a candidate cheap *judge* later.
