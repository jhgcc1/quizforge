#!/usr/bin/env bash
# Checks out the front end (https://github.com/jhgcc1/quizforge-web) at the commit pinned in web.ref into ./web (git-ignored).
# Idempotent. Prints the SHA. Bump the front end by changing web.ref in a pull request.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${WEB_REPO_URL:-https://github.com/jhgcc1/quizforge-web}"
SHA="$(tr -d '[:space:]' < web.ref)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "web.ref must contain a 40-character commit SHA" >&2; exit 1; }
if [ ! -d web/.git ]; then
  rm -rf web
  git init -q web
  git -C web remote add origin "$REPO"
fi
git -C web remote set-url origin "$REPO"
git -C web fetch -q --depth 1 origin "$SHA" 2>/dev/null || git -C web fetch -q origin
git -C web checkout -q --detach "$SHA"
echo "$SHA"
