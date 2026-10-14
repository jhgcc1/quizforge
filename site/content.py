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
    cards = [("4 + 1", "services (web, api, worker, scorer) and a sweeper"), ("5–8", "questions per quiz, 4 options each"), ("11", "checks on every request, one an ML model"),
             ("11", "CI jobs on a pull request"), ("978", "automated tests, 99.6% of lines covered"), ("~$0.01", "per quiz, measured")]
    c = "".join(f'<div class="card"><div class="num">{n}</div><div>{t}</div></div>' for n, t in cards)
    body = f'<div class="cards">{c}</div>'
    body += "<p>QuizForge is an AI agent that reads a Markdown README (a URL), writes a 5–8 question multiple-choice quiz, lets a user take it in a web app and computes a weighted score. It runs on AWS, is built with Terraform and deployed by GitHub Actions. Every quiz is traced and scored in Langfuse.</p>"
    body += "<h3>The assignment, and where each part lives</h3>" + table(["Requirement", "Where it is", "Section"], [
        ["Generate a quiz of 5–8 questions with 4 options from a README at a configurable URL", "<code>POST /v1/quizzes {sourceUrl}</code>; an agent (LangGraph) in the <b>worker</b> service", "Agent"],
        ["Run the quiz, correct it, compute the final weighted score (+10% weight per question)", "Web UI (Next.js) and API; the score is plain code: <code>Σ(1.1^(i−1) · score_i) / Σ(1.1^(i−1))</code>", "Agent and score"],
        ["Store questions, answers and the final score in a database", "PostgreSQL: 9 tables, every answer saved at the click", "Data model"],
        ["REST API and web UI", "Fastify (OpenAPI at <code>/docs</code>) and Next.js with a login by Amazon Cognito: e-mail sign-up, Google and Facebook", "Architecture"],
        ["Production-ready, not a PoC", "Terraform on AWS, autoscaling, retries and a dead-letter queue, alarms, CI/CD with gates, pause and resume", "Architecture · CI/CD · Cost"],
        ["Safe with untrusted input (not asked, but a README is text written by someone else)", "11 checks on every request: deterministic rules first (106 keyword rules, English, Portuguese, Spanish only), one ML classifier (Llama Prompt Guard 2) that only flags, output rails on the reply. promptfoo proves them on every pull request and every night", "Guardrails · promptfoo · Nightly"],
        ["LLM observability and several generation strategies (nice to have)", "Langfuse traces, costs and scores; <code>single-shot</code> and <code>section-map-reduce</code> chosen by a router, plus critique and revise", "Quality · Agent and score"],
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
        ["<b>Cognito</b>", "Users and login (code flow with PKCE): sign-up with e-mail, Google and Facebook", "Standard JWT, no passwords stored by us; the sign-up can be switched off (<code>allow_self_signup</code>)"],
        ["<b>Langfuse</b> and <b>CloudWatch</b>", "Traces, cost and quality scores; logs, metrics, 20 alarms by e-mail (including two that watch for probing)", "Langfuse for the AI, CloudWatch for the platform"],
    ], widths=["24%", "42%", "34%"])
    body += "<h3>Two repositories</h3>" + d.repos()
    body += table(["Repository", "Holds", "Meets the other by"], [
        ["<b>quizforge-web</b> (public)", "The Next.js front end and its BFF; its own CI, Dockerfile and coverage floor", "The API contract (<code>@quizforge/contract</code>), installed from a tarball on a GitHub Release of the back end"],
        ["<b>quizforge</b>", "API, worker, scorer, the contract, database, agent, evals, promptfoo, end-to-end test, Terraform, the deploy", "<code>web.ref</code>: the commit of the front end that its e2e test and its deploy build; a pull request bumps it"],
    ], widths=["22%", "46%", "32%"])
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
    body = ""
    body += "<h3>Before the model: how the README is prepared</h3>" + d.prep_flow()
    body += table(["Step", "What it does", "Why"], [
        ["1 · Download", "Only <code>github.com</code> and <code>raw.githubusercontent.com</code>, https, the name resolved to public addresses only, redirects re-checked, 10 s, 512 KB, text content types", "The URL is user input: it must not reach internal addresses or huge files"],
        ["2 · Normalize and clean", "Line endings and blank lines normalised; text hidden as Base64, hex, ROT13 and similar is decoded and looked into (a hidden instruction rejects the document); invisible characters and HTML comments are removed", "What the model reads is what a person reads"],
        ["3 · Language", "Detected on the prose only (code blocks, inline code, links and HTML are dropped first); only English, Portuguese and Spanish are accepted", "The quality gates and rules are built for these three"],
        ["4 · Classifier", "Llama Prompt Guard 2 (86M, ONNX, baked into the worker image): scores each 512-token window of the document, flags a likely injection and never blocks. On in production and in the local stack", "A second opinion for paraphrased attacks, in the languages the product accepts (and five more)"],
        ["5 · Store", "The cleaned text is saved once per content hash; the scorer later reads the same text back", "One version of the document for generation and scoring"],
        ["6 · Route and cut", "A short document goes whole (cut at 60,000 characters); a long one with at least 4 sections is split by headings (below)", "The model gets a size it can handle"],
        ["7 · Build the prompt", "The rules are in the system prompt; the document goes inside <code>&lt;document&gt;</code> tags and is told to be data; a fake closing tag in the README is neutralised; the topic is one plain line", "The document cannot pose as an instruction"],
        ["8 · Model-call guard", "Strict message schema, size caps, the document inspected again, output tokens capped, a budget of 16 calls", "A last check at the only door to the model"],
    ], widths=["16%", "56%", "28%"])
    body += "<h3>The graph</h3>" + d.agent_graph()
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
    body += "<h3>The score (no AI)</h3>" + table(["Level", "Formula", "Stored in"], [
        ["One question", "<code>4 × max(0, (hits − misses) / K)</code>, K = number of correct options (single answer: 4 or 0)", "<code>answers.score</code>"],
        ["Weight of a question", "<code>1.1^(position − 1)</code>: each later question weighs 10% more", "<code>answers.weight</code>"],
        ["Final score (0 to 4)", "<code>Σ(weight × score) / Σ(weight)</code>; percentage = score / 4", "<code>attempts.final_score</code>"],
    ], widths=["22%", "54%", "24%"])
    body += "<p>Computed by the server from the stored answer key and selections (<code>packages/core/src/scoring.ts</code>), never from a number sent by the browser. The LLM judge grades the <b>quality of the quiz</b>, not the user's answers.</p>"
    return sec("agent", "The agent and the score", body)


