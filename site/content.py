"""The short architecture report, for the presentation: only what is essential, in the order it would be explained.
The long reference report (every detail, bugs, runbook, protocols...) is content_full.py, built with `build.py --full`."""
import json
from pathlib import Path

import diagrams as d
from lib import callout, link, table

HERE = Path(__file__).parent
L = json.loads((HERE.parent / ".local/links.json").read_text())
GH = "https://github.com/jhgcc1/quizforge"
LF = "https://us.cloud.langfuse.com/project/cmuyh1njb00yxad0j2ixxfwnq"
APP = L["app"]


def sec(id_, title, body, lead=""):
    return f'<section id="{id_}"><h2>{title}</h2>{f"<p class=lead>{lead}</p>" if lead else ""}{body}</section>'


def img(name, cap):
    return f'<figure class="shot"><img src="img/{name}" alt="{cap}" loading="lazy"><figcaption>{cap}</figcaption></figure>'


def overview():
    cards = [("4 + 1", "services (web, api, worker, scorer) and a sweeper"), ("5–8", "questions per quiz, 4 options each"), ("8", "layers of guardrails"),
             ("10", "CI jobs on a pull request, 8 required"), ("500+", "automated tests, 100+ on prompt safety"), ("~$0.01", "per quiz, measured")]
    c = "".join(f'<div class="card"><div class="num">{n}</div><div>{t}</div></div>' for n, t in cards)
    body = f'<div class="cards">{c}</div>'
    body += "<p>QuizForge is an AI agent that reads a Markdown README (a URL), writes a 5–8 question multiple-choice quiz, lets a user take it in a web app and computes a weighted score. It runs on AWS, is built with Terraform and deployed by GitHub Actions. Every quiz is traced and scored in Langfuse.</p>"
    body += "<h3>The assignment, and where each part lives</h3>" + table(["Requirement", "Where it is", "Section"], [
        ["Generate a quiz of 5–8 questions with 4 options from a README at a configurable URL", "<code>POST /v1/quizzes {sourceUrl}</code>; an agent (LangGraph) in the <b>worker</b> service", "Agent"],
        ["Run the quiz, correct it, compute the final weighted score (+10% weight per question)", "Web UI (Next.js) and API; the score is plain code: <code>Σ(1.1^(i−1) · score_i) / Σ(1.1^(i−1))</code>", "Score"],
        ["Store questions, answers and the final score in a database", "PostgreSQL: 9 tables, every answer saved at the click", "Data model"],
        ["REST API and web UI", "Fastify (OpenAPI at <code>/docs</code>) and Next.js with a login by Amazon Cognito", "Architecture"],
        ["Production-ready, not a PoC", "Terraform on AWS, autoscaling, retries and a dead-letter queue, alarms, CI/CD with gates, pause and resume", "Architecture · CI/CD · Cost"],
        ["LLM observability and several generation strategies (nice to have)", "Langfuse traces, costs and scores; <code>single-shot</code> and <code>section-map-reduce</code> chosen by a router, plus critique and revise", "Quality · Agent"],
    ], widths=["40%", "46%", "14%"])
    return sec("summary", "What it is", body)


