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
GET  /v1/quizzes/{id}                         # poll until status = ready
POST /v1/quizzes/{id}/attempts                # start (or resume) an attempt
PUT  /v1/attempts/{id}/answers/{questionId}   # saved immediately; {optionIds, revision}
POST /v1/attempts/{id}/submit                 # scores from what is stored; safe to repeat
```

## Data flow

1. **Create** — `POST /v1/quizzes` validates the body and the URL (https, host allow-list, no private IPs), inserts a `queued` row (unique `(owner, Idempotency-Key)`), publishes `{quizId}` to SQS, returns 202.
2. **Generate** — a worker claims the quiz (`UPDATE … WHERE status` is the idempotency guard), fetches the Markdown, and runs the graph. State is checkpointed in Postgres after every node, so a crash resumes instead of repeating paid LLM calls. Questions/options are written in one transaction.
3. **Answer** — each choice is `PUT` and stored at once (`UNIQUE (attempt, question)`, monotonic `revision` so a delayed retry cannot overwrite a newer click).
4. **Submit** — one transaction, `SELECT … FOR UPDATE`, scores computed **from the database**, attempt locked; the answer key is never sent before this point.

Tables: `sources` → `quizzes` → `questions` → `options`; `quizzes` → `generation_jobs` (tokens, cost, trace id, resumable budget); `quizzes` → `attempts` → `answers` → `answer_selections` (real FK to the chosen option); `eval_scores` (quality metrics per quiz). Ownership is the Cognito `sub`.

## Generation quality

* **Strategies**: a deterministic router picks `single-shot` (short docs) or `section-map-reduce` (long docs); `generate → critique → revise` wraps either.
* **Structured output is enforced by the application**, not trusted to the provider: MiniMax ignores `json_schema` field names and emits `<think>` blocks, so output goes extract → zod-validate → *repair loop that feeds the exact errors back*.
* **Hard gates** (no LLM): every question must carry a `sourceQuote` that exists in the document's visible text; lint catches "select all" with one correct option, give-away option lengths, duplicates…
* **LLM-as-judge** rubric (faithfulness counts double) → scores on the Langfuse trace + `eval_scores` + CloudWatch metric `QuizQuality` (alarm below 0.6).
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

Alarms (SNS e-mail): DLQ, oldest job age, 5xx, CPU, RDS, **quality < 0.6**, job failures, **daily LLM cost**; AWS Budget; CloudWatch dashboard `quizforge-prod`.

## CI/CD

`.github/workflows/ci.yml` — on every PR: `quality`, `integration`, `migrations` (schema drift, policy, apply twice), `e2e`, `docker-build` (+Trivy), `terraform-validate` (+Trivy), `secrets-scan`, `terraform-plan` (commented on the PR).
`main` is protected by a ruleset (`infra/github`): no direct pushes, PR + **all checks green**, linear history, no bypass. After merge the `deploy` job **needs every check**, waits for approval, builds arm64 images, runs the **migration as a one-off task before the new code**, applies Terraform, and smoke-tests through CloudFront. `drift.yml` runs nightly.

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

Fargate ARM (5 small tasks) ~72 · ALB ~20 · NAT ~35 · RDS t4g.micro ~15 · CloudFront/WAF/logs/etc ~10. `terraform destroy` (or scaling services to 0) outside demo windows; LLM spend is cents per quiz.

## Known limits / next steps

* No custom domain → CloudFront→ALB hop is HTTP inside AWS (ALB locked to CloudFront). A domain + ACM certificate removes it.
* One NAT gateway and single-AZ RDS (toggle `db_multi_az`); documented trade-offs for cost.
* `tsx` runs the TypeScript at runtime in the API/worker images; a compiled build would start faster.
* Langfuse Cloud Hobby has no native alerting, so quality/cost alarms are emitted as CloudWatch metrics by the worker.
* TypeSafe AI "Jev" was evaluated and left out: it classifies/scores with calibrated probabilities but does not generate text, and has no free tier — a candidate cheap *judge* later.
