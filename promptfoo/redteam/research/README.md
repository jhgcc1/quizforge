# Red team research

Scripts a maintainer runs **by hand**. Nothing here runs in CI, nothing here runs on the nightly task, and
`.dockerignore` keeps the whole folder out of the `redteam` image — the nightly used to carry all of it to AWS every
night for no reason, because the image copies `promptfoo/` whole.

What the nightly genuinely shares with this work lives one level up, in [`../lib`](../lib): `filter.ts` (the
deterministic oracle that decides whether a quiz was contaminated — no model grades a model), `ptes-data.ts`,
`sample.ts` and `readmes-ptes.ts`. The public-dataset stage imports those, so they are not research, they are library.

## `checks/` — re-run these when the guard changes

Each one measures the guard against every benign text in the repository and prints what it flagged or blocked. They are
regression checks, not studies: the bar for any change to the guard is that **neither count goes up on any set**.

| Script | Question it answers |
|---|---|
| `guard-fp.ts` | does the whole input guard (`inspectText`) block or flag a document that is innocent? |
| `topic-fp.ts` | does the topic check refuse a heading a real person would plausibly type as a topic? |
| `polite-check.ts` | do the polite rules fire on benign prose, and do they still catch the polite attacks? |
| `ptes-fp.ts` | do the keyword rules fire on real Portuguese and Spanish READMEs? |
| `detector-fp.ts` | how often does Llama Prompt Guard 2 flag a benign text, next to the keyword rules? |

They need data that is **not committed** (real READMEs, public datasets, the ONNX model), downloaded into the
git-ignored `.local/` by the fetchers in `studies/`. Each script's header says exactly what it wants and where.

## `studies/` — answered once, the answer is committed

These produced the evidence in [`docs/security`](../../../docs/security). The JSON and Markdown beside those reports
are the result; the script is the recipe that made it, kept so a number can be reproduced or challenged rather than
taken on trust.

| Script | What it established | Result |
|---|---|---|
| `replay.ts` + `render.ts` + `tables.ts` | dataset attacks that BOTH detectors miss, replayed through the real pipeline | `replay-deepset.json` / `.md` |
| `detector-prep.ts` | does preparing the text before the classifier remove false positives without losing recall? | `detector-prep.json` / `.md` |
| `topic-check.ts` | is a quiz really about the document, and about the topic when one is set? | `topic-check.json` |
| `ptes-datasets.ts`, `ptes-replay.ts`, `ptes-report.ts` | Portuguese and Spanish attacks from public datasets, through the guard and then the whole pipeline | `replay-ptes.json` |
| `fetch-ptes-datasets.ts`, `fetch-real-readmes.ts` | download the corpora the checks and the studies need, verifying every sha256 | `.local/` (texts are never committed) |
| `readmes.ts`, `real-readmes.ts` | the benign documents the attacks are hidden inside, and the manifest of the real ones | — |