def architecture():
    body = d.architecture()
    body += table(["Piece", "What it does", "Why this choice"], [
        ["<b>CloudFront + WAF</b> → <b>ALB</b>", "The only public entrance: HTTPS, a rate limit of 1000 requests per 5 minutes per IP, managed rules. The load balancer accepts CloudFront only", "No custom domain was available, so the CloudFront address is the app address"],
        ["<b>web</b> (Next.js, 2–6 tasks)", "The pages and a BFF: it keeps the login in an httpOnly cookie and calls the API with the token", "Tokens never reach the browser's JavaScript"],
        ["<b>api</b> (Fastify, 2–6 tasks)", "REST, JWT check, validation, quotas; it only <b>enqueues</b> the generation and answers at once", "Generating takes ~30 s and costs money, so it is asynchronous"],
        ["<b>SQS</b> (+ dead-letter queues)", "Two queues: generation jobs and scoring jobs", "Limits how many model calls run at once; retries; an alarm if a message dies"],
        ["<b>worker</b> (1–4 tasks)", "Runs the agent: fetch the README, generate, check, review, save the quiz", "Scales with the queue, one job per task"],
        ["<b>scorer</b> (1–2 tasks)", "Judges a quiz <b>after</b> it is saved: an LLM judge and fixed checks", "The user does not wait for the judge"],
        ["<b>RDS PostgreSQL</b>", "All data, and the agent's checkpoints", "Idempotency and scoring need real constraints and transactions"],
        ["<b>Cognito</b>", "Users and login (code flow with PKCE), no sign-up", "Standard JWT, no passwords stored by us"],
        ["<b>Langfuse</b> and <b>CloudWatch</b>", "Traces, cost and quality scores; logs, metrics, 18 alarms by e-mail", "Langfuse for the AI, CloudWatch for the platform"],
    ], widths=["24%", "42%", "34%"])
    return sec("architecture", "Architecture", body, "Everything runs in one AWS region (us-east-2), in two zones, created by Terraform.")


def flow():
    body = d.life_of_quiz()
    body += table(["", "Creating a quiz (slow, asynchronous)", "Answering a quiz (fast, synchronous)"], [
        ["Steps", "API validates and saves a <code>queued</code> quiz → SQS → worker generates → quiz is <code>ready</code> → scorer judges it. The browser polls until <code>ready</code>", "Each answer is saved as it is picked → submit computes the score from what is stored → result with the answer key"],
        ["Why it is built this way", "The model is slow, costly and can fail, so it gets a queue, a budget and retries", "No model is involved: it is cheap, exact and instant"],
        ["Safe to repeat?", "Yes: an <code>Idempotency-Key</code> makes a retry return the same quiz", "Yes: answers are upserts guarded by a revision number; submitting twice returns the saved result"],
    ], widths=["16%", "44%", "40%"])
    return sec("flow", "One quiz, end to end", body)


def data():
    body = d.er()
    body += callout("ok", "The requirement", "Questions are in <code>questions</code> and <code>options</code>; the user's answers are in <code>answers</code> and <code>answer_selections</code>; the final score is <code>attempts.final_score</code> and the score of each question is <code>answers.score</code>. Definition: <code>packages/db/src/schema.ts</code>.")
    body += table(["Table", "One row is…", "Relations"], [
        ["<code>sources</code>", "A README, stored once per content (hash)", "1 : N quizzes"],
        ["<code>quizzes</code>", "One request to generate a quiz (owner, status, strategy)", "1 : N generation_jobs, questions, attempts"],
        ["<code>generation_jobs</code>", "One generation run: tokens, cost, trace id", "N : 1 quizzes"],
        ["<code>questions</code> → <code>options</code>", "A question (explanation, source quote) and its 4 options, with <code>is_correct</code>", "quiz 1 : N questions · question 1 : 4 options"],
        ["<code>attempts</code>", "One go at a quiz by one user: status and <code>final_score</code>", "quiz 1 : N attempts"],
        ["<code>answers</code> → <code>answer_selections</code>", "The answer to one question, and one row per option chosen (a real foreign key)", "attempt 1 : N answers · answer 1 : N selections"],
        ["<code>eval_scores</code>", "One quality score of a quiz (judge, checks)", "by quiz id"],
    ], widths=["26%", "46%", "28%"])
    body += "<h3>Modelling choices that matter</h3>" + table(["Choice", "Why"], [
        ["Options in their own table; <code>is_correct</code> on the option", "A multi-answer question needs no special structure; the answer key is never sent to the browser before the submit"],
        ["<code>answer_selections</code> instead of an array", "The database refuses an option that does not exist, and a score is a plain join"],
        ["Score per answer <b>and</b> final score, with a <code>scoring_version</code>", "The user sees why; old attempts keep the rule they were scored with"],
        ["No users table", "Cognito is the source of truth; every query filters by its <code>sub</code>, and another user's id answers 404"],
        ["The rules live in the database", "Unique idempotency keys, one active attempt per user and quiz, a monotonic <code>revision</code> per answer, <code>SELECT … FOR UPDATE</code> on submit, checks on ranges"],
    ], widths=["38%", "62%"])
    return sec("data", "Data model", body, "The full table-by-table explanation is in the long report.")


