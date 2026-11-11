# syntax=docker/dockerfile:1
# Container image for the catalog service.   Build from the REPO ROOT (it needs the shared packages):
#   docker build -f apps/catalog/Dockerfile -t scalecart/catalog .
#
# MULTI-STAGE: stage 1 has the compilers and dev tools; stage 2 (the image that runs) only has the
# compiled JavaScript + production dependencies -> smaller image, smaller attack surface.

# ---------- stage 1: build ----------
FROM node:20.19-alpine AS build
WORKDIR /repo

# Manifests first, sources later: Docker caches this layer, so `npm ci` only re-runs when a
# package.json or the lock file changes - not on every code change. (npm ci needs every
# workspace's package.json, because the lock file describes the whole monorepo.)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/service-kit/package.json packages/service-kit/
COPY packages/events/package.json packages/events/
COPY apps/gateway/package.json apps/gateway/
COPY apps/identity/package.json apps/identity/
COPY apps/catalog/package.json apps/catalog/
COPY apps/order/package.json apps/order/
COPY apps/payment/package.json apps/payment/
COPY apps/inventory/package.json apps/inventory/
COPY apps/notification/package.json apps/notification/
COPY apps/scalekv/package.json apps/scalekv/
COPY apps/scalelog/package.json apps/scalelog/
COPY tests/system/package.json tests/system/
RUN npm ci --no-audit --no-fund

COPY packages/ packages/
COPY apps/catalog/ apps/catalog/
# The Prisma client is generated code (git-ignored), so it is created during the build.
# Builds this app AND the shared packages it references (tsc -b follows the project references).
RUN npm run build -w @scalecart/catalog
# (This stage keeps the dev tools: docker-compose runs MIGRATIONS and SEEDS with `target: build`.)

# ---------- stage 2: production dependencies only ----------
FROM build AS prod-deps
# Drop dev dependencies (TypeScript, tsx, Prisma CLI, ...). --omit=optional too: the Prisma CLI and
# TypeScript are OPTIONAL PEERS of @prisma/client, which npm keeps with --omit=dev alone (found by
# simulating this build).
RUN npm prune --omit=dev --omit=optional --no-audit --no-fund

# ---------- stage 3: run ----------
FROM node:20.19-alpine
# tini = a tiny init process as PID 1: it forwards SIGTERM to node and reaps zombie processes.
# (Our services also handle SIGTERM themselves - graceful shutdown - see service-app.ts.)
RUN apk add --no-cache tini
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/package.json ./
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/service-kit/package.json packages/service-kit/
COPY --from=build /repo/packages/service-kit/dist packages/service-kit/dist
COPY --from=build /repo/packages/events/package.json packages/events/
COPY --from=build /repo/packages/events/dist packages/events/dist
COPY --from=build /repo/apps/catalog/package.json apps/catalog/
COPY --from=build /repo/apps/catalog/dist apps/catalog/dist

# Never run as root inside the container.
USER node
WORKDIR /repo/apps/catalog
EXPOSE 3006
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3006/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
