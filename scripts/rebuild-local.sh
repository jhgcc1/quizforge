#!/usr/bin/env bash
# Rebuild the three images and (re)start the containerized stack. Output goes to .local/rebuild.log
set -u
cd "$(dirname "$0")/.."
mkdir -p .local
exec > .local/rebuild.log 2>&1
docker compose --profile app down --remove-orphans
for s in api worker web; do
  start=$(date +%s)
  if docker build -q -f apps/$s/Dockerfile -t quizforge-$s:local .; then echo "$s image OK ($(( $(date +%s)-start ))s)"; else echo "$s image FAILED"; exit 1; fi
done
docker compose --profile app up -d
sleep 25
docker compose --profile app ps -a --format '{{.Service}} {{.Status}}'
echo REBUILD_DONE