def agent():
    body = d.agent_graph()
    body += table(["Step", "What happens"], [
        ["<b>route</b>", "No model call: a short document (up to ~4,500 tokens) goes <code>single-shot</code>; a long one with 4 or more sections goes <code>section-map-reduce</code>, so the questions cover the whole document"],
        ["<b>generate</b> and <b>check</b>", "The model returns strict JSON (validated by zod, repaired up to 2 times). Fixed checks: every question must carry a <b>literal quote from the document</b>; a question whose quote cannot be found is dropped, never shown"],
        ["<b>critique</b> and <b>revise</b>", "A second pass finds weak or ambiguous questions and rewrites them, at most 2 rounds"],
        ["<b>save</b>", "Questions and options are written in one transaction, then the quiz is <code>ready</code>"],
    ], widths=["22%", "78%"])
    body += table(["Control", "Value"], [
        ["Budget per job", "16 model calls, 120,000 tokens, 5 minutes; kept in the database, so a redelivered message does not reset it"],
        ["Retries", "Model HTTP 3 retries · JSON repair 2 · critique 2 rounds · queue 3 receives, then the dead-letter queue and an alarm"],
        ["Resume after a crash", "LangGraph checkpoints in Postgres: a restarted worker continues without repeating paid calls. They are deleted when the quiz is saved, and after 24 h at the latest"],
        ["Models", "Generator MiniMax-M2.7, judge MiniMax-M3 (a different model, to reduce self-preference); both through one OpenAI-compatible client"],
    ], widths=["24%", "76%"])
    return sec("agent", "The agent", body)


def score():
    body = table(["Level", "Formula", "Where it is stored"], [
        ["One question", "<code>4 × max(0, (hits − misses) / K)</code>, K = number of correct options (a single-answer question is 4 or 0)", "<code>answers.score</code>"],
        ["Weight of a question", "<code>1.1^(position − 1)</code>: each later question weighs 10% more", "<code>answers.weight</code>"],
        ["Final score (0 to 4)", "<code>Σ(weight × score) / Σ(weight)</code>; percentage = score / 4", "<code>attempts.final_score</code>"],
    ], widths=["22%", "52%", "26%"])
    body += callout("ok", "No AI in the score", "The score is computed by the server from the stored answer key and selections (<code>packages/core/src/scoring.ts</code>), with table and property-based tests. The LLM judge grades the <b>quality of the quiz</b>, never the user's answers.")
    return sec("score", "Score", body)


def quality():
    body = d.quality_pipeline()
    body += table(["What", "How", "When"], [
        ["Every quiz is scored", "One function: fixed checks (grounding, formatting, diversity, coverage) plus an LLM judge (median of 3), run by the scorer service. Same function in production and in the evals", "After each quiz"],
        ["Langfuse", "A trace per quiz with every step, tokens and cost; the scores are attached to the trace. Datasets and experiments compare prompts and strategies", "Production, main, nightly"],
        ["Golden set", "5 documents (including Portuguese and a prompt-injection one) with minimum thresholds, for example grounded = 1 and mean judge ≥ 0.70. A red result blocks the deploy", "On a pull request that touches prompts or LLM code, on main, every night"],
        ["promptfoo", "81 offline tests (attack corpus, language, bad model replies) on every PR; 21 live tests against the real model", "PR · main · nightly"],
        ["Alarms", "Low average quality, high daily cost, dead-letter queue, 5xx, CPU: e-mail through SNS", "Always"],
    ], widths=["20%", "56%", "24%"])
    body += '<div class="shots">' + img("langfuse-2-trace.png", "A real trace in Langfuse: the graph steps and the model calls") + img("langfuse-3-scores.png", "The scores of that quiz, with the judge's comment") + "</div>"
    return sec("quality", "Quality and observability", body)


