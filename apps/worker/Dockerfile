# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/worker/Dockerfile -t quizforge-worker .
ARG NODE_VERSION=22.12.0
FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@10.34.6 && pnpm config set store-dir /pnpm-store
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --filter @quizforge/worker...
RUN pnpm --filter @quizforge/worker deploy --prod --legacy /out

FROM node:${NODE_VERSION}-slim AS runtime
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
