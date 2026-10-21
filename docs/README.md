# Reports

Every report is **one HTML file** with its charts inside (no server, no build step to read it). Open it in a browser; print to PDF from the browser if you need a PDF.

| # | Report | File | What it covers |
|---|---|---|---|
| 1 | **Architecture (short, for the presentation)** | [architecture/quizforge-architecture.html](architecture/quizforge-architecture.html) | Only what is essential, in the order it is explained: what it is, AWS architecture, one quiz end to end, data model, the agent, the score, quality, security, CI/CD, cost and standby, decisions, limits, and a ten-minute path |
| 1b | **Architecture (full reference)** | [architecture/quizforge-architecture-full.html](architecture/quizforge-architecture-full.html) | Everything: protocols, every guardrail, Langfuse details, bugs found, runbook, glossary, live state |
| 2 | **Structure comparison** | [eval/structure-comparison.html](eval/structure-comparison.html) (raw numbers: [structure-comparison.json](eval/structure-comparison.json)) | Which generation structure and prompt works best: 9 variants × 5 documents, with Langfuse run links |
| 3 | **Guardrails and promptfoo** | [security/guardrails-promptfoo.html](security/guardrails-promptfoo.html) (raw: the JSON files beside it, and [guard-cost.json](security/guard-cost.json)) | The specialised report: the input guard step by step, the keyword rules and their audit, Prompt Guard 2 and the input preparation, **what the guard costs in CPU**, the output rails, how promptfoo is used, the red team, the nightly and its alarms, where the attacks come from, where the prompts come from, and the open gaps. Run: `python3 site/build.py --guardrails --public` |
| 4 | **Security benchmark** | [security/benchmark.html](security/benchmark.html) (raw: [benchmark.json](security/benchmark.json)) | The input guard and the optional classifier against 500 samples of a public prompt-injection dataset (deepset/prompt-injections, Apache-2.0): detection and false positives, with the examples that passed. Run: `pnpm --filter @quizforge/detector benchmark -- --detector`, then `python3 scripts/security-report.py` |

## What is left out of the committed architecture report

The page is the same as the local one (screenshots included), with one change: the **AWS account id** is replaced by `<account-id>`.

> **The screenshots in it are historical.** They are embedded in the committed HTML as base64 and keep working, but the
> scripts that produced them (Langfuse pages, GitHub Actions runs, promptfoo reports) are gone: they drove a browser over
> pages whose run ids and layout have moved on, they wrote into the git-ignored `site/img/`, and nothing in the application
> depended on them. A rebuild needs those PNGs back in `site/img/` or it will report the missing file. The reports that the
> pipeline produces by itself — the guardrails report, the security benchmark and the nightly red team report — use no
> screenshots at all and are unaffected. Passwords, keys and tokens are never in it: the build refuses to write the page if any value from the git-ignored env files (`.env`, `.local/e2e-user.env`) appears in it.

## Regenerating

```bash
scripts/reports.sh        # rebuilds the committed reports, then `git diff --stat docs/` shows what changed
```

* Structure comparison: rendered from `docs/eval/structure-comparison.json` by `pnpm --filter @quizforge/evals report`. New numbers come from `pnpm --filter @quizforge/evals compare` (calls the real model, about $0.8) and are then merged into the JSON.
* Guardrails and promptfoo: `python3 site/build.py --guardrails --public` (content in `site/content_guardrails.py`, numbers in `site/facts_guard.py`). It needs no AWS account and no Langfuse: every number is read from the measured JSON in `docs/security`, from the repository and from a checkout of the infrastructure repository (the alarms). The cost table comes from `scripts/measure-guard-cost.mjs`, which writes `docs/security/guard-cost.json`; re-run it when the guard changes, and once more under a CPU limit (`GUARD_COST_CPU=50 systemd-run --user --scope -p CPUQuota=50% ... --merge`) for the production profile.
* Architecture: the generator is in `site/` (`build.py`, `content.py`, `diagrams.py`, `lib.py`, `langfuse.py`: Python, no dependencies). It reads the resource ids in `.local/links.json` and the real Langfuse trace through `.env` (both git-ignored), so it runs on the maintainer's machine. The infrastructure facts (alarms, services, the audit checks, the deploy smoke tests, the required checks) are read from a checkout of [jhgcc1/quizforge-infra](https://github.com/jhgcc1/quizforge-infra): `INFRA_DIR=/path/to/quizforge-infra` (default: a sibling directory `../quizforge-infra`). The numbers come from the repository files and from `site/measured.json` (test counts, coverage), which `scripts/measure-facts.sh` writes by running the tests; re-run it when code changed. `python3 site/build.py` writes the short local page (`site/quizforge-architecture.html`, git-ignored) and `--full` the long one (`content_full.py`); `--public` writes the committed copies here (account id removed). The page is part of the change that it describes: update it in the same PR as the code.