def quality():
    body = d.quality_pipeline()
    body += table(["What", "How", "When"], [
        ["Every quiz is scored", "One function: fixed checks (grounding, formatting, diversity, coverage) plus an LLM judge (median of 3), run by the scorer service. Same function in production and in the evals", "After each quiz"],
        ["Langfuse", "Used for traces (each step, tokens, cost), the quality scores of each quiz, and experiments on the golden set. Details in the full report", "Production, main, nightly"],
        ["Golden set", "5 documents (including Portuguese and a prompt-injection one) with minimum thresholds, for example grounded = 1 and mean judge ≥ 0.70. A red result blocks the deploy", "On a pull request that touches prompts or LLM code, on main, every night"],
        ["Alarms", "Low average quality, high daily cost, dead-letter queue, 5xx, CPU, documents rejected or flagged in bursts, a nightly red-team leak: e-mail through SNS", "Always"],
    ], widths=["20%", "56%", "24%"])
    return sec("quality", "Quality and Langfuse", body)


def guardrails():
    body = d.guardrail_flow()
    body += table(["", "Deterministic rules (code)", "A model"], [
        ["<b>Input</b> (README and request)", "WAF, JWT, CSRF, strict schemas, quotas · host allow-list and public IPs only · hidden or encoded text · <b>106 keyword rules</b>, the same 35 in English, Portuguese and Spanish plus one language-free rule · <b>language policy</b>: only English, Portuguese and Spanish are accepted, every other language is rejected before anything else (statistical, no model call) · the model-call guard", "<b>One ML model:</b> <b>Llama Prompt Guard 2 (86M)</b>, a classifier for prompt injection and jailbreaks (English, French, German, Hindi, Italian, Portuguese, Spanish, Thai). It <b>flags</b> a document, never blocks. On in production and in the local stack"],
        ["<b>The model call</b>", "The document is sent as data inside <code>&lt;document&gt;</code> tags; budget of 16 calls", "<b>The generation LLM itself</b> is told never to obey the document. This is the only probabilistic defence"],
        ["<b>Output</b> (the reply)", "Output rails (JSON only, no prompt leak, no script, no echoed attack) · a <b>strict link rule</b>: when the document carried an instruction, a link in the reply is accepted only if it also appears in the document <i>without</i> the instruction sentences · the zod schema · the literal-quote grounding · the answer key hidden until the submit", "<b>None.</b> No model checks the reply for injection. The LLM judge scores quality after the quiz is saved and blocks nothing"],
    ], widths=["16%", "46%", "38%"])
    body += table(["Language", "What happens to a document"], [
        ["English, Portuguese, Spanish", "Accepted. The keyword rules have full, equal coverage (accents optional, formal and informal forms, common typos), and the classifier covers all three"],
        ["Any other language", "<b>Rejected before the model</b> with a clear message, and promptfoo tests that (French, German, Italian, Hindi, Thai and others). The keyword rules for other languages were removed on purpose: this one policy is the protection"],
    ], widths=["26%", "74%"])
    body += callout("ok", "Rules first, models second", "Every rule is cheap, deterministic and tested, and a threat is stopped by the first layer that can see it. A model is used only where a rule cannot decide (a paraphrased injection), and only to <b>flag</b>. Measured honestly on a public dataset of 500 samples (chatbot-style attacks, English): the rules caught 29.9%, Prompt Guard 2 25.8%, with no false positives. The model resisting and the output rails therefore matter, and a red team found exactly that: a Spanish attack slipped past the guard and the model wrote the attacker's link into an option. The full Spanish rules and the strict link rule were the fix.")
    return sec("guardrails", "Guardrails in execution", body, "What happens to every request, in order, and what kind of check each step is.")


