# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/worker/Dockerfile -t quizforge-worker .
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

# ---- optional target: the worker plus the ONNX semantic injection detector (about 430 MB heavier, needs ~2 GB of memory).
#   docker build -f apps/worker/Dockerfile --target runtime-detector -t quizforge-worker:detector .
# then run it with INJECTION_DETECTOR=flag (record only) or block (reject the document). Production builds never use it.
FROM build AS detector-build
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --filter @quizforge/detector...
RUN pnpm --filter @quizforge/detector deploy --prod --legacy /detector-out

FROM runtime AS runtime-detector
USER root
COPY --from=detector-build --chown=node:node /detector-out /app/node_modules/@quizforge/detector
# the model (~740 MB) is downloaded on first use; keeping it on a volume at /hf-cache avoids downloading it again
RUN mkdir -p /hf-cache && chown node:node /hf-cache
ENV TRANSFORMERS_CACHE_DIR=/hf-cache
USER node

# keep the production image the DEFAULT target (docker build without --target builds the last stage)
FROM runtime AS release
