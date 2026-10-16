#!/usr/bin/env bash
# Checks out the front end (https://github.com/jhgcc1/quizforge-web) into ./web (git-ignored). Idempotent. Prints the SHA.
#
# By default it takes the MAIN of the front end, which is what production runs and what CI tests against: there is no pinned
# commit to keep in sync any more. WEB_REF=<sha|branch|tag> checks out something else, for reproducing a past state locally.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${WEB_REPO_URL:-https://github.com/jhgcc1/quizforge-web}"
REF="${WEB_REF:-main}"
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,128}$ ]] || { echo "WEB_REF has characters that are not allowed" >&2; exit 1; }
if [ ! -d web/.git ]; then
  rm -rf web
  git init -q web
  git -C web remote add origin "$REPO"
fi
git -C web remote set-url origin "$REPO"
git -C web fetch -q --depth 1 origin "$REF" 2>/dev/null || git -C web fetch -q origin
git -C web checkout -q --detach FETCH_HEAD 2>/dev/null || git -C web checkout -q --detach "$REF"
git -C web rev-parse HEAD
