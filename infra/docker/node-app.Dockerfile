# One image per Node service (web, worker, pii-vault, provider-mocks), selected with --build-arg APP.
# Base images are pinned by digest. pnpm comes from corepack, pinned by package.json packageManager.
ARG NODE_IMAGE=node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ASTRO_TELEMETRY_DISABLED=1 \
    CI=true
WORKDIR /repo

# Fetch dependencies from the lockfile alone, so source edits keep this layer cached.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm version comes from package.json "packageManager"; this layer stays cached until it changes.
RUN corepack enable && corepack install
RUN --mount=type=cache,id=omnibridge-pnpm-store,target=/pnpm-store \
    pnpm fetch --store-dir /pnpm-store

COPY . .
# --ignore-scripts: no dependency build scripts are allowed (pnpm-workspace.yaml) and the root
# "prepare" (git hooks) has no place in an image.
RUN --mount=type=cache,id=omnibridge-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --offline --ignore-scripts --store-dir /pnpm-store

ARG APP
# deploy installs exactly the lockfile versions, but pnpm 12 fetches registry metadata for its
# supply-chain check on the deployed lockfile, so this step is not --offline.
RUN --mount=type=cache,id=omnibridge-pnpm-store,target=/pnpm-store \
    --mount=type=cache,id=omnibridge-pnpm-meta,target=/root/.cache/pnpm \
    test -n "$APP" \
 && pnpm --filter "@omnibridge/${APP}..." run build \
 && pnpm --filter "@omnibridge/${APP}" deploy --prod --frozen-lockfile --ignore-scripts \
      --store-dir /pnpm-store /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out ./
USER node
CMD ["node", "dist/main.js"]
