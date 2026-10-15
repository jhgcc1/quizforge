#!/usr/bin/env bash
# Run a promptfoo suite (CI and local).
#   scripts/promptfoo.sh offline          no model, no secrets: input guard, language policy, topic validation, prompt safety rules (89 tests)
#   scripts/promptfoo.sh live             the real MiniMax model (needs MINIMAX_API_KEY): prompt injection and agent purpose (20 tests)
#   scripts/promptfoo.sh redteam-sample   the 50 FROZEN red team attacks (en, pt, es) + the language policy group: the offline stage always,
#                                         and the live stage when MINIMAX_API_KEY is set. Fails if a canary leaks.
#   scripts/promptfoo.sh redteam-nightly  a FRESH, larger red team set (needs MINIMAX_API_KEY): REDTEAM_NUM_TESTS texts per intent (default 10,
#                                         32 intents, 2 cases per text: about 640 tests), REDTEAM_SEED to repeat a run, REDTEAM_CONCURRENCY (default 6). Writes promptfoo/out/nightly/, fails if a canary leaked, saves new failures.
#   scripts/promptfoo.sh redteam-generate regenerate promptfoo/out/redteam-generated.yaml from the red team config (step of the sample recipe)
# Optional for the red team suites: INJECTION_DETECTOR_MODEL_DIR (semantic detector stage, through @quizforge/detector).
# promptfoo needs Node >= 22.22. The version is pinned here so a new release cannot change the gate by itself.
set -euo pipefail
suite="${1:?usage: promptfoo.sh offline|live|redteam-sample|redteam-nightly|redteam-generate}"
cd "$(dirname "$0")/.."

export PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_SHARING=1
# red team generation never goes to promptfoo's servers: the attacker model is MiniMax (see promptfoo/redteam/redteam.config.yaml)
export PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION=true
version="${PROMPTFOO_VERSION:-0.124.1}"
# PROMPTFOO_BIN: a promptfoo that is already installed (the redteam image bakes it in, so a nightly task downloads nothing)
pf() { if [ -n "${PROMPTFOO_BIN:-}" ]; then "$PROMPTFOO_BIN" "$@"; else npx -y "promptfoo@${version}" "$@"; fi; }
mkdir -p promptfoo/out
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

# run one eval config; keeps going so the caller can report before failing
eval_config() { # config output extra-args...
  local config="$1" out="$2"; shift 2
  set +e
  pf eval -c "$config" --no-cache --no-progress-bar --no-table "$@" -o "$out"
  local code=$?
  set -e
  return $code
}

case "$suite" in
  offline|live)
    if [ "$suite" = offline ]; then config=guard; extra=(); else config=live; extra=(-j 3); fi
    code=0
    eval_config "promptfoo/${config}.yaml" "promptfoo/out/${suite}.json" "${extra[@]}" || code=$?
    # a readable table for the job summary (or the terminal)
    node promptfoo/summary.mjs "$suite" >> "$summary" || true
    exit $code
    ;;

  redteam-generate)
    pf redteam generate -c promptfoo/redteam/redteam.config.yaml -o promptfoo/out/redteam-generated.yaml --force --no-cache
    ;;

  redteam-sample)
    code=0
    eval_config promptfoo/redteam/sample-offline.yaml promptfoo/out/redteam-sample-offline.json || code=$?
    node promptfoo/summary.mjs redteam-sample-offline >> "$summary" || true
    pnpm exec tsx promptfoo/redteam/report.ts promptfoo/out/redteam-sample-offline.json --label "frozen sample, offline stage (guard, language policy, fake model)" >> "$summary" || code=$?
    if [ -n "${MINIMAX_API_KEY:-}" ]; then
      eval_config promptfoo/redteam/sample-live.yaml promptfoo/out/redteam-sample-live.json -j 3 || code=$?
      node promptfoo/summary.mjs redteam-sample-live >> "$summary" || true
      pnpm exec tsx promptfoo/redteam/report.ts promptfoo/out/redteam-sample-live.json --label "frozen sample, live stage (real model)" >> "$summary" || code=$?
    else
      echo "MINIMAX_API_KEY is not set: the live stage of the red team sample was skipped" >&2
      echo "_The live stage was skipped (no MINIMAX_API_KEY)._" >> "$summary"
    fi
    exit $code
    ;;

  redteam-nightly)
    : "${MINIMAX_API_KEY:?redteam-nightly needs MINIMAX_API_KEY (attacker and target model)}"
    per="${REDTEAM_NUM_TESTS:-10}"
    seed="${REDTEAM_SEED:-$(date +%Y%m%d)}"
    dir=promptfoo/out/nightly
    mkdir -p "$dir"; find "$dir" -maxdepth 1 -type f -delete # the files of the last run; the run folders (reports) stay
    # 1. fresh attack texts: REDTEAM_NUM_TESTS paraphrases of EVERY intent (the 12 base ones and the product-specific ones of
    #    intents-nightly.ts), canaries and markup checked by code
    pnpm exec tsx promptfoo/redteam/build-intents-nightly.ts --mode fresh --per-intent "$per" --seed "$seed" --out "$dir"
    # 2. promptfoo applies the strategies (plain and jailbreak templates, see redteam.nightly.yaml) to them
    sed "s#promptfoo/redteam/intents.json#${dir}/intents.json#" promptfoo/redteam/redteam.nightly.yaml > promptfoo/redteam/redteam.nightly.generated.yaml
    pf redteam generate -c promptfoo/redteam/redteam.nightly.generated.yaml -o "${dir}/generated.yaml" --force --no-cache
    # 3. our tests (deterministic assertions, metadata), every generated case kept; then the nightly layout and assertions
    pnpm exec tsx promptfoo/redteam/curate.ts --in "${dir}/generated.yaml" --meta "${dir}/intents.meta.json" --out "${dir}/tests.yaml" --all
    pnpm exec tsx promptfoo/redteam/nightly-tests.ts "${dir}/tests.yaml"
    # 4. run them against the pipeline with the real model
    code=0
    eval_config promptfoo/redteam/nightly-live.yaml promptfoo/out/redteam-nightly.json -j "${REDTEAM_CONCURRENCY:-6}" || code=$?
    known=()
    [ -f promptfoo/redteam/known-failures.json ] && known=(--known promptfoo/redteam/known-failures.json)
    pnpm exec tsx promptfoo/redteam/report.ts promptfoo/out/redteam-nightly.json --label "nightly (seed ${seed}, ${per} texts per intent)" --failures "${dir}/new-failures.json" "${known[@]}" | tee -a "$summary" || code=$?
    exit $code
    ;;

  *) echo "unknown suite: $suite" >&2; exit 2 ;;
esac
