#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

read -r -p "관리자 아이디: " WEB_AGENT_MANAGER_ADMIN_USERNAME
read -r -s -p "관리자 비밀번호(12자 이상): " WEB_AGENT_MANAGER_ADMIN_PASSWORD
printf '\n'
export WEB_AGENT_MANAGER_ADMIN_USERNAME WEB_AGENT_MANAGER_ADMIN_PASSWORD
export WEB_AGENT_MANAGER_DATA_DIR="${WEB_AGENT_MANAGER_DATA_DIR:-${MYAGENT_DATA_DIR:-$ROOT_DIR/data}}"
node dist/server/scripts/create-admin.js
unset WEB_AGENT_MANAGER_ADMIN_USERNAME WEB_AGENT_MANAGER_ADMIN_PASSWORD
