#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export NODE_ENV=production
export WEB_AGENT_MANAGER_HOST="${WEB_AGENT_MANAGER_HOST:-${MYAGENT_HOST:-127.0.0.1}}"
export WEB_AGENT_MANAGER_PORT="${WEB_AGENT_MANAGER_PORT:-${MYAGENT_PORT:-4317}}"
export WEB_AGENT_MANAGER_DATA_DIR="${WEB_AGENT_MANAGER_DATA_DIR:-${MYAGENT_DATA_DIR:-$ROOT_DIR/data}}"

printf '%s\n' "web-agent-manager: http://${WEB_AGENT_MANAGER_HOST}:${WEB_AGENT_MANAGER_PORT}"
exec node dist/server/src/server/index.js