def promptfoo():
    body = table(["Suite", "Runs", "Model", "Tests"], [
        ["<b>Offline</b>", "Every pull request", "A fake model with fixed answers: free and instant", "83: the attack corpus in English, Portuguese and Spanish, the language policy (other languages rejected), bad topics, bad model replies, planted links, prompt safety rules"],
        ["<b>Live</b>", "A pull request that touches prompts or LLM code, every merge to main, every night", "The real MiniMax model, as the thing being tested", "20: does the real model follow an instruction hidden in a document, write something that is not a quiz, or leave its purpose?"],
        ["<b>Red team sample</b>", "<b>Every pull request and every merge to main</b>", "Offline stage, then the real model", "50 frozen attacks (17 English, 17 Portuguese, 16 Spanish) from 12 intents, each with a canary token, in several forms (plain, tone, jailbreak templates, Base64, ROT13, leetspeak), plus 5 documents in other languages that must be rejected"],
        ["<b>Red team nightly</b>", "Every night, on AWS (next section)", "The real model, with Llama Prompt Guard 2", "About 600 new attacks a night, same languages, more intents and placements"],
    ], widths=["14%", "24%", "22%", "40%"])
    body += table(["Question", "Answer"], [
        ["What is it?", "A test runner for prompts. It runs the <b>real pipeline</b> (guard, classifier, prompts, output rails) against attacks. promptfoo's red team feature generates the attack variants with the model; we freeze the result so a run is repeatable"],
        ["Is it a guardrail?", "No. It protects no user: it <b>proves</b>, before each deploy and every night, that the guardrails above still work"],
        ["Where is a model used?", "As the attacker that writes the variants (once, and in the nightly run), and as the system under test. <b>Every grade is plain code</b>: a canary in the reply means the model obeyed, plus the prompt-leak and unsafe-outcome checks. No model judges another model"],
        ["What does a case end as?", "<b>Rejected before the model</b> (guard, language, classifier), <b>rejected by the output rails</b>, or <b>a valid quiz that resisted</b>. A canary in the reply is a leak and fails the run"],
        ["Does it find real problems?", "Yes. On its first run in CI it found a Spanish attack that the guard missed and the model obeyed; that led to the full Spanish rules and the strict link rule. Offline, removing a rule from a prompt or switching off a detector also turns the suite red"],
    ], widths=["22%", "78%"])
    body += '<div class="shots">' + img("demo-1-fail-run.png", "A pull request with a hidden prompt injection: promptfoo and quality fail, the merge is blocked") + img("demo-5-ok-pr-run.png", "A pull request that passes: every gate is green") + "</div>"
    return sec("promptfoo", "promptfoo and the red team: proving the guardrails", body, "The tests behind the guardrails.")


