#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 필수 실행 파일이 PATH에 있는지 확인하고 설치 안내와 함께 중단한다.
require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s\n' "$command_name 명령이 필요합니다. $install_hint" >&2
    exit 1
  fi
}

require_command node "Node.js 22 이상을 설치하세요: https://nodejs.org/"
require_command npm "Node.js 22 이상을 설치하세요: https://nodejs.org/"
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  printf '%s\n' "Node.js 22 이상이 필요합니다. 현재 버전: $(node --version)" >&2
  exit 1
fi
if [[ "$(uname -s)" == "Darwin" ]]; then
  require_command tmux "Homebrew 사용 시: brew install tmux"
else
  require_command tmux "Debian/Ubuntu 사용 시: sudo apt install tmux"
fi

cd "$ROOT_DIR"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
printf '%s\n' "web-agent-manager v${PACKAGE_VERSION} production 의존성을 설치합니다."
npm ci --omit=dev
mkdir -p data
chmod 700 data
export WEB_AGENT_MANAGER_DATA_DIR="${WEB_AGENT_MANAGER_DATA_DIR:-${MYAGENT_DATA_DIR:-$ROOT_DIR/data}}"
printf '%s\n' "설치된 Claude·Codex 연동을 확인합니다."
node dist/server/scripts/install-agent-integrations.js
printf '\n%s\n' "설치 완료"
printf '%s\n' "개별 실행: ./create-admin.sh 후 ./run.sh"
