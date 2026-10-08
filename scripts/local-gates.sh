#!/usr/bin/env bash
# Runs the security/consistency gates of the CI locally. Output: .local/gates.log
set -u
cd "$(dirname "$0")/.."
mkdir -p .local; exec > .local/gates.log 2>&1
export PATH="$HOME/.npm-global/bin:$PATH"

echo "=== 1. schema/migration drift"
pnpm --filter @quizforge/db db:generate 2>&1 | tail -2
if [ -n "$(git status --porcelain -- packages/db)" ]; then echo "DRIFT"; git status --porcelain -- packages/db; else echo "GATE1 PASS (no drift)"; fi

echo "=== 2. gitleaks (history + working tree)"
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.21.2 detect --source /repo --redact 2>&1 | tail -6
echo "GATE2 exit=${PIPESTATUS[0]}"

echo "=== 3. trivy config (terraform)"
docker run --rm -v "$PWD:/src" aquasec/trivy:0.58.1 config --severity HIGH,CRITICAL --ignorefile /src/.trivyignore /src/infra 2>&1 | tail -80
echo "GATE3 done"

echo "=== 4. trivy images"
for s in api worker web; do
  echo "--- $s"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/.trivyignore:/.trivyignore:ro" aquasec/trivy:0.58.1 image --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /.trivyignore quizforge-$s:local 2>&1 | tail -40
done
echo GATES_DONE