def cicd():
    body = d.cicd()
    body += table(["Moment", "What runs", "What it blocks"], [
        ["Pull request", "Type check, lint, unit and integration tests with a coverage floor (real Postgres), migration checks, end-to-end test in a real browser (it builds the front end from its own repository at <code>web.ref</code>), image build with Trivy (the worker image carries the classifier), Terraform validate, secret scan, promptfoo, the red-team sample (50 attacks against the real model), and the real-model evaluation when prompts or LLM code changed", "The merge: 9 checks are required (ruleset managed by Terraform), no direct push, linear history"],
        ["Merge to main", "The same checks, then the real-model evaluation, then <b>publish-prompts</b> (the only way a prompt reaches Langfuse)", "The deploy"],
        ["Deploy", "Build ARM64 images (api, worker with the classifier, web from its repository, and the nightly red-team image) tagged with the git sha → drift check → <b>migration before the new code</b> → Terraform apply with a rolling update and automatic rollback → smoke test", "A human approval in the <code>production</code> environment; the AWS role is assumed by OIDC, no stored keys"],
    ], widths=["16%", "54%", "30%"])
    body += "<h3>Automated tests and coverage</h3>" + table(["Layer", "Tests", "CI job", "What it covers"], [
        ["<b>Unit and integration</b>", "978 (Vitest; integration on a real PostgreSQL)", "<code>quality</code> (fast unit run), <code>integration</code> (everything, with coverage)", "Scoring, schemas, the guard and its 103 rules, output rails, the SSRF checks, the graph, the API end to end (login, quotas, idempotency, ownership), the worker, the scorer, the sweeper, the database constraints and the migrations"],
        ["<b>End to end</b>", "7, Playwright in Chrome", "<code>e2e</code>", "Sign-up and social buttons, login, create, answer with a reload, submit, history and results, with the four services running and a fake model"],
        ["<b>Prompts, guardrails and red team</b>", "83 offline, 20 live, 50 red-team sample (promptfoo)", "<code>promptfoo</code>, <code>llm-eval-pr</code>, <code>redteam-sample</code>", "The attack corpus, language policy, bad replies, planted links, and the real model resisting attacks in three languages"],
    ], widths=["18%", "24%", "24%", "34%"])
    body += table(["Where", "Statements covered (unit + integration)", "Notes"], [
        ["<code>packages/core</code>, <code>contract</code>, <code>db</code>, <code>llm</code>, <code>detector</code>, <code>apps/api</code>", "100%", "Every line; the floors in CI are 100% for these packages"],
        ["<code>apps/worker</code>, <code>evals</code>", "about 98%", "Start-up guards and scripts that call the real model are excluded or partly covered, with a written reason"],
        ["All back end and shared code", "<b>99.6%</b> of statements and lines, 98% of functions, 95% of branches", "Measured on 2026-10-15 over 978 tests. <b>Enforced in CI:</b> the run fails if any package drops below its floor"],
        ["Front end (<code>quizforge-web</code>)", "its own CI and coverage floor", "The helpers and route handlers are unit tested; the React components are checked by the end-to-end test in Chrome"],
    ], widths=["34%", "28%", "38%"])
    body += callout("info", "Why not literally 100%", "The remaining lines are start-up guards, scripts that need a real model download, and re-exports. Padding them with empty tests would raise a number and prove nothing. What matters: the critical packages are at 100% and a drop fails the build. Next: component tests for the quiz screens in the front end repository.")
    return sec("cicd", "CI/CD", body)


