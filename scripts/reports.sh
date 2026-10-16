#!/usr/bin/env bash
# Rebuild the committed reports, then show what changed (`git diff --stat docs/`).
#   scripts/reports.sh
# The architecture report needs .local/links.json (resource ids of the AWS account, git-ignored), so it is rebuilt on the
# maintainer's machine; the committed copy is the REDACTED one (no account ids, no e-mail, no screenshots).
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter @quizforge/evals report            # docs/eval/structure-comparison.html, from the committed JSON
(cd site && python3 build.py --guardrails --public)   # docs/security/guardrails-promptfoo.html (no AWS account needed)
if [ -f .local/links.json ]; then
  (cd site && python3 build.py --public && python3 build.py --full --public)   # docs/architecture/quizforge-architecture.html (short) and -full.html
else
  echo "skipped the architecture report: .local/links.json is missing (it holds the AWS account's resource ids)"
fi
git status --short docs
