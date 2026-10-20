# syntax=docker/dockerfile:1.7

# ---------- build the admin UI and install production dependencies ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY web ./web
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.304
ARG CODEX_VERSION=0.163.0
ARG GEMINI_CLI_VERSION=0.64.0
ARG INSTALL_CURSOR=true

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq ripgrep python3 openssh-client tini gnupg \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Pin versions with the build args above.
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
 && npm cache clean --force

# Custom agents (e.g. `myClaude`) go in /opt/agents/bin, which is on PATH.
RUN mkdir -p /data /opt/agents/bin && chown -R node:node /data /opt/agents

USER node
ENV HOME=/home/node
# Cursor CLI installs `agent` into ~/.local/bin.
RUN if [ "$INSTALL_CURSOR" = "true" ]; then curl -fsSL https://cursor.com/install | bash && ~/.local/bin/agent --version; fi

WORKDIR /app
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/web/dist ./web/dist
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    AGENTS_CONFIG=/app/config/agents.yaml \
    PATH=/opt/agents/bin:/home/node/.local/bin:$PATH

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
