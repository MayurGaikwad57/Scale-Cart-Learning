# syntax=docker/dockerfile:1
# ONE Dockerfile for every ScaleCart app (build from the REPO ROOT - it needs the shared packages):
#   docker build --build-arg APP=payment --build-arg PORT=3002 -t scalecart/payment .
#   docker build --build-arg APP=scalekv --build-arg ENTRY=kv-server --build-arg PORT=6380 -t scalecart/scalekv .
# docker-compose.yml and the CI matrix pass these per service. (It replaced nine near-identical copies:
# copying them is how one image once got a COPY it didn't need and broke the build.)
#
# THREE STAGES:
#   build      all dependencies + compilers -> compile this app and the shared packages it uses
#              (docker-compose also runs MIGRATIONS and SEEDS in this stage: it has the Prisma CLI)
#   prod-deps  ONLY this app's production dependencies (npm ci -w): the gateway image no longer
#              carries Prisma, pg or bcrypt (measured: 15 MB of node_modules instead of 88 MB)
#   (final)    small runtime: compiled JavaScript + those dependencies, non-root, tini as PID 1

ARG NODE_IMAGE=node:20.19-alpine

# ---------- stage 1: build ----------
FROM ${NODE_IMAGE} AS build
# Prisma's migrate engine needs OpenSSL, which Alpine doesn't ship (migrations run in THIS stage).
RUN apk add --no-cache openssl
WORKDIR /repo
ARG APP
# Manifests first, sources later: Docker caches the `npm ci` layer until a package.json or the lock
# file changes. (npm ci needs EVERY workspace's package.json: the lock file describes the monorepo.)
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
RUN test -n "$APP" || (echo "build with --build-arg APP=<app>" && exit 1)
RUN npm ci --no-audit --no-fund
COPY packages/ packages/
COPY apps/${APP}/ apps/${APP}/
# Builds this app AND the shared packages it references (tsc -b follows the project references).
# Not every app uses every package (ScaleKV doesn't use events): make sure each dist folder exists.
RUN npm run build -w @scalecart/${APP} && mkdir -p packages/service-kit/dist packages/events/dist

# ---------- stage 2: this app's production dependencies only ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /repo
ARG APP
COPY package.json package-lock.json ./
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
# --omit=optional too: the Prisma CLI and TypeScript are OPTIONAL PEERS of @prisma/client and would
# otherwise stay. Folders npm may nest dependencies in must exist for the COPY below.
RUN npm ci --omit=dev --omit=optional -w @scalecart/${APP} --no-audit --no-fund \
 && mkdir -p apps/${APP}/node_modules packages/service-kit/node_modules packages/events/node_modules

# ---------- stage 3: run ----------
FROM ${NODE_IMAGE}
# tini = a tiny init process as PID 1: it forwards SIGTERM to node and reaps zombie processes.
# (Our services also handle SIGTERM themselves - graceful shutdown - see service-app.ts.)
RUN apk add --no-cache tini
ARG APP
ARG ENTRY=main
ARG PORT
# The HTTP health path; ScaleKV / ScaleLog speak RESP, not HTTP: built with HEALTH_PATH="" (no check).
ARG HEALTH_PATH=/health
ENV NODE_ENV=production \
    APP_ENTRY=${ENTRY} \
    HEALTH_PORT=${PORT} \
    HEALTH_PATH=${HEALTH_PATH}
WORKDIR /repo
COPY --from=prod-deps /repo/package.json ./
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/service-kit/package.json packages/service-kit/
COPY --from=build /repo/packages/service-kit/dist packages/service-kit/dist
COPY --from=prod-deps /repo/packages/service-kit/node_modules packages/service-kit/node_modules
COPY --from=build /repo/packages/events/package.json packages/events/
COPY --from=build /repo/packages/events/dist packages/events/dist
COPY --from=prod-deps /repo/packages/events/node_modules packages/events/node_modules
COPY --from=build /repo/apps/${APP}/package.json apps/${APP}/
COPY --from=build /repo/apps/${APP}/dist apps/${APP}/dist
COPY --from=prod-deps /repo/apps/${APP}/node_modules apps/${APP}/node_modules
# Writable data folder for the non-root user (ScaleLog keeps its partition files here - mount a
# volume on it in production, or a restart loses every event).
RUN mkdir -p /repo/apps/${APP}/data && chown node:node /repo/apps/${APP}/data

# Never run as root inside the container.
USER node
WORKDIR /repo/apps/${APP}
EXPOSE ${PORT}
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD [ -z "$HEALTH_PATH" ] || wget -qO- "http://127.0.0.1:${HEALTH_PORT}${HEALTH_PATH}" > /dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node dist/${APP_ENTRY}.js"]
