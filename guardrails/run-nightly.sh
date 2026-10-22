#!/usr/bin/env bash
# The nightly red team run: the entrypoint of the `redteam` Fargate task (guardrails/promptfoo/Dockerfile). Also runnable by hand.
#
#   1. runs guardrails/run-suite.sh redteam-nightly: a fresh set of attacks against the real pipeline and the real model (canary part, with the
#      base64 / rot13 / leetspeak encodings on a subset), then a seeded sample of PUBLIC prompt-injection datasets (REDTEAM_PUBLIC=0 skips it);
#   2. ALWAYS (even if a canary leaked) writes summary.json, report.html and new-failures.json (+ public-unflagged.json, redteam-public.json);
#   3. prints CloudWatch metrics in Embedded Metric Format on stdout (namespace QuizForge, Service=redteam) and a WARN line per finding on stderr;
#   4. with REPORT_BUCKET: uploads to s3://$REPORT_BUCKET/redteam/$RUN_ID/ (never overwritten) and updates redteam/latest/;
#      with ALARM_TOPIC_ARN and a leak: publishes one message (link to the report) to the alarm topic;
#      without REPORT_BUCKET (a local run): keeps the files in guardrails/promptfoo/out/nightly/$RUN_ID/ and skips AWS.
#
# THE NIGHTLY REPORTS, IT DOES NOT FAIL. A canary leak, a contaminated quiz, a blocked-language document that reached the model, an attack no
# layer flagged: each is a CloudWatch metric, a WARN line and an entry in the report, and the alarms (metric based) turn them into alerts.
# None of them changes the exit code, so the "redteam-run-missing" alarm keeps meaning "the night did not run".
#
# Exit code: 0 = the run completed, the report was written (and uploaded, with REPORT_BUCKET), whatever it found;
#            2 = the upload failed; 3 = the run produced no results or the report could not be written; 1 = no model key / the harness crashed.
#
# Environment: MINIMAX_API_KEY (required), REPORT_BUCKET, ALARM_TOPIC_ARN, REDTEAM_NUM_TESTS (texts per intent, default 10),
#              REDTEAM_ENCODED_PER_INTENT (texts per intent that are also encoded three ways, default 3), REDTEAM_PUBLIC (0 = skip the public datasets),
#              REDTEAM_PUBLIC_PER_GROUP (25), REDTEAM_PUBLIC_PER_GROUP_BLOCKED (15), REDTEAM_PUBLIC_MODEL_CASES (40), REDTEAM_PUBLIC_BENIGN (60),
#              REDTEAM_PUBLIC_FOREIGN (20), REDTEAM_PUBLIC_ENCODED (10 per encoding),
#              REDTEAM_SEED, REDTEAM_CONCURRENCY, REDTEAM_DETECTOR_MODE, INJECTION_DETECTOR_MODEL_DIR, GIT_SHA, MINIMAX_MODEL.
set -uo pipefail
cd "$(dirname "$0")/.."

RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export REDTEAM_NUM_TESTS="${REDTEAM_NUM_TESTS:-10}"
version="${PROMPTFOO_VERSION:-0.124.1}"
OUT="guardrails/promptfoo/out/nightly/${RUN_ID}"
RESULTS="guardrails/promptfoo/out/redteam-nightly.json"
GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
if [ -n "${INJECTION_DETECTOR_MODEL_DIR:-}" ]; then detector="${REDTEAM_DETECTOR_MODE:-block} (Llama Prompt Guard 2 86M)"; else detector="off"; fi

echo "red team nightly ${RUN_ID}: ${REDTEAM_NUM_TESTS} texts per intent, ${REDTEAM_ENCODED_PER_INTENT:-3} encoded per intent, public datasets $([ "${REDTEAM_PUBLIC:-1}" = 0 ] && echo off || echo on), detector ${detector}, commit ${GIT_SHA}" >&2
mkdir -p guardrails/promptfoo/out "$OUT"
rm -f "$RESULTS"