def cost():
    body = d.pause_diagram()
    body += table(["", "Running", "Paused (standby)"], [
        ["Cost", "about US$180 a month (≈ $6 a day): the worker task is now 1 vCPU and 4 GB because it carries the classifier (+US$20 a month per worker task)", "about US$8 a month (≈ $0.3 a day)"],
        ["What is off", "—", "Tasks at 0, database stopped, no NAT, no load balancer, no WAF, the nightly red team off. Data, secrets, users and the address are kept"],
        ["Switch", "<code>scripts/resume.sh</code>: about 9 minutes", "<code>scripts/pause.sh</code>: about 2 minutes"],
        ["Nightly red team", "Fargate about US$3 a month, the report bucket a few cents, plus the model calls: about US$25 a month at 600 attacks a night", "0 (the schedule is off)"],
    ], widths=["16%", "46%", "38%"])
    body += callout("ok", "Tested for real", "The full cycle (resume, check, pause, plan with no changes) was run on the real account. It found a bug in the pause order (the WAF was deleted while CloudFront still used it), now fixed with a two-phase pause. The environment stays paused until the day it is needed.")
    return sec("cost", "Cost and standby", body)


def nightly():
    body = d.redteam_nightly()
    body += table(["Part", "How it works"], [
        ["Schedule", "EventBridge Scheduler, every night at 06:00 UTC. It is switched off while the environment is paused, because a paused environment has no NAT and the task could not reach the model API"],
        ["Task", "A one-shot Fargate task (<code>redteam</code>, 2 vCPU, 4 GB, ARM64), not part of the always-on services. Its image has promptfoo at a pinned version, the pipeline code and the Llama Prompt Guard 2 model, so it tests what runs in production"],
        ["Size", "About <b>600 attacks a night</b> (10 per intent), English, Portuguese and Spanish only, regenerated every night (the PR sample is fixed). A Terraform variable raises or lowers it; 1,800 a night would cost about US$70 a month in model calls, 600 about US$25"],
        ["Grading", "Plain code, never a model: a hijack canary in the reply, a prompt leak, or an unsafe outcome fails the case"],
        ["Report", "Written to a private, encrypted, versioned S3 bucket under a UTC timestamp, one folder per run that is never overwritten: <code>report.html</code>, <code>summary.json</code>, <code>results.json</code>, <code>new-failures.json</code>, plus a <code>latest/</code> pointer. It is uploaded even when there were leaks"],
        ["Alerts", "CloudWatch metrics (runs, cases, leaks, per language); an alarm and an e-mail with a 7-day link to the report if any canary leaks; another alarm if no run happened in 26 hours"],
        ["What you do with it", "Open the report; a leaked case is promoted to the frozen 50-case sample by a pull request, so CI guards it from then on"],
        ["Cost", "Fargate about US$0.10 a night, S3 a few cents, plus the model tokens"],
    ], widths=["16%", "84%"])
    return sec("nightly", "Nightly red team on AWS", body, "A denser, separate test of the guardrails that runs while nobody is looking and leaves a timestamped report.")