def security():
    body = d.guardrail_layers()
    body += table(["Question", "Answer"], [
        ["Can a user read another user's quiz?", "No. The identity is the <code>sub</code> of a verified Cognito token (signature, issuer, expiry, client); the API reads nothing else. Every query filters by it, and a foreign id answers 404. A test tries it"],
        ["Can someone flood the site?", "Layers: WAF (1000 per 5 min per IP), 120 requests a minute per user, 10 quiz creations a minute, 10 quizzes a day, a queue that limits model calls. Not covered: a distributed attack from many IPs"],
        ["Can the README URL point anywhere?", "No. Only <code>https</code> to <code>github.com</code> and <code>raw.githubusercontent.com</code>; the name is resolved and private addresses are blocked; redirects are re-checked; 10 s and 512 KB limits"],
        ["What if the README contains a prompt injection?", "It is treated as data: hidden or encoded text is rejected, only English, Portuguese and Spanish are accepted, the document is delimited in the prompt, and the reply must be only the quiz JSON with a literal quote. Output rails check it. A public benchmark of 500 samples measured the first layer honestly (modest recall, no false positives)"],
        ["What about CORS and CSRF?", "No CORS: the browser only talks to its own origin and the BFF holds the cookie; the BFF blocks cross-site requests"],
    ], widths=["30%", "70%"])
    return sec("security", "Security and guardrails", body, "Eight layers, from the edge to the data. A threat is stopped by the first layer that can see it.")


def cicd():
    body = d.cicd()
    body += table(["Moment", "What runs", "What it blocks"], [
        ["Pull request", "Type check, lint, unit and integration tests (real Postgres), migration checks, end-to-end test in a real browser, image build with Trivy, Terraform validate, secret scan, promptfoo; the real-model evaluation when prompts or LLM code changed", "The merge: 8 checks are required (ruleset managed by Terraform), no direct push, linear history"],
        ["Merge to main", "The same checks, then the real-model evaluation, then <b>publish-prompts</b> (the only way a prompt reaches Langfuse)", "The deploy"],
        ["Deploy", "Build ARM64 images tagged with the git sha → drift check → <b>migration before the new code</b> → Terraform apply with a rolling update and automatic rollback → smoke test", "A human approval in the <code>production</code> environment; the AWS role is assumed by OIDC, no stored keys"],
    ], widths=["16%", "54%", "30%"])
    body += '<div class="shots">' + img("demo-1-fail-run.png", "A pull request with a hidden prompt injection: promptfoo and quality fail, the merge is blocked") + img("demo-5-ok-pr-run.png", "A pull request that passes: every gate is green") + "</div>"
    return sec("cicd", "CI/CD", body)


def cost():
    body = d.pause_diagram()
    body += table(["", "Running", "Paused (standby)"], [
        ["Cost", "about US$160 a month (≈ $5 a day)", "about US$8 a month (≈ $0.3 a day)"],
        ["What is off", "—", "Tasks at 0, database stopped, no NAT, no load balancer, no WAF. Data, secrets, users and the address are kept"],
        ["Switch", "<code>scripts/resume.sh</code>: about 9 minutes", "<code>scripts/pause.sh</code>: about 2 minutes"],
    ], widths=["16%", "34%", "50%"])
    body += callout("ok", "Tested for real", "The full cycle (resume, check, pause, plan with no changes) was run on the real account. It found a bug in the pause order (the WAF was deleted while CloudFront still used it), now fixed with a two-phase pause. The environment stays paused until the day it is needed.")
    return sec("cost", "Cost and standby", body)


