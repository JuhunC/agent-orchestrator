# syntax=docker/dockerfile:1.7

# ---------- build the admin UI and install production dependencies ----------
# The Claude Agent SDK ships Claude Code as a per-platform package, so this stage
# runs once per target architecture and picks the matching binary.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY web ./web
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:24-bookworm-slim

# Tools agents commonly need while developing. Extend this image for project toolchains
# (e.g. FROM ghcr.io/juhunc/agent-orchestrator, then apt-get install golang).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq ripgrep python3 python3-venv openssh-client procps tini \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data /profiles && chown -R node:node /data /profiles

USER node
WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/web/dist ./web/dist
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node profiles ./profiles

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    PROFILES_DIR=/profiles \
    DEFAULT_PROFILES_DIR=/app/profiles \
    HOME=/home/node

VOLUME ["/data", "/profiles"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
