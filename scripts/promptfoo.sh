#!/usr/bin/env bash
# Run a promptfoo suite (CI and local).
#   scripts/promptfoo.sh offline   no model, no secrets: input guard, language policy, topic validation, prompt safety rules
#   scripts/promptfoo.sh live      the real MiniMax model (needs MINIMAX_API_KEY): prompt injection and agent purpose
# promptfoo needs Node >= 22.22. The version is pinned here so a new release cannot change the gate by itself.
set -euo pipefail
suite="${1:?usage: promptfoo.sh offline|live}"
cd "$(dirname "$0")/.."

export PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_SHARING=1
version="${PROMPTFOO_VERSION:-0.124.1}"
case "$suite" in
  offline) config=guard; extra=() ;;
  live)    config=live; extra=(-j 3) ;;
  *) echo "unknown suite: $suite" >&2; exit 2 ;;
esac

mkdir -p promptfoo/out
set +e
npx -y "promptfoo@${version}" eval -c "promptfoo/${config}.yaml" --no-cache --no-progress-bar --no-table "${extra[@]}" -o "promptfoo/out/${suite}.json"
code=$?
set -e

# a readable table for the job summary (or the terminal)
node promptfoo/summary.mjs "$suite" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}" || true
exit $code
