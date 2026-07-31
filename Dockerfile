FROM node:22-bookworm-slim AS builder

WORKDIR /opt/web-agent-manager-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG CODEX_VERSION=0.146.0
ARG CLAUDE_CODE_VERSION=2.1.220

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gh gosu openssh-client procps ripgrep tmux \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && groupadd --gid 10001 wam \
  && useradd --uid 10001 --gid wam --create-home --shell /bin/bash wam

WORKDIR /app
COPY --from=builder /opt/web-agent-manager-build/dist ./dist
COPY --from=builder /opt/web-agent-manager-build/node_modules ./node_modules
COPY --from=builder /opt/web-agent-manager-build/skills ./skills
COPY --from=builder /opt/web-agent-manager-build/package.json ./package.json
COPY docker/entrypoint.sh /usr/local/bin/web-agent-manager-entrypoint

RUN chmod 0755 /usr/local/bin/web-agent-manager-entrypoint \
  && mkdir -p /data /workspace \
  && chown wam:wam /data /workspace /home/wam

ENV NODE_ENV=production \
  HOME=/home/wam \
  WEB_AGENT_MANAGER_HOST=0.0.0.0 \
  WEB_AGENT_MANAGER_PORT=4317 \
  WEB_AGENT_MANAGER_PUBLIC_URL=http://localhost:4317 \
  WEB_AGENT_MANAGER_DATA_DIR=/data \
  WEB_AGENT_MANAGER_PROJECTS_DIR=/workspace \
  WEB_AGENT_MANAGER_ALLOWED_ROOTS=/workspace

VOLUME ["/data", "/workspace", "/home/wam"]
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl --fail --silent http://127.0.0.1:4317/health > /dev/null || exit 1
ENTRYPOINT ["web-agent-manager-entrypoint"]
CMD ["node", "dist/server/src/server/index.js"]
