# Public site (ADR-003b): Astro static build served by static-web-server. Both pinned by digest.
ARG NODE_IMAGE=node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
ARG SWS_IMAGE=ghcr.io/static-web-server/static-web-server:2.44.1-alpine@sha256:2fe3e5c0a20691f23fb270338578c8d31b5f7a19abb308c4c1ec901a7eefbe2e

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ASTRO_TELEMETRY_DISABLED=1 \
    CI=true
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm version comes from package.json "packageManager"; this layer stays cached until it changes.
RUN corepack enable && corepack install
RUN --mount=type=cache,id=omnibridge-pnpm-store,target=/pnpm-store \
    pnpm fetch --store-dir /pnpm-store
COPY . .
RUN --mount=type=cache,id=omnibridge-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --offline --ignore-scripts --store-dir /pnpm-store \
 && pnpm --filter @omnibridge/site run build

FROM ${SWS_IMAGE} AS runtime
COPY --from=build --chown=root:root /repo/apps/site/dist /public
ENV SERVER_PORT=8080 \
    SERVER_ROOT=/public \
    SERVER_HEALTH=true \
    SERVER_LOG_LEVEL=warn
