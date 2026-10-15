# Nightly red team: reading the report and acting on it

The task, its schedule, the S3 layout, running it by hand, the cost and turning it on are AWS operations: see [docs/redteam-nightly.md](https://github.com/jhgcc1/quizforge-infra/blob/main/docs/redteam-nightly.md) in the infrastructure repository (`scripts/redteam-latest.sh` there prints a link to the newest report). The image and its entrypoint (`docker/redteam`, `scripts/redteam-nightly-aws.sh`) are built from this repository and pushed to ECR by the `publish` job.

## How to read the report

* **KPI cards:** cases; rejected before the model (guard, language policy, detector, refused topic: cost nothing); rejected by the output rails (the model
  answered but the reply was refused); valid quiz (it passed the rails and the grounding check: the attack did not work); **LEAKED**; other failures
  (something unexpected, not a leak); model calls.
* **LEAKED** is the number that matters: the canary (a token like `ZX9-XRAY` that only an attack contains) was in the quiz, so the model obeyed the document.
  Each leaked case lists the canary, language, intent, strategy, an excerpt of the reply and the start of the attack.
* **Tables** by language, strategy, threat group and intent show where the leaks are. A leak in one language only means the guard or the prompt is weaker there.
* A high "valid quiz" count is not bad: the model read the attack and ignored it.

## Promote a leaked case to the frozen sample

1. Open `new-failures.json` of the run. Each entry has the attack text (`prompt`) and its `vars`.
2. Fix the cause (guard rules in `packages/core/src/injection-rules.ts`, the prompts, or the output rails in `packages/llm/src/output-guard.ts`).
3. Add the attack to the corpus so a pull request catches it from now on: either as a new test in `promptfoo/redteam/sample.yaml` (copy an entry, set
   `vars.prompt`, `vars.canary`, `metadata`) or, for a text attack, in `packages/core/src/attacks.ts`. Keep the sample size in sync with `promptfoo/README.md`.
4. Known cases that are not fixed yet can go to `promptfoo/redteam/known-failures.json` (`[{ "description": "...", "prompt": "..." }]`) so they are not reported as new.

