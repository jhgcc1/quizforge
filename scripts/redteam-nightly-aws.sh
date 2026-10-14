#!/usr/bin/env bash
# The nightly red team run: the entrypoint of the `redteam` Fargate task (docker/redteam/Dockerfile). Also runnable by hand.
#
#   1. runs scripts/promptfoo.sh redteam-nightly (a fresh set of attacks against the real pipeline and the real model);
#   2. ALWAYS (even if a canary leaked) writes summary.json, report.html and new-failures.json;
#   3. prints CloudWatch metrics in Embedded Metric Format on stdout (namespace QuizForge, Service=redteam);
#   4. with REPORT_BUCKET: uploads to s3://$REPORT_BUCKET/redteam/$RUN_ID/ (never overwritten) and updates redteam/latest/;
#      with ALARM_TOPIC_ARN and a leak: publishes one message (link to the report) to the alarm topic;
#      without REPORT_BUCKET (a local run): keeps the files in promptfoo/out/nightly/$RUN_ID/ and skips AWS.
#
# Exit code: 0 = no canary leaked; 1 = a canary leaked (after the upload); 2 = the upload failed; 3 = the run produced no results.
#
# Environment: MINIMAX_API_KEY (required), REPORT_BUCKET, ALARM_TOPIC_ARN, REDTEAM_NUM_TESTS (texts per intent, default 10),
#              REDTEAM_SEED, REDTEAM_CONCURRENCY, REDTEAM_DETECTOR_MODE, INJECTION_DETECTOR_MODEL_DIR, GIT_SHA, MINIMAX_MODEL.
set -uo pipefail
cd "$(dirname "$0")/.."

RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export REDTEAM_NUM_TESTS="${REDTEAM_NUM_TESTS:-10}"
version="${PROMPTFOO_VERSION:-0.124.1}"
OUT="promptfoo/out/nightly/${RUN_ID}"
RESULTS="promptfoo/out/redteam-nightly.json"
GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
if [ -n "${INJECTION_DETECTOR_MODEL_DIR:-}" ]; then detector="${REDTEAM_DETECTOR_MODE:-block} (Llama Prompt Guard 2 86M)"; else detector="off"; fi

echo "red team nightly ${RUN_ID}: ${REDTEAM_NUM_TESTS} texts per intent, detector ${detector}, commit ${GIT_SHA}" >&2
mkdir -p promptfoo/out "$OUT"
rm -f "$RESULTS"

# 1. the run. It may exit non-zero (a leak, or any failed case): the report below tells which, so keep going.
timeout "${REDTEAM_MAX_MINUTES:-150}m" scripts/promptfoo.sh redteam-nightly # a hung run must not bill for ever
run_code=$?
FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ -s "$RESULTS" ] || { echo "promptfoo wrote no results (exit ${run_code})" >&2; echo '{"results":{"results":[]}}' > "$RESULTS"; }

# 2. the report (summary.json, report.html, new-failures.json) and the metrics lines
known=()
[ -f promptfoo/redteam/known-failures.json ] && known=(--known promptfoo/redteam/known-failures.json)
pnpm exec tsx promptfoo/redteam/nightly-report.ts "$RESULTS" --out-dir "$OUT" --run-id "$RUN_ID" --started "$STARTED" --finished "$FINISHED" \
  --git-sha "$GIT_SHA" --model "${MINIMAX_MODEL:-MiniMax-M2.7}" --detector "$detector" --promptfoo-version "$version" --num-tests "$REDTEAM_NUM_TESTS" "${known[@]}" > "$OUT/metrics.emf"
report_code=$?
if [ $report_code -ne 0 ]; then echo "the report could not be written" >&2; exit 3; fi
cp "$RESULTS" "$OUT/redteam-nightly.json"
cases="$(node -p "require('./$OUT/summary.json').cases")"
leaks="$(node -p "require('./$OUT/summary.json').leaked")"

# a run with no cases did not test anything: no RedteamRuns datapoint, so the "run missing" alarm fires
if [ "$cases" -gt 0 ]; then cat "$OUT/metrics.emf"; else echo "no cases were run: no metrics emitted" >&2; fi

# 3. AWS: S3 (run folder + latest pointer) and the alarm topic
publish_code=0
if [ -n "${REPORT_BUCKET:-}" ]; then
  topic=(); [ -n "${ALARM_TOPIC_ARN:-}" ] && topic=(--topic "$ALARM_TOPIC_ARN")
  pnpm exec tsx promptfoo/redteam/nightly-publish.ts --bucket "$REPORT_BUCKET" --run-id "$RUN_ID" --dir "$OUT" "${topic[@]}" --extra "$OUT/redteam-nightly.json" || publish_code=$?
else
  echo "REPORT_BUCKET is not set: local run, nothing was uploaded. Files: ${OUT}/" >&2
fi

echo "red team ${RUN_ID}: ${cases} cases, ${leaks} leaked" >&2
[ "$publish_code" -ne 0 ] && exit 2
[ "$leaks" -gt 0 ] && exit 1
[ "$cases" -eq 0 ] && exit 3
exit 0
