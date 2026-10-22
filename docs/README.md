# Reports

Every report is **one HTML file** with its charts inside (no server, no build step to read it). Open it in a browser; print to PDF from the browser if you need a PDF.

| # | Report | File | What it covers |
|---|---|---|---|
| 1 | **Architecture (short, for the presentation)** | [architecture/quizforge-architecture.html](architecture/quizforge-architecture.html) | Only what is essential, in the order it is explained: what it is, AWS architecture, one quiz end to end, data model, the agent, the score, quality, security, CI/CD, cost and standby, decisions, limits, and a ten-minute path |
| 1b | **Architecture (full reference)** | [architecture/quizforge-architecture-full.html](architecture/quizforge-architecture-full.html) | Everything: protocols, every guardrail, Langfuse details, bugs found, runbook, glossary, live state |

## These are snapshots, not a build

The pages here are **frozen**. The generator that produced them, and the measured JSON and write-ups that fed
them, were removed: they were the output of scans and studies that had already run, none of it was used by the
application, by CI or by the nightly task, and the conclusions are in the HTML with their charts embedded. In
the committed copies the **AWS account id** is replaced by `<account-id>`; no password, key or token was ever
in them.

What still runs, and is not affected: the **nightly red team report**, built by the Fargate task itself
(`guardrails/promptfoo/redteam/nightly-report.ts`) and written to S3 on every run. It never used the generator
and uses no screenshots.
