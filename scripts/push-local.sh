#!/usr/bin/env bash
# Pushes the locally built images to ECR under a given tag (default local-1). For first-time validation only:
# the pipeline pushes the real arm64 images tagged with the commit sha.
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p .local; exec > .local/push.log 2>&1
export AWS_PROFILE="${AWS_PROFILE:-turboai-615737882760}" AWS_REGION="${AWS_REGION:-us-east-2}"
TAG="${1:-local-1}"
REG="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$AWS_REGION.amazonaws.com"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REG"
for s in api worker web; do
  docker tag quizforge-$s:local "$REG/quizforge/$s:$TAG"
  docker push -q "$REG/quizforge/$s:$TAG" && echo "pushed $s:$TAG"
done
echo PUSH_DONE
