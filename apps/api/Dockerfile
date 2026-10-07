# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/api/Dockerfile -t quizforge-api .
# current Node 22 LTS patch release; the Trivy gate in CI fails the build on fixable HIGH/CRITICAL findings
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@10.34.6 && pnpm config set store-dir /pnpm-store
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --filter @quizforge/api...
# self-contained folder: prod dependencies + the workspace packages the API needs
RUN pnpm --filter @quizforge/api deploy --prod --legacy /out

FROM node:${NODE_VERSION}-slim AS runtime
# the runtime never installs packages: dropping npm/corepack removes their bundled dependencies (and CVEs) from the image
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn*
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# AWS RDS CA bundle: lets node-postgres verify the database certificate (sslmode=verify-full)
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
