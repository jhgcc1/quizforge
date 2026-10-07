#!/usr/bin/env bash
cd "$(dirname "$0")/.."; mkdir -p .local
export PATH="$HOME/.npm-global/bin:$PATH"
pnpm --filter @quizforge/evals eval > .local/eval-live.log 2>&1
echo "EXIT=$?" >> .local/eval-live.log