def tradeoffs():
    body = table(["Topic", "What we chose", "What would change it"], [
        ["Prompt-injection classifier", "Llama Prompt Guard 2 (86M, multilingual) instead of the English-only DeBERTa. On the public chatbot-style dataset it catches fewer injections in English (25.8% against 39.2%) but has no false positives (the old model flagged the Pipecat README) and covers our three languages. It only flags", "The red-team results on our own attacks; a blocking mode only after a threshold is chosen from real data"],
        ["Languages", "Only English, Portuguese and Spanish: rules, tests and red team all focus there; any other language is rejected before the model", "A new language is added to the policy, the rules and the red team together"],
        ["Two repositories", "The front end is its own public repository; the back end keeps the infrastructure and the deploy and pins the front end with <code>web.ref</code>. They share only the API contract, released as a tarball", "A separate deploy for the front end, if its team and release pace diverge"],
        ["Sign-up", "Open: anyone can create an account (e-mail verified), or use Google or Facebook; 10 quizzes a day per user and the WAF limit the cost. It can be switched off with <code>allow_self_signup</code>", "A pre-sign-up allow-list of e-mails or domains"],
        ["Agent checkpoints", "In Postgres, deleted when the quiz is saved and after 24 h at the latest: no extra service", "Redis or Valkey with a native TTL (about US$12 a month), only if the checkpoint writes show up in the database metrics"],
        ["Address and TLS", "The CloudFront address, TLS 1.0 and up, plain HTTP between CloudFront and the load balancer inside AWS", "A domain with an ACM certificate"],
        ["Availability", "One NAT gateway and a single-zone database", "Flags exist for multi-zone, about +$50 a month"],
        ["A distributed flood", "Limited by the WAF per IP and by autoscaling", "Shield Advanced, or country and reputation rules"],
        ["README sources", "Any public GitHub repository (host allow-list)", "Restrict to the catalog or to a list of owners"],
        ["Evaluation size", "5 golden documents and a 600-attack nightly sample: a regression gate, not a proof", "More documents and repeated runs; promote leaked cases to the frozen sample"],
    ], widths=["18%", "52%", "30%"])
    return sec("tradeoffs", "Trade-offs and next steps", body, "What was decided on purpose, and what would change it.")


def links():
    body = table(["What", "Where"], [
        ["The app (paused until the day it is needed: <code>scripts/resume.sh</code>, about 9 minutes)", link(APP)],
        ["API docs (OpenAPI)", link(APP + "/docs")],
        ["Back end repository (API, worker, infrastructure, deploy)", link(GH)],
        ["Front end repository", link("https://github.com/jhgcc1/quizforge-web")],
        ["Pipeline runs", link(GH + "/actions")],
        ["Langfuse project (traces, scores, datasets)", link(LF)],
        ["Long reference report (every detail, bugs, runbook)", "<code>docs/architecture/quizforge-architecture-full.html</code>"],
        ["Generation structure comparison (9 variants × 5 documents)", "<code>docs/eval/structure-comparison.html</code>"],
        ["Security benchmark (500 samples of a public dataset, two models)", "<code>docs/security/benchmark.html</code>"],
        ["The nightly red-team report (after it is switched on)", "<code>scripts/redteam-latest.sh</code> prints a link to the newest one in S3"],
    ], widths=["46%", "54%"])
    body += "<h3>A ten-minute path through this page</h3>" + table(["Minutes", "Show", "Say"], [
        ["1", "What it is", "The assignment and where each requirement lives"],
        ["2", "Architecture", "Why four services and a queue: the model is slow, costly and fails"],
        ["2", "One quiz, end to end · Data model", "The two flows, and the tables that hold questions, answers and the score"],
        ["2", "The agent and the score", "Router, literal quotes, critique, a budget; the score is plain code"],
        ["2", "Guardrails · promptfoo · Nightly", "Rules first, one ML model only to flag, three languages; promptfoo and a nightly red team on AWS prove the guardrails"],
        ["1", "Quality and Langfuse · CI/CD", "Every quiz is scored; gates block merge and deploy; coverage is enforced"],
        ["1", "Cost · Trade-offs", "Paused for US$8 a month, on in 9 minutes; what was decided and what would change it"],
    ], widths=["10%", "34%", "56%"])
    return sec("links", "Links and the presentation path", body)


def all_sections():
    return [overview(), architecture(), flow(), data(), agent(), guardrails(), promptfoo(), nightly(), quality(), cicd(), cost(), tradeoffs(), links()]


NAV = [("summary", "What it is"), ("architecture", "Architecture"), ("flow", "End to end"), ("data", "Data model"), ("agent", "Agent and score"), ("guardrails", "Guardrails"), ("promptfoo", "promptfoo"), ("nightly", "Nightly"),
       ("quality", "Quality"), ("cicd", "CI/CD"), ("cost", "Cost"), ("tradeoffs", "Trade-offs"), ("links", "Links")]
