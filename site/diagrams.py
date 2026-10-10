from lib import arrow, bar_chart, box, group, path, svg, text


def architecture():
    b = ""
    b += group(190, 60, 250, 150, "Identity (AWS)", "grp")
    b += box(210, 100, 210, 62, "Amazon Cognito", "Hosted UI · PKCE · no sign-up", "sec")
    b += box(20, 300, 130, 64, "Browser", "User's Chrome", "ext")
    b += group(190, 250, 250, 200, "Edge", "grp")
    b += box(210, 278, 210, 52, "AWS WAF", "rate limit + managed rules", "sec", small=True)
    b += box(210, 350, 210, 56, "CloudFront", "HTTPS · caches only /_next/static", "edge")
    b += group(470, 40, 540, 668, "VPC 10.20.0.0/16 · us-east-2 · 2 AZs", "grp vpc")
    b += group(486, 70, 508, 118, "Public subnets", "grp sub")
    b += box(506, 100, 200, 60, "ALB", "CloudFront only + secret header", "edge")
    b += box(780, 100, 190, 60, "NAT Gateway", "outbound internet (~$33/mo)", "edge", small=True)
    b += group(486, 220, 508, 300, "Private subnets (app) · Fargate ARM64", "grp sub")
    b += box(504, 262, 140, 74, "web ×2–6", "Next.js SSR + BFF", "compute")
    b += box(664, 262, 140, 74, "api ×2–6", "Fastify · JWT", "compute")
    b += box(830, 262, 150, 74, "worker ×1–4", "LangGraph · 1 job/task", "ai")
    b += box(690, 392, 150, 60, "SQS: jobs + scoring", "each with a dead-letter queue", "data", small=True)
    b += box(782, 466, 112, 46, "scorer ×1–2", "the judge", "ai", small=True)
    b += arrow(815, 452, 830, 466, "", dash=True)
    b += text(902, 492, "score jobs", "note")
    b += box(504, 392, 150, 60, "sweeper", "EventBridge · 5 min", "compute", small=True)
    b += text(506, 490, "Cloud Map: api.quizforge.internal", "note")
    b += group(486, 550, 508, 140, "Data subnets (no internet route)", "grp sub")
    b += box(506, 590, 210, 70, "RDS PostgreSQL 16", "TLS verify-full · KMS · backup", "data")
    b += box(760, 590, 210, 70, "schema langgraph", "agent checkpoints", "data", small=True)
    b += group(1030, 40, 140, 190, "Internet (via NAT)", "grp ext")
    b += box(1042, 72, 116, 44, "MiniMax API", "", "ext", small=True)
    b += box(1042, 124, 116, 44, "Langfuse Cloud", "", "ext", small=True)
    b += box(1042, 176, 116, 44, "GitHub (README)", "", "ext", small=True)
    b += group(1030, 250, 140, 440, "Managed", "grp mgd")
    b += box(1042, 284, 116, 52, "Secrets Mgr", "", "sec", small=True)
    b += box(1042, 350, 116, 52, "CloudWatch", "logs · metrics · alarms", "mgd", small=True)
    b += box(1042, 416, 116, 52, "ECR", "immutable images", "mgd", small=True)
    b += box(1042, 482, 116, 52, "SNS + Budgets", "alerts", "mgd", small=True)
    b += box(1042, 548, 116, 52, "S3 + KMS", "Terraform state", "mgd", small=True)
    b += text(1100, 630, "used by all", "note", "middle")
    b += text(1100, 646, "services", "note", "middle")
    b += arrow(150, 332, 210, 372, "HTTPS", lx=170, ly=336)
    b += arrow(85, 300, 250, 162, "login (PKCE)", dash=True, lx=110, ly=222)
    b += arrow(420, 378, 506, 140, "HTTP", lx=470, ly=262)
    b += arrow(560, 160, 560, 262, "/*", lx=550, ly=215, anchor="end")
    b += arrow(650, 160, 725, 262, "/v1/*  /docs", lx=712, ly=205)
    b += arrow(644, 299, 664, 299)
    b += arrow(734, 336, 760, 392, "publish", lx=736, ly=372, anchor="end")
    b += arrow(840, 422, 905, 336, "consume", dash=True, lx=868, ly=422, anchor="start")
    b += arrow(930, 262, 880, 160, "LLM · Langfuse · README", dash=True, lx=898, ly=206, anchor="end")
    b += arrow(970, 130, 1030, 130)
    b += arrow(690, 336, 612, 590, "SQL", lx=648, ly=430, anchor="end")
    b += arrow(940, 336, 870, 590, "state", lx=914, ly=474, anchor="start")
    return svg(1180, 720, b, "System architecture: from the browser to the agent and the database")


def seq(w, h, lanes, steps, title):
    b = ""
    xs = {}
    for i, (name, sub, kind) in enumerate(lanes):
        x = 70 + i * (w - 140) / (len(lanes) - 1)
        xs[name] = x
        b += box(x - 62, 14, 124, 46, name, sub, kind, small=True)
        b += f'<line x1="{x}" y1="60" x2="{x}" y2="{h - 14}" class="life"/>'
    y = 96
    for n, (a, c, label, dash) in enumerate(steps, 1):
        x1, x2 = xs[a], xs[c]
        if a == c:
            b += path(f"M{x1} {y} h 46 v 22 h -46", "", 0, 0)
            b += f'<text x="{x1 + 54}" y="{y + 12}" class="alabel">{n}. {label}</text>'
            y += 44
            continue
        b += arrow(x1, y, x2, y, "", dash=dash)
        mx = (x1 + x2) / 2
        b += f'<text x="{mx}" y="{y - 6}" text-anchor="middle" class="alabel">{n}. {label}</text>'
        y += 40
    return svg(w, h, b, title)


def seq_create():
    lanes = [("Browser", "", "ext"), ("web (BFF)", "cookie → Bearer token", "compute"), ("api", "Fastify", "compute"), ("SQS", "2 queues", "data"),
             ("worker", "LangGraph", "ai"), ("scorer", "the judge", "ai"), ("MiniMax", "LLM", "ext"), ("Postgres", "RDS", "data")]
    steps = [
        ("Browser", "web (BFF)", "POST /bff/v1/quizzes + Idempotency-Key", False),
        ("web (BFF)", "api", "POST /v1/quizzes (Bearer JWT)", False),
        ("api", "Postgres", "INSERT quiz 'queued' (unique owner+key)", False),
        ("api", "SQS", "publish {quizId}", False),
        ("api", "Browser", "202 Accepted (a replay returns 200 + the same quiz)", True),
        ("SQS", "worker", "deliver the message (long poll)", False),
        ("worker", "Postgres", "claim: queued → generating; fetch the document", False),
        ("worker", "MiniMax", "generate · review · revise", False),
        ("worker", "Postgres", "questions saved (1 transaction) → ready, no scores", False),
        ("worker", "SQS", "send a score job {quizId, jobId}", False),
        ("Browser", "api", "GET /v1/quizzes/:id → ready (the user has the quiz)", True),
        ("SQS", "scorer", "deliver the score job", False),
        ("scorer", "MiniMax", "judge ×3 (median)", False),
        ("scorer", "Postgres", "judge scores + quality_overall (also Langfuse, CloudWatch)", False),
    ]
    return seq(1260, 720, lanes, steps, "Flow A: create a quiz. The user has it at step 11; scoring follows on its own")


