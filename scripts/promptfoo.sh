#!/usr/bin/env bash
# Run a promptfoo suite (CI and local).
#   scripts/promptfoo.sh offline          no model, no secrets: input guard, language policy, topic validation, prompt safety rules (89 tests)
#   scripts/promptfoo.sh live             the real MiniMax model (needs MINIMAX_API_KEY): prompt injection and agent purpose (20 tests)
#   scripts/promptfoo.sh redteam-sample   the 50 FROZEN red team attacks (en, pt, es) + the language policy group: the offline stage always,
#                                         and the live stage when MINIMAX_API_KEY is set. Fails if a canary leaks.
#   scripts/promptfoo.sh redteam-nightly  a FRESH, larger red team set (needs MINIMAX_API_KEY): REDTEAM_NUM_TESTS texts per intent (default 10,
#                                         32 intents, 2 cases per text: about 640 tests) plus the encodings (base64, rot13, leetspeak) on
#                                         REDTEAM_ENCODED_PER_INTENT texts per intent (default 3), REDTEAM_SEED to repeat a run, REDTEAM_CONCURRENCY
#                                         (default 6), and then the public dataset part (redteam-public; REDTEAM_PUBLIC=0 skips it). Writes
#                                         promptfoo/out/nightly/ and saves new failures. THE NIGHTLY REPORTS, IT DOES NOT FAIL: a canary leak or any
#                                         other finding is a metric, a WARN line and a report entry, never an exit code. It exits non-zero only
#                                         when the run itself is broken (no key, promptfoo crashed, the report cannot be written).
#   scripts/promptfoo.sh redteam-public   the public dataset part alone (network; the real model only for stage B and the encoded cases): a seeded
#                                         daily sample of public prompt-injection datasets, by dataset and language (see docs/redteam-nightly.md).
#                                         Also reports, never fails on a finding.
#   scripts/promptfoo.sh redteam-generate regenerate promptfoo/out/redteam-generated.yaml from the red team config (step of the sample recipe)
# Optional for the red team suites: INJECTION_DETECTOR_MODEL_DIR (semantic detector stage, through @quizforge/detector).
# promptfoo needs Node >= 22.22. The version is pinned here so a new release cannot change the gate by itself.
set -euo pipefail
suite="${1:?usage: promptfoo.sh offline|live|redteam-sample|redteam-nightly|redteam-public|redteam-generate}"
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

# the public dataset part: reads the datasets (network), draws the seeded sample, runs it. Findings are reports, never exit codes:
# promptfoo exit 100 (a failed assertion = a broken harness case) is tolerated, the report counts the errors. Returns non-zero only if the build or promptfoo crashed.
public_part() {
  local pdir=promptfoo/out/public code=0
  mkdir -p "$pdir"; rm -f "$pdir/tests.yaml" "$pdir/build.json" promptfoo/out/redteam-public.json
  pnpm exec tsx promptfoo/redteam/public/build.ts --out "$pdir" || return $?
  eval_config promptfoo/redteam/public.yaml promptfoo/out/redteam-public.json -j "${REDTEAM_PUBLIC_CONCURRENCY:-4}" || code=$?
  [ "$code" -eq 100 ] && code=0
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
    enc="${REDTEAM_ENCODED_PER_INTENT:-3}"
    seed="${REDTEAM_SEED:-$(date +%Y%m%d)}"
    dir=promptfoo/out/nightly
    mkdir -p "$dir"; find "$dir" -maxdepth 1 -type f -delete # the files of the last run; the run folders (reports) stay
    rm -rf "$dir/encoded"
    # 1. fresh attack texts: REDTEAM_NUM_TESTS paraphrases of EVERY intent (the 12 base intents and the product-specific ones of
    #    intents-nightly.ts), canaries and markup checked by code
    pnpm exec tsx promptfoo/redteam/build-intents-nightly.ts --mode fresh --per-intent "$per" --seed "$seed" --out "$dir"
    # 2. promptfoo applies the strategies (plain and jailbreak templates, see redteam.nightly.yaml) to them
    sed "s#promptfoo/redteam/intents.json#${dir}/intents.json#" promptfoo/redteam/redteam.nightly.yaml > promptfoo/redteam/redteam.nightly.generated.yaml
    pf redteam generate -c promptfoo/redteam/redteam.nightly.generated.yaml -o "${dir}/generated.yaml" --force --no-cache
    # 2b. the encodings (base64, rot13, leetspeak) on a subset of the same texts: `enc` texts per intent, applied by promptfoo as in the frozen sample
    if [ "$enc" -gt 0 ]; then
      pnpm exec tsx promptfoo/redteam/nightly-encoded.ts subset --in "$dir" --out "${dir}/encoded" --per-intent "$enc" --seed "$seed"
      sed "s#promptfoo/redteam/intents.json#${dir}/encoded/intents.json#" promptfoo/redteam/redteam.nightly-encoded.yaml > promptfoo/redteam/redteam.nightly-encoded.generated.yaml
      pf redteam generate -c promptfoo/redteam/redteam.nightly-encoded.generated.yaml -o "${dir}/encoded/generated.yaml" --force --no-cache
    fi
    # 3. our tests (deterministic assertions, metadata), every generated case kept; then the nightly layout and assertions
    pnpm exec tsx promptfoo/redteam/curate.ts --in "${dir}/generated.yaml" --meta "${dir}/intents.meta.json" --out "${dir}/tests.yaml" --all
    pnpm exec tsx promptfoo/redteam/nightly-tests.ts "${dir}/tests.yaml"
    if [ "$enc" -gt 0 ]; then
      pnpm exec tsx promptfoo/redteam/nightly-encoded.ts tests --generated "${dir}/encoded/generated.yaml" --meta "${dir}/encoded/intents.meta.json" --tests "${dir}/tests.yaml"
    fi
    # 4. run them against the pipeline with the real model. A failed ASSERTION (promptfoo exit 100) is a finding, not a broken run: the report
    #    counts it and the metrics raise the alarm. Any other non-zero code is a broken harness and is returned.
    code=0
    eval_config promptfoo/redteam/nightly-live.yaml promptfoo/out/redteam-nightly.json -j "${REDTEAM_CONCURRENCY:-6}" || code=$?
    [ "$code" -eq 100 ] && code=0
    known=()
    [ -f promptfoo/redteam/known-failures.json ] && known=(--known promptfoo/redteam/known-failures.json)
    pnpm exec tsx promptfoo/redteam/report.ts promptfoo/out/redteam-nightly.json --no-fail --label "nightly (seed ${seed}, ${per} texts per intent, ${enc} encoded per intent)" --failures "${dir}/new-failures.json" "${known[@]}" | tee -a "$summary" || code=$?
    # 5. the public dataset part (REDTEAM_PUBLIC=0 skips it). It never stops the night: a broken public part is reported by the metrics.
    if [ "${REDTEAM_PUBLIC:-1}" != "0" ]; then
      public_part || echo "WARN the public dataset part failed to run (the nightly goes on; see the log above)" >&2
    else
      echo "REDTEAM_PUBLIC=0: the public dataset part was skipped" >&2
    fi
    exit $code
    ;;

  redteam-public)
    public_part
    pnpm exec tsx promptfoo/redteam/public/report.ts promptfoo/out/redteam-public.json promptfoo/out/public/build.json | tee -a "$summary"
    ;;

  *) echo "unknown suite: $suite" >&2; exit 2 ;;
esac
