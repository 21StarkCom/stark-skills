# syntax=docker/dockerfile:1.7
# Multi-stage build. The runtime stage carries no toolchain — only the
# compiled native modules from the builder stage and the pre-built UI
# bundle from the ui-builder stage.

FROM node:22-alpine AS builder
WORKDIR /app
# `better-sqlite3` ships no prebuilt binaries for alpine on node 22.x;
# install the toolchain in a discardable virtual package so the runtime
# stage stays slim.
RUN apk add --no-cache --virtual .build-deps python3 make g++ gcc libc-dev
COPY package.json package-lock.json ./
RUN npm ci --build-from-source

# ---------- UI build stage (Phase 5) ----------
# Builds the Vite/React production bundle. The output `/ui-app/dist`
# is COPYed into the runtime stage and served by `@fastify/static` at
# `/`.
FROM node:22-alpine AS ui-builder
WORKDIR /ui-app
COPY ui/ ./
# Use `npm install` (not `npm ci`) so a fresh checkout without a
# lockfile still builds; once `package-lock.json` is committed the
# install resolves deterministically from it.
RUN npm install --no-audit --no-fund --include=dev \
 && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

# Dedicated `starkobs` identity (UID 10001) per plan §1.5.2 RT1 + E8.
# This is the IMAGE-DEFAULT user — used when the image is invoked
# directly (`docker run`) without a compose `user:` override and as
# the target of the Phase 2 RT1 acceptance path. The actual runtime
# UID for our compose deployment comes from `${OBSERVABILITY_UID}` in
# `tools/observability_server/.env` and is set by `user:` in
# docker-compose.yml (which overrides the image USER below).
#
# /data + /audit are pre-created at mode 0700 (image-side ownership
# doesn't matter — the compose `init` sidecar chowns both to the
# runtime UID/GID on every `up`, so the runtime user can write them
# whether it's 10001 or the host operator's UID).
RUN addgroup -g 10001 -S starkobs \
 && adduser  -u 10001 -S -G starkobs -H -h /nonexistent starkobs \
 && mkdir -p /data /audit /app/ui/dist \
 && chmod 0700 /data /audit \
 && chmod 0755 /app/ui /app/ui/dist

# tini reaps zombies if/when the server spawns helper processes.
RUN apk add --no-cache tini

COPY --from=builder    /app/node_modules /app/node_modules
COPY --from=ui-builder /ui-app/dist      /app/ui/dist
COPY server         /app/server
COPY migrations     /app/migrations
COPY package.json   /app/package.json
COPY tsconfig.json  /app/tsconfig.json

USER starkobs:starkobs

EXPOSE 7700 7701

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-strip-types", "server/index.ts"]
