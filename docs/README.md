# Reports

Every report is **one HTML file** with its charts inside (no server, no build step to read it). Open it in a browser; print to PDF from the browser if you need a PDF.

| # | Report | File | What it covers |
|---|---|---|---|
| 1 | **Architecture and decisions** | [architecture/quizforge-architecture.html](architecture/quizforge-architecture.html) | Everything: AWS, pipeline, protocols, the scoring service, input security and promptfoo, Langfuse, limits, improvements, glossary |
| 2 | **Structure comparison** | [eval/structure-comparison.html](eval/structure-comparison.html) (raw numbers: [structure-comparison.json](eval/structure-comparison.json)) | Which generation structure and prompt works best: 9 variants × 5 documents, with Langfuse run links |
| 3 | **Security benchmark** (planned) | `docs/security/` | The guard and the model against public prompt-injection datasets, with false positives. Not built yet |

## What is left out of the committed architecture report

The page is the same as the local one (screenshots included), with one change: the **AWS account id** is replaced by `<account-id>`. Passwords, keys and tokens are never in it: the build refuses to write the page if any value from the git-ignored env files (`.env`, `.local/e2e-user.env`) appears in it.

## Regenerating

```bash
scripts/reports.sh        # rebuilds both committed reports, then `git diff --stat docs/` shows what changed
```

* Structure comparison: rendered from `docs/eval/structure-comparison.json` by `pnpm --filter @quizforge/evals report`. New numbers come from `pnpm --filter @quizforge/evals compare` (calls the real model, about $0.8) and are then merged into the JSON.
* Architecture: the generator is in `site/` (`build.py`, `content.py`, `diagrams.py`, `lib.py`, `langfuse.py`: Python, no dependencies). It reads the resource ids in `.local/links.json` and the real Langfuse trace through `.env` (both git-ignored), so it runs on the maintainer's machine. `python3 site/build.py` writes the full local page (`site/quizforge-architecture.html`, git-ignored); `--public` writes the committed copy here (account id removed). The page is part of the change that it describes: update it in the same PR as the code.
