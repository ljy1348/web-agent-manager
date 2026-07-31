#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$ROOT_DIR/install.sh"
printf '\n%s\n' "관리자 계정을 설정합니다."
"$ROOT_DIR/create-admin.sh"
printf '\n%s\n' "web-agent-manager를 시작합니다."
exec "$ROOT_DIR/run.sh"
