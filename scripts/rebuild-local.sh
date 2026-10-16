#!/usr/bin/env bash
# Rebuild the three images and (re)start the containerized stack. Output goes to .local/rebuild.log
set -u
cd "$(dirname "$0")/.."
mkdir -p .local
exec > .local/rebuild.log 2>&1
docker compose --profile app down --remove-orphans
scripts/web.sh   # checks out the main of the front end into ./web
for s in api worker web; do
  start=$(date +%s)
  if [ "$s" = web ]; then dockerfile=web/Dockerfile; ctx=web; else dockerfile=apps/$s/Dockerfile; ctx=.; fi
  if docker build -q -f $dockerfile -t quizforge-$s:local $ctx; then echo "$s image OK ($(( $(date +%s)-start ))s)"; else echo "$s image FAILED"; exit 1; fi
done
docker compose --profile app up -d
sleep 25
docker compose --profile app ps -a --format '{{.Service}} {{.Status}}'
echo REBUILD_DONE