# 1. the run. A non-zero code here is a broken harness (findings never make it non-zero): the report below says what was produced, so keep going.
timeout "${REDTEAM_MAX_MINUTES:-180}m" guardrails/run-suite.sh redteam-nightly # a hung run must not bill for ever
run_code=$?
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ -s "$RESULTS" ] || { echo "promptfoo wrote no results (exit ${run_code})" >&2; echo '{"results":{"results":[]}}' > "$RESULTS"; }

# 2. the report (summary.json, report.html, new-failures.json) and the metrics lines
known=()
[ -f guardrails/promptfoo/redteam/known-failures.json ] && known=(--known guardrails/promptfoo/redteam/known-failures.json)
pnpm exec tsx guardrails/promptfoo/redteam/nightly-report.ts "$RESULTS" --out-dir "$OUT" --run-id "$RUN_ID" --started "$STARTED" --finished "$FINISHED" \
  --git-sha "$GIT_SHA" --model "${MINIMAX_MODEL:-MiniMax-M2.7}" --detector "$detector" --promptfoo-version "$version" --num-tests "$REDTEAM_NUM_TESTS" "${known[@]}" > "$OUT/metrics.emf"
report_code=$?
if [ $report_code -ne 0 ]; then echo "the report could not be written" >&2; exit 3; fi
cp "$RESULTS" "$OUT/redteam-nightly.json"
# 2b. the encodings table and the public dataset section (summary.json, report.html, new-failures.json are extended; new metrics are printed).
#     Findings are WARN lines on stderr and metrics: they never change the exit code. If this step itself breaks, the report above is still uploaded.
PUBLIC_RESULTS=guardrails/promptfoo/out/redteam-public.json
extras=()
[ -s "$PUBLIC_RESULTS" ] && extras=(--public "$PUBLIC_RESULTS" --public-build guardrails/promptfoo/out/public/build.json)
gen=(); [ -f guardrails/promptfoo/out/nightly/generation.json ] && gen=(--generation guardrails/promptfoo/out/nightly/generation.json)
pnpm exec tsx guardrails/promptfoo/redteam/nightly-extras.ts --dir "$OUT" --nightly "$RESULTS" "${gen[@]}" "${extras[@]}" > "$OUT/metrics-extra.emf" || { echo "WARN the extra report sections could not be written (the base report is intact)" >&2; : > "$OUT/metrics-extra.emf"; }
cat "$OUT/metrics-extra.emf" >> "$OUT/metrics.emf"
[ -s "$PUBLIC_RESULTS" ] && cp "$PUBLIC_RESULTS" "$OUT/redteam-public.json"
cases="$(node -p "require('./$OUT/summary.json').cases")"
leaks="$(node -p "require('./$OUT/summary.json').leaked")"

# a run with no cases did not test anything: no RedteamRuns datapoint, so the "run missing" alarm fires
if [ "$cases" -gt 0 ]; then cat "$OUT/metrics.emf"; else echo "no cases were run: no metrics emitted" >&2; fi

# 3. AWS: S3 (run folder + latest pointer) and the alarm topic
publish_code=0
if [ -n "${REPORT_BUCKET:-}" ]; then
  topic=(); [ -n "${ALARM_TOPIC_ARN:-}" ] && topic=(--topic "$ALARM_TOPIC_ARN")
  pnpm exec tsx guardrails/promptfoo/redteam/nightly-publish.ts --bucket "$REPORT_BUCKET" --run-id "$RUN_ID" --dir "$OUT" "${topic[@]}" --extra "$OUT/redteam-nightly.json" $([ -f "$OUT/redteam-public.json" ] && echo "$OUT/redteam-public.json") $([ -f "$OUT/public-unflagged.json" ] && echo "$OUT/public-unflagged.json") || publish_code=$?
else
  echo "REPORT_BUCKET is not set: local run, nothing was uploaded. Files: ${OUT}/" >&2
fi

echo "red team ${RUN_ID}: ${cases} cases, ${leaks} leaked (reported, not failed)" >&2
[ "$publish_code" -ne 0 ] && exit 2
[ "$cases" -eq 0 ] && exit 3
exit 0 # a leak or any other finding is a metric and a report entry, not a failure of the night