def seq_answer():
    lanes = [("Browser", "", "ext"), ("web (BFF)", "", "compute"), ("api", "", "compute"), ("Postgres", "", "data")]
    steps = [
        ("Browser", "web (BFF)", "PUT answer {optionIds, revision}", False),
        ("web (BFF)", "api", "PUT /v1/attempts/:id/answers/:qid", False),
        ("api", "Postgres", "UPSERT … WHERE revision < new (an old retry is ignored)", False),
        ("api", "Browser", "{saved | ignored}: an old retry is ignored, so retrying is safe", True),
        ("Browser", "api", "POST /submit", False),
        ("api", "Postgres", "SELECT … FOR UPDATE · lock the attempt row · score computed in the API", False),
        ("api", "Browser", "result + answer key + explanations (a replay returns the same)", True),
    ]
    return seq(980, 400, lanes, steps, "Flow B: answer and score (synchronous, no LLM)")


def agent_graph():
    b = ""
    b += box(20, 150, 130, 62, "fetch + SSRF", "https · allow-list · public IP", "sec", small=True)
    b += box(180, 150, 120, 62, "router", "heuristic (no LLM)", "compute", small=True)
    b += box(340, 60, 190, 62, "single-shot", "short doc: 1 prompt", "ai", small=True)
    b += box(340, 240, 190, 62, "section-map-reduce", "sections × 2 candidates", "ai", small=True)
    b += box(560, 150, 170, 62, "check (no LLM)", "schema · grounding · lint", "sec", small=True)
    b += box(750, 60, 150, 62, "critique (LLM)", "once", "ai", small=True)
    b += box(750, 240, 150, 62, "revise (LLM)", "flagged only · ≤2×", "ai", small=True)
    b += box(930, 150, 160, 62, "finalize", "drops ungrounded (≥5)", "sec", small=True)
    b += box(930, 330, 160, 62, "persist (no scores)", "RDS → ready", "data", small=True)
    b += box(560, 330, 180, 62, "send score job", "SQS → the scorer runs the judge", "mgd", small=True)
    b += arrow(150, 181, 180, 181)
    b += arrow(300, 170, 340, 100, "short", lx=318, ly=124, anchor="end")
    b += arrow(300, 195, 340, 262, "long", lx=312, ly=244, anchor="end")
    b += arrow(530, 96, 600, 150)
    b += arrow(530, 270, 600, 212)
    b += arrow(730, 170, 750, 100)
    b += arrow(730, 200, 750, 262, "problems", lx=690, ly=250, anchor="end")
    b += arrow(825, 122, 825, 240, "flagged", lx=832, ly=185, anchor="start")
    b += path("M750 290 C 700 300, 650 270, 640 212", "re-check", 640, 290, dash=True)
    b += arrow(900, 181, 930, 181)
    b += text(915, 172, "ok", "alabel", "middle")
    b += arrow(1005, 212, 1005, 330)
    b += arrow(930, 361, 740, 361)
    b += text(20, 330, "State is saved in Postgres after every node (LangGraph checkpointer):", "note")
    b += text(20, 348, "if the worker dies, the SQS redelivery resumes from the last node.", "note")
    b += text(20, 372, "Budget per job: 16 calls · 120k tokens · 5 min (survives redelivery).", "note")
    b += text(20, 396, "A CONTENT failure deletes the checkpoint: the retry regenerates from scratch.", "note")
    b += text(20, 420, "The judge is not a node any more: the quiz is saved as ready first, then judged in the scorer service.", "note")
    return svg(1100, 450, b, "The agent (LangGraph): generation, fixed checks and review. The judge runs later, in the scorer")


def entity(x, y, name, cols, kind="data", w=290):
    h = 42 + 17 * len(cols)
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" class="box {kind}"/>'
    out += f'<text x="{x + 12}" y="{y + 20}" class="t">{name}</text><line x1="{x}" y1="{y + 28}" x2="{x + w}" y2="{y + 28}" class="grid"/>'
    for i, c in enumerate(cols):
        out += f'<text x="{x + 12}" y="{y + 46 + 17 * i}" class="sub" style="text-anchor:start">{c}</text>'
    return out, h


def er():
    b = ""
    ents = {
        "sources": (20, 20, ["id PK", "url, raw_url", "content_sha256 UNIQUE", "content_text, fetched_at"], "mgd"),
        "quizzes": (20, 170, ["id PK · owner_sub (Cognito)", "source_id → sources", "status queued|generating|ready|failed", "strategy_requested/used · critique", "num_questions CHECK 5..8 (real count)", "idempotency_key · request_hash", "UNIQUE (owner_sub, idempotency_key)"], "data"),
        "generation_jobs": (20, 420, ["id PK · quiz_id → quizzes", "attempt_no · status · model", "prompt/completion/cached tokens", "cost_usd · langfuse_trace_id", "budget_state jsonb (survives retries)", "scored_at · scoring_attempts", "scoring_claimed_until (scorer lease)"], "ai"),
        "questions": (350, 170, ["id PK · quiz_id → quizzes", "position 1..8 UNIQUE(quiz,pos)", "prompt · type single|multiple", "explanation · source_quote", "difficulty"], "data"),
        "options": (350, 370, ["id PK · question_id → questions", "position 1..4 UNIQUE(q,pos)", "text", "is_correct (never sent before submit)"], "data"),
        "attempts": (680, 20, ["id PK · quiz_id → quizzes", "user_sub · status in_progress|submitted", "final_score CHECK 0..4 · scoring_version", "idempotency_key · request_hash", "partial UNIQUE: 1 in_progress per (quiz, user)"], "data"),
        "answers": (680, 200, ["id PK · attempt_id → attempts", "question_id → questions", "score 0..4 · weight", "revision (guards against a late retry)", "UNIQUE (attempt_id, question_id)"], "data"),
        "answer_selections": (680, 395, ["answer_id → answers  ┐ composite", "option_id → options    ┘ PK", "FK to the chosen option"], "data"),
        "eval_scores": (1000, 200, ["id PK · target_type quiz|question|attempt", "target_id · evaluator · value", "reasoning · langfuse_score_id"], "ai"),
    }
    pos = {}
    for name, (x, y, cols, kind) in ents.items():
        s, h = entity(x, y, name, cols, kind, 290 if name != "eval_scores" else 250)
        b += s
        pos[name] = (x, y, 290 if name != "eval_scores" else 250, h)
    def mid(n, side):
        x, y, w, h = pos[n]
        return {"l": (x, y + h / 2), "r": (x + w, y + h / 2), "t": (x + w / 2, y), "b": (x + w / 2, y + h)}[side]
    for a, sa, c, sc, lab in [("sources", "b", "quizzes", "t", "1 : N"), ("quizzes", "b", "generation_jobs", "t", "1 : N"), ("quizzes", "r", "questions", "l", "1 : N"),
                              ("questions", "b", "options", "t", "1 : 4"), ("attempts", "b", "answers", "t", "1 : N"),
                              ("answers", "b", "answer_selections", "t", "1 : N"), ("answer_selections", "l", "options", "r", "N : 1")]:
        x1, y1 = mid(a, sa); x2, y2 = mid(c, sc)
        horiz = abs(y1 - y2) < abs(x1 - x2)
        b += arrow(x1, y1, x2, y2, lab, lx=(x1 + x2) / 2 + (0 if horiz else 22), ly=(y1 + y2) / 2 - (8 if horiz else 0))
    qx, qy = pos["quizzes"][0], pos["quizzes"][1]
    b += path(f"M{qx + 230} {qy} V 148 H 640 V 110 H 680", "1 : N", 500, 140)
    b += text(1000, 40, "Owner = Cognito sub.", "note")
    b += text(1000, 58, "There is no users table", "note")
    b += text(1000, 76, "(the identity provider is the source of truth).", "note")
    b += text(1000, 360, "Schema langgraph (not in this", "note")
    b += text(1000, 378, "diagram): agent checkpoints,", "note")
    b += text(1000, 396, "managed by PostgresSaver.", "note")
    return svg(1260, 580, b, "Data model (PostgreSQL) and its invariants")