def decisions():
    body = table(["Decision", "Instead of", "Why"], [
        ["Four separate services and a queue", "One server calling the model in the request", "A slow, paid, failing step is isolated; the API stays fast; concurrency is capped"],
        ["The judge runs <b>after</b> the quiz is ready (scorer)", "Judging before saving", "The user waits ~30 s less, and a judge failure never loses a quiz"],
        ["Score in plain code", "An LLM grading answers", "Exact, free, testable; the model only grades quiz quality"],
        ["PostgreSQL for data <b>and</b> checkpoints", "Redis for checkpoints", "No extra service (about US$12 a month); the same effect with a delete on success and a 24 h sweep. Redis is a listed future step"],
        ["Prompts in Git, pushed to Langfuse only by the pipeline", "Editing prompts in the Langfuse UI", "A prompt cannot reach Langfuse without passing the gates"],
        ["Real-model evaluation on PRs that need it", "On every PR, or only after the merge", "Quality blocks the merge, and a PR without prompt or LLM changes costs nothing"],
        ["CloudFront address, no domain", "A domain and certificate", "No domain available"],
    ], widths=["32%", "24%", "44%"])
    return sec("decisions", "Main decisions", body)


def limits():
    body = table(["Limit or risk", "What would fix it"], [
        ["No custom domain: TLS 1.0 and up on the CloudFront address, plain HTTP between CloudFront and the load balancer inside AWS", "A domain with an ACM certificate"],
        ["One NAT gateway and a single-zone database", "Flags exist for multi-zone (about +$50 a month)"],
        ["A distributed flood (many IPs) is only limited by autoscaling", "Shield Advanced, or country and reputation rules in the WAF"],
        ["The guard catches explicit patterns (28% of the English public dataset, no false positives); the rest relies on the model and the other layers", "A multilingual classifier, more keyword languages, red-team generated attacks"],
        ["The README host list allows any public GitHub repository", "Restrict to the catalog or to a list of owners"],
        ["Only 5 golden documents, so small differences are noise", "More documents and repeated runs"],
        ["The MiniMax and Langfuse keys appeared in chat and must be rotated; the alarm e-mail needs its AWS confirmation", "Rotate, then confirm the subscription"],
        ["Checkpoints could move to Redis or Valkey with a native TTL", "Only if their write load shows up in the database metrics"],
    ], widths=["62%", "38%"])
    return sec("limits", "Limits and next steps", body)


def links():
    body = table(["What", "Where"], [
        ["The app (paused until the day it is needed: <code>scripts/resume.sh</code>, about 9 minutes)", link(APP)],
        ["API docs (OpenAPI)", link(APP + "/docs")],
        ["Repository", link(GH)],
        ["Pipeline runs", link(GH + "/actions")],
        ["Langfuse project (traces, scores, datasets)", link(LF)],
        ["Long reference report (every detail, bugs, runbook)", "<code>docs/architecture/quizforge-architecture-full.html</code>"],
        ["Generation structure comparison (9 variants × 5 documents)", "<code>docs/eval/structure-comparison.html</code>"],
        ["Security benchmark (500 samples of a public dataset)", "<code>docs/security/benchmark.html</code>"],
    ], widths=["46%", "54%"])
    body += "<h3>A ten-minute path through this page</h3>" + table(["Minutes", "Show", "Say"], [
        ["1", "What it is", "The assignment and where each requirement lives"],
        ["2", "Architecture", "Why four services and a queue: the model is slow, costly and fails"],
        ["2", "One quiz, end to end · Data model", "The two flows, and the tables that hold questions, answers and the score"],
        ["2", "The agent · Score", "Router, literal quotes, critique, a budget; the score is plain code"],
        ["1", "Quality · Security", "Every quiz is scored; eight layers; no user can read another's data"],
        ["1", "CI/CD · Cost", "Gates block merge and deploy; paused for US$8 a month, switched on in 9 minutes"],
        ["1", "Decisions · Limits", "Trade-offs and what would come next"],
    ], widths=["10%", "34%", "56%"])
    return sec("links", "Links and the presentation path", body)


def all_sections():
    return [overview(), architecture(), flow(), data(), agent(), score(), quality(), security(), cicd(), cost(), decisions(), limits(), links()]


NAV = [("summary", "What it is"), ("architecture", "Architecture"), ("flow", "End to end"), ("data", "Data model"), ("agent", "Agent"), ("score", "Score"), ("quality", "Quality"), ("security", "Security"),
       ("cicd", "CI/CD"), ("cost", "Cost"), ("decisions", "Decisions"), ("limits", "Limits"), ("links", "Links")]
