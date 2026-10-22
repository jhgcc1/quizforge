# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f worker/Dockerfile -t quizforge-worker .
# current Node 22 LTS patch release; the Trivy gate in CI fails the build on fixable HIGH/CRITICAL findings
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@10.34.6 && pnpm config set store-dir /pnpm-store
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --filter @quizforge/worker...
RUN pnpm --filter @quizforge/worker deploy --prod --legacy /out

FROM node:${NODE_VERSION}-slim AS runtime
# security patches for the OS packages of the base image (Trivy gate: no fixable HIGH/CRITICAL)
RUN apt-get update && apt-get -y --no-install-recommends upgrade && rm -rf /var/lib/apt/lists/*
# the runtime never installs packages: dropping npm/corepack removes their bundled dependencies (and CVEs) from the image
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production HEALTH_PORT=8081
WORKDIR /app
# AWS RDS CA bundle: lets node-postgres verify the database certificate (sslmode=verify-full)
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# in-flight jobs get SHUTDOWN_GRACE_MS to finish after SIGTERM (ECS stopTimeout must be larger)
CMD ["node", "--import", "tsx", "src/main.ts"]

# ---- the worker plus the semantic injection detector: Meta's Llama Prompt Guard 2 86M (multilingual), ONNX, run by transformers.js.
#   docker build -f worker/Dockerfile --target runtime-detector -t quizforge-worker:detector .
# The image is about 1.6 GB bigger and needs about 3 GB of memory (4 GB in Fargate). THE MODEL IS BAKED IN at build time
# (/models/prompt-guard-2, INJECTION_DETECTOR_MODEL_DIR), so a running task never downloads 1.1 GB and works with no network.
# Run it with INJECTION_DETECTOR=flag (record only) or block (reject the document). Built with Llama: THIRD_PARTY_NOTICES.md.
FROM build AS detector-build
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --filter @quizforge/detector...
RUN pnpm --filter @quizforge/detector deploy --prod --legacy /detector-out

FROM runtime AS runtime-detector
USER root
# Model: the ungated ONNX conversion of meta-llama/Llama-Prompt-Guard-2-86M (the official repo is gated and has no ONNX).
# Pinned to one commit AND to the sha256 of every file (ADD --checksum fails the build on a mismatch; model.onnx and
# tokenizer.json hashes are the lfs.sha256 of the Hugging Face API). The weights are never stored in git. fp32 on purpose:
# the quantized file (model.quant.onnx) recalls far less. Layout expected by transformers.js: <dir>/onnx/model.onnx.
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
COPY --from=detector-build --chown=node:node /detector-out /app/node_modules/@quizforge/detector
ENV INJECTION_DETECTOR_MODEL_DIR=/models/prompt-guard-2 HF_HUB_OFFLINE=1
USER node

# Which target goes where (the CI publish job builds both from this file):
#   runtime           -> tag `<sha>-slim`: the SCORER service and the SWEEPER task. Neither reads a user's
#                        document, so neither loads the detector; this saves them pulling about 1.6 GB.
#   runtime-detector  -> tag `<sha>`: the GENERATE service, the only role that screens text a user supplied.
# keep the production image the DEFAULT target (docker build without --target builds the last stage)
FROM runtime AS release
