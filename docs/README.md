# Reports

Every report is **one HTML file** with its charts inside (no server, no build step to read it). Open it in a browser; print to PDF from the browser if you need a PDF.

| # | Report | File | What it covers |
|---|---|---|---|
| 1 | **Architecture (short, for the presentation)** | [architecture/quizforge-architecture.html](architecture/quizforge-architecture.html) | Only what is essential, in the order it is explained: what it is, AWS architecture, one quiz end to end, data model, the agent, the score, quality, security, CI/CD, cost and standby, decisions, limits, and a ten-minute path |
| 1b | **Architecture (full reference)** | [architecture/quizforge-architecture-full.html](architecture/quizforge-architecture-full.html) | Everything: protocols, every guardrail, Langfuse details, bugs found, runbook, glossary, live state |
| 2 | **Structure comparison** | [eval/structure-comparison.html](eval/structure-comparison.html) (raw numbers: [structure-comparison.json](eval/structure-comparison.json)) | Which generation structure and prompt works best: 9 variants × 5 documents, with Langfuse run links |
| 3 | **Guardrails and promptfoo** | [security/guardrails-promptfoo.html](security/guardrails-promptfoo.html) (raw: the JSON files beside it, and [guard-cost.json](security/guard-cost.json)) | The specialised report: the input guard step by step, the keyword rules and their audit, Prompt Guard 2 and the input preparation, **what the guard costs in CPU**, the output rails, how promptfoo is used, the red team, the nightly and its alarms, where the attacks come from, where the prompts come from, and the open gaps |
| 4 | **Security benchmark** | [security/benchmark.html](security/benchmark.html) (raw: [benchmark.json](security/benchmark.json)) | The input guard and the optional classifier against 500 samples of a public prompt-injection dataset (deepset/prompt-injections, Apache-2.0): detection and false positives, with the examples that passed. The numbers come from `pnpm --filter @quizforge/detector benchmark -- --detector`, which still writes `security/benchmark.json` |

## These are snapshots, not a build

The pages here are **frozen**. The generator that produced the architecture reports (a `site/` folder of Python
modules) and the scripts that drove it (`reports.sh`, `measure-facts.sh`, `security-report.py`) have been removed:
they built documentation, nothing in the application or in CI called them, and the reports they made are kept as the
HTML in this folder, charts and screenshots embedded. In the committed copies the **AWS account id** is replaced by
`<account-id>`; no password, key or token was ever in them.

What still runs, and is not affected by any of this:

* the **nightly red team report** — built by the Fargate task itself (`promptfoo/redteam/nightly-report.ts`), written
  to S3 on every run. It never used the Python generator and uses no screenshots;
* the **measured JSON beside these pages** (`security/*.json`) — still written by the checks in
  `promptfoo/redteam/replay/` and by `scripts/measure-guard-cost.mjs`, so the evidence behind the numbers stays
  reproducible even though the page that presents them does not get rebuilt;
* the **structure comparison** — rendered from `eval/structure-comparison.json` by
  `pnpm --filter @quizforge/evals report`, which is TypeScript and still here.

To change what a report says, edit its HTML, or rebuild the generator from the history: it was removed in the commit
that added this paragraph.
