# syntax=docker/dockerfile:1.7
# The NIGHTLY RED TEAM task (see docs/redteam-nightly.md). Build context: repository root.
#   docker build -f docker/redteam/Dockerfile -t quizforge-redteam .
# One-shot task (no server, no health check): the entrypoint is scripts/redteam-nightly-aws.sh. It runs the promptfoo red team suite against
# the real pipeline and the real model, writes a report to S3 and exits (non-zero when a canary leaked).
# The semantic detector is the SAME as in production: Meta's Llama Prompt Guard 2 86M, baked in like the worker image's runtime-detector target.
# Needs about 3 GB of memory (4 GB in Fargate). Built with Llama: THIRD_PARTY_NOTICES.md.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@10.34.6 && pnpm config set store-dir /pnpm-store
WORKDIR /repo
COPY . .
# only what the promptfoo suite needs (the suite, the guard and prompts of core and llm, the AWS SDK for the report upload)
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --prod --filter @quizforge/promptfoo...
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --prod --filter @quizforge/detector...
RUN pnpm --filter @quizforge/detector deploy --prod --legacy /detector-out
# (overrides.basic-ftp: a transitive dependency of promptfoo with a fixed HIGH CVE-2026-102990, Trivy gate; the red team never uses FTP)
# promptfoo at the version pinned in scripts/promptfoo.sh (one place for the number), installed once here so the nightly task downloads nothing
RUN version="$(sed -n 's/.*PROMPTFOO_VERSION:-\([0-9][0-9.]*\)}.*/\1/p' scripts/promptfoo.sh)" \
 && test -n "$version" && echo "promptfoo $version" \
 && mkdir -p /opt/promptfoo && cd /opt/promptfoo && npm init -y >/dev/null && npm pkg set overrides.basic-ftp=6.2.1 && npm install --no-audit --no-fund "promptfoo@$version" \
 && echo "$version" > /opt/promptfoo/VERSION

FROM node:${NODE_VERSION}-slim AS runtime
# security patches for the OS packages of the base image (Trivy gate: no fixable HIGH/CRITICAL)
RUN apt-get update && apt-get -y --no-install-recommends upgrade && rm -rf /var/lib/apt/lists/*
# the scripts call `pnpm exec tsx`; npm itself is not needed at run time (its bundled dependencies are removed with it)
RUN npm install -g pnpm@10.34.6 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn* /root/.npm
ENV NODE_ENV=production PROMPTFOO_BIN=/opt/promptfoo/node_modules/.bin/promptfoo
# `pnpm exec tsx` runs from the repo root, but tsx is installed in the promptfoo workspace package: put its bin folder on PATH
ENV PATH=/app/promptfoo/node_modules/.bin:$PATH
WORKDIR /app
# AWS RDS CA bundle is NOT needed: this task never talks to the database.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/tsconfig.base.json ./
COPY --from=build --chown=node:node /repo/packages ./packages
COPY --from=build --chown=node:node /repo/promptfoo ./promptfoo
COPY --from=build --chown=node:node /repo/scripts/promptfoo.sh /repo/scripts/redteam-nightly-aws.sh ./scripts/
COPY --from=build --chown=node:node /opt/promptfoo /opt/promptfoo
COPY --from=build --chown=node:node /detector-out /app/node_modules/@quizforge/detector

# Model: the ungated ONNX conversion of meta-llama/Llama-Prompt-Guard-2-86M (the official repo is gated and has no ONNX). Pinned to one commit
# AND to the sha256 of every file, exactly as in apps/worker/Dockerfile (runtime-detector): ADD --checksum fails the build on a mismatch.
# fp32 on purpose (the quantized file recalls far less). Layout expected by transformers.js: <dir>/onnx/model.onnx.
ARG PG2_REV=45a05fbd5337a864edc608f994911f009c37ca57
ARG PG2_URL=https://huggingface.co/gravitee-io/Llama-Prompt-Guard-2-86M-onnx/resolve/${PG2_REV}
# (the folders are made first: ADD would create them with the file mode, 644, which nobody can open)
RUN mkdir -p /models/prompt-guard-2/onnx
ADD --chmod=644 --checksum=sha256:a39ae60b9b718b72bbe3f359ad07ddf6909dcb09ccff936c00a488ceb4e983a6 ${PG2_URL}/config.json /models/prompt-guard-2/config.json
ADD --chmod=644 --checksum=sha256:870798f0e3bb05c636bf62be904b2d8f48ace4785e9c1d71a8a67bd0586c941d ${PG2_URL}/tokenizer.json /models/prompt-guard-2/tokenizer.json
ADD --chmod=644 --checksum=sha256:d5cff0d149f1084504aa8cbdd941289a011ec7f027519feb49e397c58b564398 ${PG2_URL}/tokenizer_config.json /models/prompt-guard-2/tokenizer_config.json
ADD --chmod=644 --checksum=sha256:b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21 ${PG2_URL}/special_tokens_map.json /models/prompt-guard-2/special_tokens_map.json
ADD --chmod=644 --checksum=sha256:fbe0be6a471873b6c52f7d6631c16fbddb88ba8c7ab2ba34ca48e8e77ffd9999 ${PG2_URL}/model.onnx /models/prompt-guard-2/onnx/model.onnx
# the licence text and NOTICE travel with the weights (Llama 4 Community License, redistribution terms)
ADD --chmod=644 --checksum=sha256:90ae4807183070953bd8da5d7be81c4494920fb54c74359383c8a4536bf003c3 ${PG2_URL}/LICENSE /models/prompt-guard-2/LICENSE
ADD --chmod=644 --checksum=sha256:6d70b1303958ace2c652d10ffcb63cdd8436d49bc0e81c97373df4e329fad0c9 ${PG2_URL}/NOTICE /models/prompt-guard-2/NOTICE
ENV INJECTION_DETECTOR_MODEL_DIR=/models/prompt-guard-2 HF_HUB_OFFLINE=1

# the run writes under promptfoo/out (results, reports); the commit is passed by the build so the report can name it
RUN mkdir -p /app/promptfoo/out && chown -R node:node /app/promptfoo/out
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA} HOME=/home/node
USER node
CMD ["scripts/redteam-nightly-aws.sh"]