def network():
    b = ""
    b += box(380, 8, 240, 40, "Internet Gateway", "", "edge", small=True)
    b += group(20, 70, 960, 500, "VPC 10.20.0.0/16", "grp vpc")
    for i, (az, x) in enumerate([("us-east-2a", 40), ("us-east-2b", 520)]):
        b += group(x, 100, 440, 450, az, "grp sub")
        b += group(x + 12, 128, 416, 104, "public 10.20.%d.0/24" % i, "grp")
        b += group(x + 12, 250, 416, 130, "app (private) 10.20.%d.0/24" % (10 + i), "grp")
        b += group(x + 12, 398, 416, 130, "data (isolated) 10.20.%d.0/24" % (20 + i), "grp")
    b += box(70, 156, 150, 56, "ALB (node)", "", "edge", small=True)
    b += box(250, 156, 160, 56, "NAT Gateway", "only in us-east-2a", "edge", small=True)
    b += box(550, 156, 150, 56, "ALB (node)", "", "edge", small=True)
    for x in (58, 180, 540, 662):
        pass
    b += box(54, 280, 96, 70, "web", "task", "compute", small=True)
    b += box(160, 280, 96, 70, "api", "task", "compute", small=True)
    b += box(266, 280, 96, 70, "worker", "task", "ai", small=True)
    b += box(372, 280, 96, 70, "scorer", "task", "ai", small=True)
    b += box(534, 280, 96, 70, "web", "task", "compute", small=True)
    b += box(640, 280, 96, 70, "api", "task", "compute", small=True)
    b += box(746, 280, 96, 70, "worker", "scales to 4", "ai", small=True)
    b += box(852, 280, 96, 70, "scorer", "scales to 2", "ai", small=True)
    b += box(80, 430, 200, 70, "RDS PostgreSQL", "single-AZ (multi_az flag)", "data", small=True)
    b += box(580, 430, 200, 70, "(empty)", "standby subnet", "mgd", small=True)
    b += arrow(500, 48, 140, 156, "0.0.0.0/0", lx=300, ly=96)
    b += arrow(355, 280, 355, 212, "outbound via NAT", dash=True, lx=362, ly=250, anchor="start")
    b += arrow(170, 350, 180, 430, "5432", lx=120, ly=392)
    b += text(40, 590, "S3 gateway endpoint (free) in the app route tables: ECR image layers do not go through the NAT.", "note")
    b += text(40, 610, "The data subnets have no default route: the database has no path to the internet.", "note")
    b += text(40, 630, "Security groups: ALB ← CloudFront prefix list · web ← ALB · api ← ALB + web · db ← api + worker security groups (the scorer and sweeper use the worker group).", "note")
    return svg(1000, 650, b, "AWS network: 3 subnet tiers in 2 availability zones")


def security_layers():
    b = ""
    b += group(10, 10, 980, 460, "1 · Edge: CloudFront + WAF", "grp edgeg")
    b += text(30, 56, "HTTPS only (redirect) · WAF: rate limit 1000 requests / 5 min / IP + AWSManagedRulesCommon + KnownBadInputs", "note")
    b += group(40, 74, 920, 380, "2 · ALB: security group allows only the CloudFront prefix list  +  secret header x-origin-verify (otherwise 403)", "grp sub")
    b += group(70, 126, 860, 310, "3 · Application: authentication, authorization and validation", "grp")
    b += text(90, 170, "Cognito: no sign-up · password ≥12 · optional MFA · tokens in httpOnly/Secure/SameSite cookies (BFF) · CSRF: Origin + header", "note")
    b += text(90, 190, "API: aws-jwt-verify (signature/JWKS, iss, exp, token_use=access, client_id) · everything filtered by sub (someone else's = 404)", "note")
    b += text(90, 210, "Input: zod in browser + BFF + API · Idempotency-Key · daily quota · per-user rate limit · SSRF guard (https, allow-list, public DNS)", "note")
    b += text(90, 230, "Prompt injection: hidden/encoded text rejected · only en/pt/es · plain instructions flagged and delimited · strict schema before every model call · promptfoo gate", "note")
    b += group(100, 252, 800, 160, "4 · Data and secrets", "grp mgd")
    b += text(120, 296, "Data subnets with no internet route · RDS encrypted (KMS) · TLS enforced and verified (verify-full + AWS CA)", "note")
    b += text(120, 316, "Database password generated and stored by RDS in Secrets Manager · LLM keys only in Secrets Manager (not in Terraform)", "note")
    b += text(120, 336, "Least-privilege tasks: api can only SendMessage · worker consumes jobs and sends score jobs · scorer only consumes the scoring queue · exec role reads only the 4 secrets", "note")
    b += text(120, 356, "Terraform state: own KMS key, versioned, TLS-only, no public access", "note")
    b += text(120, 376, "CI: OIDC (no AWS keys) · deploy only from main through an approved environment · plan role cannot read Secrets Manager (it can read the Terraform state) · gitleaks · Trivy", "note")
    return svg(1000, 485, b, "Defense in depth: four layers between the internet and the data")


def retries():
    b = ""
    b += group(10, 10, 980, 440, "SQS: 3 receives (backoff 20s → 40s) → dead-letter queue + alarm · 360s visibility with heartbeat", "grp")
    b += group(40, 56, 920, 370, "Budget per job: 16 calls · 120k tokens · 5 min (generation: persisted, not reset on redelivery; the scorer starts a fresh 16)", "grp sub")
    b += group(70, 100, 860, 300, "Critique / revise: up to 2 rounds (a quality loop, not a failure loop)", "grp")
    b += group(100, 146, 800, 220, "JSON / zod repair: up to 2 repairs (sends the exact error back to the model)", "grp sub")
    b += group(130, 192, 740, 140, "HTTP to MiniMax: 3 retries · random growing delays · 90s timeout", "grp")
    b += box(400, 236, 200, 60, "1 LLM call", "", "ai")
    b += text(20, 470, "Not retryable (marked failed, message deleted): URL outside the allow-list, document too big, budget exhausted.", "note")
    b += text(20, 490, "Content failure (QualityGate / StructuredOutput / UnsafeOutput): checkpoint deleted → the retry regenerates.  Infrastructure failure: resumes from the checkpoint.", "note")
    b += text(20, 510, "Safety net: the sweeper (every 5 min) re-queues a lost queued quiz and marks a stuck generating one (>20 min) as failed.", "note")
    return svg(1000, 530, b, "Retry layers: each one is bounded, and the global budget stops them from multiplying")


def cicd():
    b = ""
    b += group(10, 10, 1160, 230, "Pull request (never deploys)", "grp")
    gates = [("quality", "typecheck · lint · tests · eval"), ("integration", "real Postgres"), ("migrations", "drift · policy · applies twice"), ("e2e", "Playwright + Chrome"),
             ("docker-build", "build + Trivy"), ("terraform-validate", "fmt · validate · Trivy"), ("secrets-scan", "gitleaks"), ("promptfoo", "guard + prompt rules, 72 tests"), ("terraform-plan", "plan on the PR (informational)")]
    for i, (n, s) in enumerate(gates):
        x = 30 + (i % 5) * 226; y = 48 + (i // 5) * 88
        b += box(x, y, 206, 66, n, s, "ci", small=True)
    b += box(30, 252 - 0, 0, 0, "", "", "ci") if False else ""
    b += group(10, 270, 1160, 240, "merge to main (ruleset: PR + 8 required checks + linear history + no bypass) → pipeline runs again", "grp")
    b += box(30, 318, 230, 66, "the same 8 gates", "", "ci", small=True)
    b += box(290, 318, 230, 66, "llm-eval (real model gate)", "golden set + promptfoo live", "ai", small=True)
    b += box(550, 318, 190, 66, "human approval", "environment: production", "sec", small=True)
    b += arrow(260, 351, 290, 351); b += arrow(520, 351, 550, 351)
    steps = [("build arm64", "ECR · tag = git sha"), ("drift check", "plan -refresh-only"), ("migration", "Fargate task BEFORE the code"), ("terraform apply", "rolling + circuit breaker"), ("smoke test", "through CloudFront · 7 asserts")]
    for i, (n, s) in enumerate(steps):
        x = 30 + i * 226
        b += box(x, 428, 206, 60, n, s, "compute", small=True)
        if i: b += arrow(x - 20, 458, x, 458)
    b += arrow(645, 384, 645, 408, "")
    b += path("M645 408 L 130 408 L 130 428", "", 0, 0)
    b += text(750, 345, "deploy: needs all 9 jobs · push to main only", "note")
    b += text(750, 365, "AWS deploy role: only environment `production` (main only)", "note")
    return svg(1180, 520, b, "CI/CD: what runs at each stage and what blocks the deploy")


def state_diagram():
    b = ""
    b += box(30, 130, 250, 100, "infra/bootstrap", "state bucket · ECR · OIDC roles", "ci")
    b += box(30, 250, 250, 100, "infra/terraform  (prod)", "VPC · RDS · ECS · SQS · Cognito…", "compute")
    b += box(30, 10, 250, 100, "infra/github", "ruleset · environments · variables", "mgd")
    b += group(380, 20, 360, 340, "S3  quizforge-tfstate-<account-id>-us-east-2", "grp mgd")
    b += text(396, 62, "quizforge/bootstrap/terraform.tfstate   (7 versions)", "note")
    b += text(396, 86, "quizforge/github/terraform.tfstate      (3 versions)", "note")
    b += text(396, 110, "quizforge/prod/terraform.tfstate        (50+ versions)", "note")
    b += text(396, 150, "<key>.tflock  → native lock (use_lockfile): S3", "note")
    b += text(396, 168, "conditional write; no DynamoDB", "note")
    b += text(396, 208, "Versioning: history to roll back the state", "note")
    b += text(396, 228, "SSE-KMS with its own key (yearly rotation)", "note")
    b += text(396, 248, "TLS only · Block Public Access · prevent_destroy", "note")
    b += text(396, 268, "Lifecycle: old versions expire after 90 days", "note")
    b += box(820, 40, 190, 70, "role plan (OIDC)", "read + lock · PRs and branches", "ci", small=True)
    b += box(820, 150, 190, 70, "role deploy (OIDC)", "read/write · main + production only", "sec", small=True)
    b += box(820, 260, 190, 70, "you (SSO / IAM)", "local terraform + scripts", "ext", small=True)
    b += arrow(280, 180, 380, 180, "backend s3")
    b += arrow(280, 300, 380, 280)
    b += arrow(280, 60, 380, 90)
    b += arrow(820, 75, 740, 100); b += arrow(820, 185, 740, 190); b += arrow(820, 295, 740, 270)
    return svg(1040, 380, b, "Terraform: 3 independent stacks, one state bucket, native locking")


def pause_diagram():
    b = ""
    b += group(30, 60, 340, 200, "RUNNING  (~$5 / day)", "grp")
    for i, t in enumerate(["web ×2 · api ×2 · worker ×1 · scorer ×1", "RDS available", "NAT Gateway + Elastic IP", "sweeper ENABLED", "ALB · WAF · CloudFront · KMS · secrets"]):
        b += text(50, 100 + i * 28, "• " + t, "note")
    b += group(530, 60, 340, 200, "PAUSED  (~$8 / month)", "grp mgd")
    for i, t in enumerate(["web/api/worker/scorer = 0 tasks", "RDS stopped (data preserved)", "NAT, Elastic IP, load balancer, WAF removed", "sweeper DISABLED", "CloudFront · KMS · secrets · RDS storage stay"]):
        b += text(550, 100 + i * 28, "• " + t, "note")
    b += arrow(372, 120, 528, 120, "pause.sh", lx=450, ly=110)
    b += arrow(528, 210, 372, 210, "resume.sh (~10 min)", lx=450, ly=232)
    b += text(30, 300, "The repository variable PAUSED keeps the pipeline consistent: with PAUSED=true the deploy refuses to run.", "note")
    b += text(30, 320, "AWS restarts a stopped RDS after 7 days: if you stay paused longer, run pause.sh again. Resume recreates the load balancer and WAF (~15 min).", "note")
    return svg(900, 342, b, "Pause and resume: reversible, no data lost")


def judge_chart():
    return bar_chart(760, 270, {"MiniMax-M3 as judge": [0.86, 0.86, 0.93, 0.86, 0.45], "MiniMax-M2.7 as judge": [0.84, 0.89, 0.84, 0.89, 0.84]},
                     "Same quiz, 5 judgements: the other model is noisier (outlier 0.45), so we take the median of 3 and gate on the dataset mean", labels=["1", "2", "3", "4", "5"])


def eval_chart():
    return bar_chart(900, 290, {"diversity": [0.84, 0.80, 0.71, 0.75, 0.92], "relevance": [0.31, 0.35, 0.32, 0.35, 0.35], "coverage": [1.0, 0.6, 1.0, 0.83, 0.67], "judge": [0.82, 0.82, 0.77, 0.91, 0.82]},
                     "Golden set (real run, M3 judge): metrics per document. Thresholds: diversity ≥0.25 · relevance ≥0.15 · coverage ≥0.5 · mean judge ≥0.70",
                     labels=["portuguese", "short-doc", "injection", "pipecat", "mastra"])


def cost_chart():
    return bar_chart(720, 250, {"running": [79, 20, 35, 15, 10], "paused": [0, 0, 0, 2.5, 5]}, "$ per month per item: what pausing removes", ymax=90,
                     labels=["Fargate", "ALB", "NAT", "RDS", "other"])


def seq_catalog():
    lanes = [("Browser", "", "ext"), ("web (BFF)", "", "compute"), ("api", "", "compute")]
    steps = [
        ("Browser", "web (BFF)", "open the form → GET /bff/v1/catalog", False),
        ("web (BFF)", "api", "GET /v1/catalog (Bearer token)", False),
        ("api", "web (BFF)", "13 documents: 6 real READMEs + 7 test documents", True),
        ("web (BFF)", "Browser", "the browser validates the list with zod, fills the dropdown", True),
        ("Browser", "Browser", "user picks a document: its description shows under the dropdown", False),
        ("Browser", "web (BFF)", "POST /quizzes {sourceUrl taken from the catalog entry}", False),
        ("web (BFF)", "api", "same body, checked by the same schema, then the API checks the URL again", False),
    ]
    return seq(980, 420, lanes, steps, "Choosing a document: no URL to copy and paste")


def validation_layers():
    b = ""
    b += box(380, 10, 420, 46, "@quizforge/core/schemas", "one file of zod schemas, imported by all three", "mgd")
    cols = [("Browser form", "same schema as the API", "ext", 20), ("BFF (Next.js server)", "POST /quizzes, PUT answers", "compute", 330), ("API (Fastify)", "the only trusted check", "compute", 640), ("PostgreSQL", "last line of defense", "data", 950)]
    for name, sub, kind, x in cols:
        w = 210
        b += box(x, 120, w, 70, name, sub, kind)
        if kind != "data":
            b += arrow(590, 56, x + w / 2, 120, dash=True)
    for i in range(3):
        x = cols[i][3] + 210
        b += arrow(x, 140, cols[i + 1][3], 140, "request", lx=(x + cols[i + 1][3]) / 2, ly=130)
    for i in range(3):
        x = cols[i][3] + 210
        b += arrow(cols[i + 1][3], 175, x, 175, "response" if i < 2 else "", dash=True, lx=(x + cols[i + 1][3]) / 2, ly=190)
    rows = [
        ("Browser form", 20, ["Rejects at once, with a clear message:", "· topic shorter than 2 characters", "· number of questions outside 5–8", "· a URL that is not a URL", "Then validates EVERY response:", "an unexpected shape → \"unexpected response\""]),
        ("BFF", 330, ["Rejects before the API is called:", "· a body that is not JSON", "· unknown or out-of-range fields", "· answer ids that are not UUIDs", "Same error shape as the API (400)"]),
        ("API", 640, ["Authoritative checks:", "· zod body, params and headers", "· JWT, ownership, SSRF allow-list", "· Idempotency-Key and its body hash", "CI: contract tests check every response"]),
        ("PostgreSQL", 950, ["Cannot be bypassed:", "· CHECK 5–8 questions, score 0–4", "· UNIQUE keys, partial unique index", "· foreign keys, FOR UPDATE", ""]),
    ]
    for _, x, lines in rows:
        for i, ln in enumerate(lines):
            b += text(x, 232 + i * 19, ln, "note")
    return svg(1180, 360, b, "Where the JSON of a call is validated")


def quality_pipeline():
    b = ""
    b += box(20, 60, 190, 70, "Production scorer", "judges every saved quiz", "ai")
    b += box(20, 190, 190, 70, "Evals (CI + experiments)", "golden set, 9 variants", "ci")
    b += box(280, 100, 220, 110, "scoreQuiz()", "ONE function · quality.ts", "sec")
    b += text(390, 196, "grounded · lint · diversity · relevance", "note", "middle")
    b += arrow(210, 95, 280, 140)
    b += arrow(210, 225, 280, 175)
    b += box(580, 20, 250, 56, "Langfuse scores", "same names on every trace", "ext")
    b += box(580, 100, 250, 56, "Postgres eval_scores", "per quiz, for queries", "data")
    b += box(580, 180, 250, 56, "CloudWatch metric", "QuizQuality (one value per quiz)", "mgd")
    for y in (48, 128, 208):
        b += arrow(500, 155, 580, y)
    b += box(900, 180, 250, 56, "3 quality alarms", "hourly average · single quiz · judge down", "sec")
    b += arrow(830, 208, 900, 208)
    b += box(900, 270, 250, 56, "SNS topic", "encrypted with its own KMS key", "mgd")
    b += arrow(1025, 236, 1025, 270)
    b += box(580, 270, 250, 56, "E-mail", "ALARM_EMAIL: set; confirm after deploy", "edge")
    b += arrow(900, 298, 830, 298)
    b += text(20, 360, "Langfuse alerts are not used (Slack / webhook only, no e-mail): all alarms live in CloudWatch.", "note")
    b += text(20, 380, "quality_overall is left out (never faked) when the judge fails twice; a separate alarm watches for that.", "note")
    return svg(1180, 400, b, "Every production quiz is scored by the same function the evals use, and low scores alert")


def langfuse_eval_flow():
    b = ""
    b += box(20, 70, 190, 70, "Observation", "a step with input + output", "ext")
    b += text(115, 160, "here: README in, quiz out", "note", "middle")
    b += box(270, 50, 210, 110, "Evaluation rule", "which observations (filter)", "mgd")
    b += text(375, 130, "how many (sampling)", "note", "middle")
    b += text(375, 148, "which field fills which variable", "note", "middle")
    b += box(540, 70, 210, 70, "Evaluator", "judge prompt + output type", "sec")
    b += box(810, 70, 170, 70, "LLM connection", "provider · URL · key · model", "edge")
    b += box(540, 200, 210, 70, "Score", "numeric 1–5 + reasoning", "data")
    b += arrow(210, 105, 270, 105)
    b += arrow(480, 105, 540, 105)
    b += arrow(750, 105, 810, 105, "calls")
    b += arrow(645, 140, 645, 200)
    b += text(20, 320, "The result is a Langfuse score on the observation. It runs in Langfuse's workers, not in ours: no latency in the worker.", "note")
    return svg(1000, 345, b, "How a Langfuse (LLM-as-a-judge) evaluator works")


def minimax_structured():
    b = ""
    b += box(20, 20, 200, 60, "Langfuse asks for", "structured output (JSON)", "edge")
    b += box(300, 20, 200, 60, "MiniMax-M3", "reasoning model", "ai")
    b += arrow(220, 50, 300, 50)
    b += box(580, 0, 400, 56, "tool call → valid JSON", "works, but Langfuse does not use it", "data", small=True)
    b += box(580, 70, 400, 56, "response_format (json_schema / json_object)", "answer starts with <think>…", "sec", small=True)
    b += arrow(500, 40, 580, 28)
    b += arrow(500, 60, 580, 98)
    b += box(580, 150, 400, 56, "Langfuse cannot parse it", "evaluator paused: EVAL_MODEL_CONFIG_INVALID", "sec")
    b += arrow(780, 126, 780, 150)
    b += text(20, 240, "Our own code strips <think> and asks the model to repair its JSON, so the in-code judge works. Langfuse has no such step.", "note")
    return svg(1000, 262, b, "Why the MiniMax judge cannot run inside Langfuse today")


def judge_time_chart():
    # measured in 13 real Langfuse traces: quiz-generation span minus the LangGraph span = judge + scoring
    graph = [10.9, 38.8, 27.9, 35.2, 13.1, 33.0, 28.4, 61.1, 26.9, 14.5, 16.7, 23.1, 10.4]
    judge = [18.6, 17.9, 18.1, 18.3, 13.1, 22.4, 15.1, 15.7, 21.0, 32.7, 32.3, 14.8, 27.5]
    return bar_chart(980, 300, {"generation (the graph)": graph, "judge + scoring": judge},
                     "Seconds per generation, 13 real traces: the judge adds 13–33 s before the quiz is ready", ymax=90, labels=[str(i + 1) for i in range(13)])


def scoring_flows():
    b = ""
    def row(y, label, boxes, gx=200, gw=640, color="grp"):
        out = group(gx, y, gw, 88, label, color)
        x = gx + 14
        for i, (w, title, sub, kind) in enumerate(boxes):
            out += box(x, y + 36, w, 40, title, sub, kind, small=True)
            if i: out += arrow(x - 14, y + 56, x, y + 56)
            x += w + 14
        return out
    b += text(20, 22, "BEFORE: everything in one worker, one message", "t")
    b += box(20, 52, 150, 56, "Queue", "generation", "data", small=True)
    b += arrow(170, 80, 200, 80)
    b += row(34, "worker: the quiz is ready only after the judge", [(130, "fetch + graph", "~27 s", "ai"), (250, "judge ×3 + scoring", "~18 s (13–33)", "sec"), (140, "save: ready", "", "data"), (142, "delete message", "", "mgd")], gw=760)
    b += text(20, 160, "NOW (implemented): generation and scoring are separate jobs", "t")
    b += box(20, 188, 150, 56, "Queue", "generation", "data", small=True)
    b += arrow(170, 216, 200, 216)
    b += row(170, "worker (generation)", [(130, "fetch + graph", "~27 s", "ai"), (170, "graph checks", "keep grounded ones", "compute"), (130, "save: READY", "", "data"), (132, "send score job", "", "mgd")])
    b += box(20, 310, 150, 56, "Queue", "scoring + its own DLQ", "data", small=True)
    b += arrow(170, 338, 200, 338)
    b += row(292, "scorer (separate service, same image)", [(160, "load quiz + document", "from Postgres", "data"), (140, "judge ×3", "MiniMax-M3", "sec"), (110, "scores", "", "compute"), (132, "delete message", "", "mgd")])
    b += path("M766 258 C 766 280, 95 270, 95 310", "", 0, 0, dash=True)
    b += text(430, 276, "score job", "note", "middle")
    b += box(870, 188, 290, 56, "Langfuse · Postgres · CloudWatch", "scores written by the scorer", "ext", small=True)
    b += path("M806 344 C 840 344, 850 230, 940 246", "", 0, 0, dash=True)
    b += box(870, 310, 290, 56, "sweeper (already exists)", "re-queues ready quizzes with no score", "compute", small=True)
    b += text(1015, 384, "…into the scoring queue", "note", "middle")
    return svg(1180, 400, b, "Before vs now: the user gets the quiz about 18 s earlier, and scoring has its own queue and service")


def narrow(x1, y1, x2, y2, n, dash=False, both=False):
    """An arrow with a numbered badge in the middle: the number is the row of the protocol table below the diagram."""
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    return arrow(x1, y1, x2, y2, dash=dash, both=both) + f'<circle cx="{mx}" cy="{my}" r="10" class="badge-c"/><text x="{mx}" y="{my + 4}" text-anchor="middle" class="badge-t">{n}</text>'


def comm_map():
    b = ""
    b += box(20, 300, 130, 60, "Browser", "React app", "ext")
    b += box(190, 300, 170, 60, "CloudFront → ALB", "edge + load balancer", "edge")
    b += box(400, 150, 160, 60, "web (BFF)", "Next.js server", "compute")
    b += box(400, 330, 160, 60, "api", "Fastify REST", "compute")
    b += box(190, 40, 170, 56, "Cognito", "sign-in + JWKS", "sec")
    b += box(640, 330, 140, 50, "SQS: jobs", "generation queue", "data", small=True)
    b += box(850, 330, 140, 60, "worker", "generates", "ai")
    b += box(850, 470, 140, 50, "SQS: scoring", "scoring queue", "data", small=True)
    b += box(850, 580, 140, 60, "scorer", "judges", "ai")
    b += box(400, 560, 380, 50, "PostgreSQL (RDS)", "the shared state: quizzes, questions, scores, checkpoints", "data")
    b += box(1050, 290, 120, 50, "GitHub raw", "the README", "ext", small=True)
    b += box(1050, 370, 120, 50, "MiniMax", "the LLM", "ext", small=True)
    b += box(1050, 450, 120, 50, "Langfuse", "traces + scores", "ext", small=True)
    b += box(1050, 530, 120, 50, "CloudWatch", "logs + metrics", "mgd", small=True)
    b += box(850, 40, 150, 56, "GitHub Actions", "llm-eval (CI)", "ci")
    b += narrow(150, 330, 190, 330, 1)
    b += narrow(360, 322, 400, 182, 3)
    b += narrow(360, 340, 400, 360, 3)
    b += narrow(480, 210, 480, 330, 4)
    b += narrow(150, 310, 190, 80, 5, dash=True)
    b += narrow(400, 165, 360, 70, 5, dash=True)
    b += narrow(420, 330, 360, 90, 6, dash=True)
    b += narrow(560, 355, 640, 355, 7)
    b += narrow(780, 355, 850, 355, 8, dash=True)
    b += narrow(920, 390, 920, 470, 9)
    b += narrow(920, 520, 920, 580, 10, dash=True)
    b += narrow(480, 390, 480, 560, 11, both=True)
    b += narrow(850, 380, 780, 565, 11, both=True)
    b += narrow(900, 640, 780, 600, 11, both=True)
    b += narrow(990, 345, 1050, 315, 12)
    b += narrow(990, 360, 1050, 395, 13)
    b += narrow(990, 375, 1050, 470, 14)
    b += narrow(990, 595, 1050, 410, 13)
    b += narrow(990, 612, 1050, 490, 14)
    b += narrow(990, 640, 1085, 580, 15, dash=True)
    b += narrow(1000, 80, 1090, 370, 16, dash=True)
    b += text(20, 400, "api, worker and scorer never call each other: only queues and Postgres", "note")
    b += text(20, 418, "pass ids through the queues, and share the database.", "note")
    b += text(20, 450, "Dashed = pull or redirect.  Number = row of the table below.", "note")
    return svg(1180, 660, b, "Who talks to whom: every connection of the system, numbered")


def seq_login():
    lanes = [("Browser", "", "ext"), ("web (BFF)", "Next.js server", "compute"), ("Cognito", "sign-in", "sec"), ("api", "Fastify", "compute")]
    steps = [
        ("Browser", "web (BFF)", "GET /auth/login", False),
        ("web (BFF)", "Browser", "302 to Cognito Hosted UI (PKCE code_challenge)", True),
        ("Browser", "Cognito", "the user signs in (HTTPS)", False),
        ("Cognito", "Browser", "302 to /auth/callback?code=…", True),
        ("Browser", "web (BFF)", "GET /auth/callback?code=…", False),
        ("web (BFF)", "Cognito", "POST /oauth2/token (code + code_verifier + client secret)", False),
        ("Cognito", "web (BFF)", "access token + refresh token (JSON)", True),
        ("web (BFF)", "Browser", "Set-Cookie qf_at, qf_rt (httpOnly, Secure, SameSite)", True),
        ("Browser", "web (BFF)", "fetch /bff/v1/quizzes (cookie, Origin, X-Requested-With, Idempotency-Key)", False),
        ("web (BFF)", "api", "HTTP + Authorization: Bearer <access token>", False),
        ("api", "Cognito", "JWKS (cached): verify signature, iss, exp, client_id", True),
        ("api", "web (BFF)", "JSON response (202 + the quiz)", True),
        ("web (BFF)", "Browser", "same status and body (the browser never saw a token)", True),
    ]
    return seq(1180, 660, lanes, steps, "Front end and back end: sign-in and one API call, protocol by protocol")


def comm_llm():
    b = ""
    b += box(10, 20, 140, 66, "worker / scorer", "our code", "ai")
    b += box(170, 20, 150, 66, "guardLlm", "validates every call", "sec")
    b += box(340, 20, 150, 66, "LlmClient", "LangChain ChatOpenAI", "compute")
    b += box(510, 20, 190, 66, "HTTPS POST", "/v1/chat/completions", "edge")
    b += box(720, 20, 140, 66, "MiniMax", "M2.7 · M3", "ext")
    b += arrow(150, 53, 170, 53); b += arrow(320, 53, 340, 53); b += arrow(490, 53, 510, 53); b += arrow(700, 53, 720, 53)
    b += text(10, 112, "guardLlm: strict message schema, size limit, and the input inspection (hidden or encoded text) on everything that is not the system prompt.", "note")
    b += text(10, 132, "OpenAI protocol · 90 s timeout · 3 retries (4 attempts), growing random delays", "note")
    b += box(10, 160, 150, 56, "raw text", "<think>…</think> + JSON", "sec", small=True)
    b += box(190, 160, 160, 56, "extract", "drop think, find JSON", "compute", small=True)
    b += box(380, 160, 190, 56, "validate (zod)", "schema of the quiz / the judge", "compute", small=True)
    b += box(600, 160, 150, 56, "typed value", "or a loud error", "data", small=True)
    b += arrow(160, 188, 190, 188); b += arrow(350, 188, 380, 188); b += arrow(570, 188, 600, 188, "valid", ly=180)
    b += box(380, 256, 190, 56, "repair (≤ 2×; judge ≤ 1×)", "send the exact errors back", "ai", small=True)
    b += arrow(430, 216, 430, 256, "invalid", lx=400, ly=240, anchor="end")
    b += arrow(520, 256, 520, 216, "fixed text", lx=550, ly=240, anchor="start")
    b += text(10, 342, "Why the extra steps: MiniMax's reasoning models ignore response_format and write <think> first,", "note")
    b += text(10, 362, "so valid JSON is guaranteed by our code, not by the provider.", "note")
    return svg(880, 386, b, "The LLM call: protocol and the steps that make the answer trustworthy")


def comm_eval():
    b = ""
    b += group(10, 10, 580, 140, "CI: llm-eval (every merge to main) and the nightly run", "grp")
    b += box(26, 52, 130, 56, "runner", "ubuntu, pnpm", "ci", small=True)
    b += box(176, 52, 200, 56, "production code", "generateQuiz + scoreQuiz", "ai", small=True)
    b += box(396, 52, 180, 56, "gate", "exit 1 blocks the deploy", "sec", small=True)
    b += arrow(156, 80, 176, 80); b += arrow(376, 80, 396, 80)
    b += group(10, 180, 580, 140, "CI: e2e (every PR) - only local services", "grp")
    b += box(26, 222, 130, 56, "Playwright", "real Chrome", "ci", small=True)
    b += box(176, 222, 200, 56, "4 local services", "web, api, worker, scorer", "compute", small=True)
    b += box(396, 222, 180, 56, "Postgres + ElasticMQ", "local SQS API (HTTP)", "data", small=True)
    b += arrow(156, 250, 176, 250); b += arrow(376, 250, 396, 250)
    b += group(10, 350, 580, 140, "Manual: compare structures and prompts", "grp")
    b += box(26, 392, 130, 56, "compare.ts", "9 variants × 5 docs", "ci", small=True)
    b += box(176, 392, 200, 56, "local embeddings", "ONNX, offline after 1st run", "mgd", small=True)
    b += box(396, 392, 180, 56, "HTML report", "docs/eval + artifact", "data", small=True)
    b += arrow(156, 420, 176, 420); b += arrow(376, 420, 396, 420)
    b += box(710, 70, 230, 60, "Langfuse", "datasets · runs · scores", "ext", small=True)
    b += box(710, 250, 230, 60, "MiniMax", "generator M2.7 + judge M3", "ext", small=True)
    b += box(710, 420, 230, 60, "Hugging Face hub", "model download, once", "ext", small=True)
    b += narrow(590, 70, 710, 100, 2)
    b += narrow(590, 110, 710, 280, 1)
    b += narrow(590, 400, 710, 290, 1)
    b += narrow(590, 445, 710, 450, 3, dash=True)
    b += text(10, 515, "1 = HTTPS, OpenAI protocol (same client as production).", "note")
    b += text(10, 535, "2 = REST (datasets, items, experiment runs) + OTLP spans + scores.", "note")
    b += text(10, 555, "3 = HTTPS download of the embedding model, cached by the workflow.", "note")
    return svg(960, 575, b, "How the evaluation runs talk to the rest")


def life_of_quiz():
    """One picture of the whole product: what the user waits for and what happens afterwards."""
    b = ""
    steps = [
        (10, "1 · Pick a document", "dropdown + validation", "ext", "instant"),
        (190, "2 · API accepts", "202 + job queued", "compute", "< 1 s"),
        (370, "3 · Worker generates", "LangGraph + checks", "ai", "~27 s"),
        (550, "4 · Quiz is READY", "saved, no scores yet", "data", "user can start"),
        (730, "5 · Scorer judges", "own queue, judge ×3", "ai", "~18 s later"),
        (910, "6 · Quality score", "Langfuse · CloudWatch", "sec", "no one waits"),
    ]
    for x, t, sub, kind, when in steps:
        b += box(x, 56, 160, 66, t, sub, kind, small=True)
        b += text(x + 80, 144, when, "note", "middle")
    for x in (170, 350, 530, 710, 890):
        b += arrow(x, 89, x + 20, 89)
    b += group(10, 28, 520, 130, "The user waits here", "grp")
    b += group(550, 28, 520, 130, "The user can answer now; scoring runs in the background", "grp mgd")
    b += text(10, 190, "Where it runs: step 1 in the browser · 2 in the api · 3 in the worker (SQS jobs queue) · 5 in the scorer (SQS scoring queue) · 6 in AWS and Langfuse.", "note")
    b += text(10, 210, "api, worker and scorer never call each other: they only share Postgres and the two queues. If any step dies, the queue delivers the message again.", "note")
    return svg(1090, 232, b, "The life of a quiz: what the user waits for, and what happens after")


def input_defense():
    """Every door between a user's text and the model, and between the model and the database."""
    b = ""
    b += text(10, 22, "1. The request (browser to queue)", "t")
    row1 = [
        (10, "Browser form", "zod + topic guard", "ext"),
        (285, "BFF (Next.js)", "same zod schemas", "compute"),
        (560, "API (Fastify)", "strict zod · topic guard · URL list", "compute"),
        (835, "SQS jobs queue", "ids only, never text", "data"),
    ]
    for x, t, sub, kind in row1:
        b += box(x, 36, 240, 60, t, sub, kind, small=True)
    for x in (250, 525, 800):
        b += arrow(x, 66, x + 35, 66)
    b += text(10, 140, "2. The document (worker, before any model call)", "t")
    row2 = [
        (10, "Fetch README", "https · allow-list", "sec"),
        (172, "Guard + 49 rules", "hidden/encoded → reject", "sec"),
        (334, "Language", "en · pt · es only", "sec"),
        (496, "Detector (optional)", "English only · flag", "mgd"),
        (658, "Strict input", "zod · size · topic", "sec"),
        (820, "guardLlm", "every call · 16k cap", "sec"),
        (982, "MiniMax", "data in <document>", "ai"),
    ]
    for x, t, sub, kind in row2:
        b += box(x, 154, 140, 66, t, sub, kind, small=True)
    for x in (150, 312, 474, 636, 798, 960):
        b += arrow(x, 187, x + 22, 187)
    b += box(10, 262, 790, 50, "Rejected at any of these doors = quiz failed with a clear message", "guard · language · detector (block) · guardLlm: metric DocumentRejected, model never called, no job-failure alarm", "edge", small=True)
    for x in (80, 242, 404, 566, 728):
        b += arrow(x, 220, x, 262, dash=True)
    b += text(10, 344, "3. The reply (worker, before anything is saved)", "t")
    row3 = [
        (10, "Reply format", "JSON only, no markers", "sec"),
        (172, "Zod shape", "4 options · indexes", "sec"),
        (334, "Prompt leak", "8-word runs of ours", "sec"),
        (496, "Markup · links", "none that are new", "sec"),
        (658, "Echoed attack", "45 rules, not in doc", "sec"),
        (820, "Looks like a quiz", "≥70% questions", "sec"),
        (982, "Quote exists", "then SAVED", "data"),
    ]
    for x, t, sub, kind in row3:
        b += box(x, 358, 140, 66, t, sub, kind, small=True)
    for x in (150, 312, 474, 636, 798, 960):
        b += arrow(x, 391, x + 22, 391)
    b += box(10, 466, 790, 50, "A problem = a repair round with the exact error (up to 2); still wrong = the job retries from scratch", "no second model: all of this is code (milliseconds)", "edge", small=True)
    for x in (80, 242, 404, 566, 728):
        b += arrow(x, 424, x, 466, dash=True)
    b += text(10, 546, "The worker saves the SANITIZED text, so the scorer reads exactly what the model read. The judge goes through the same guardLlm door.", "note")
    return svg(1140, 568, b, "Every door between a user's text and the model, and between the model and the database")


def promptfoo_flow():
    b = ""
    lanes = [
        (14, "Every pull request", "promptfoo OFFLINE · 72 tests", "no model, no secrets, ~1 minute", "ci", "required to merge"),
        (110, "Merge to main", "promptfoo LIVE · 21 tests", "real MiniMax, inside llm-eval", "ai", "blocks the deploy"),
        (206, "Every night + on demand", "promptfoo LIVE · 21 tests", "catches provider or model drift", "mgd", "opens a red run"),
    ]
    for y, when, what, note, kind, gate in lanes:
        b += box(10, y, 190, 70, when, "", "ext", small=True)
        b += arrow(200, y + 35, 240, y + 35)
        b += box(240, y, 280, 70, what, note, kind, small=True)
        b += arrow(520, y + 35, 560, y + 35)
        b += box(560, y, 200, 70, "Exit code 100 if any fails", gate, "sec", small=True)
    b += text(790, 30, "Offline proves what happens BEFORE, AROUND and AFTER the model:", "note")
    b += text(790, 50, "· hidden or encoded text never reaches it", "note")
    b += text(790, 68, "· bad topics and other languages never reach it", "note")
    b += text(790, 86, "· plain instructions arrive sanitized, in tags", "note")
    b += text(790, 104, "· the prompts keep their safety rules", "note")
    b += text(790, 140, "Live proves the MODEL does not obey:", "note")
    b += text(790, 160, "· plain instructions in 7 languages, 9 places", "note")
    b += text(790, 178, "· requests for a poem, a joke, physics, prices", "note")
    b += text(790, 196, "· a clean document still gives a normal quiz", "note")
    b += text(10, 300, "The attack corpus is ONE file (packages/core/src/attacks.ts): vitest and promptfoo test the same attacks.", "note")
    return svg(1160, 322, b, "promptfoo in the pipeline: what runs when, and what it blocks")


def pipeline_overview():
    """The whole pipeline over time: pull request, main, always-on. Where promptfoo runs and where Langfuse gets data."""
    b = ""
    # lane titles
    b += text(10, 24, "1 · Pull request: nothing reaches AWS, nothing is deployed", "t")
    b += box(10, 40, 130, 96, "push a branch", "open a PR", "ext", small=True)
    b += box(170, 40, 460, 96, "", "", "ci", small=True)
    b += text(400, 62, "9 jobs in parallel (no secrets)", "t-s", "middle")
    b += text(400, 86, "quality (typecheck, lint, tests, offline eval) · integration · migrations", "note", "middle")
    b += text(400, 104, "e2e · docker-build · terraform-validate · secrets-scan", "note", "middle")
    b += text(400, 122, "terraform-plan · promptfoo OFFLINE (72 tests)", "note", "middle")
    b += box(660, 40, 190, 96, "8 required checks", "green + linear history", "sec", small=True)
    b += box(880, 40, 130, 96, "squash merge", "no bypass", "data", small=True)
    for x1, x2 in ((140, 170), (630, 660), (850, 880)):
        b += arrow(x1, 88, x2, 88)

    b += text(10, 164, "2 · Merge to main: the same jobs, plus the real model, then a human decides", "t")
    b += box(10, 180, 150, 70, "same 8 jobs", "on the merged code", "ci", small=True)
    b += box(190, 180, 230, 70, "llm-eval (real MiniMax)", "golden set + promptfoo LIVE (21)", "ai", small=True)
    b += box(450, 180, 170, 70, "human approval", "environment: production", "sec", small=True)
    b += box(650, 180, 520, 70, "deploy", "build ARM64 → drift check → migrate → apply → smoke test · refused while PAUSED=true", "compute", small=True)
    for x1, x2 in ((160, 190), (420, 450), (620, 650)):
        b += arrow(x1, 215, x2, 215)
    b += box(190, 270, 230, 46, "Langfuse: experiment run", "dataset quizforge-golden · scores", "ext", small=True)
    b += arrow(305, 250, 305, 270, dash=True)

    b += text(10, 350, "3 · Always on: nobody has to push", "t")
    b += box(10, 366, 280, 70, "nightly eval.yml (05:43 UTC)", "golden set + promptfoo LIVE: model or provider drift", "ai", small=True)
    b += box(310, 366, 250, 70, "nightly drift.yml (06:17 UTC)", "terraform vs the real account → issue", "ci", small=True)
    b += box(580, 366, 280, 70, "manual: compare structures", "9 variants × 5 documents → HTML report", "mgd", small=True)
    b += box(880, 366, 290, 70, "production, every quiz", "worker + scorer → traces and scores", "data", small=True)
    b += box(10, 456, 280, 46, "Langfuse: experiment run", "", "ext", small=True)
    b += box(580, 456, 280, 46, "Langfuse: 9 experiments", "docs/eval report links to them", "ext", small=True)
    b += box(880, 456, 290, 46, "Langfuse + CloudWatch", "traces, scores, QuizQuality, alarms", "ext", small=True)
    for x in (150, 720, 1025):
        b += arrow(x, 436, x, 456, dash=True)
    b += text(10, 530, "Langfuse receives data in 4 places only: llm-eval on main, the nightly eval, the manual comparison, and production. A pull request never talks to it.", "note")
    b += text(10, 550, "promptfoo runs in 3: OFFLINE on every PR and main (72 tests, required), LIVE inside llm-eval on main (blocks the deploy) and in the nightly run.", "note")
    return svg(1180, 572, b, "The whole pipeline over time: where promptfoo runs and where Langfuse gets data")
