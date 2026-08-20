#!/usr/bin/env bash
set -euo pipefail

# 배포 zip(npm run release:package)에서는 packaging/ 스크립트들이 zip 최상위로 평평하게
# 풀려 이 파일 위치 = 앱 루트이지만, git 저장소를 그대로 쓰면 이 파일은 여전히 packaging/
# 안에 있다. package.json이 옆에 없으면 한 단계 위(저장소 루트)를 앱 루트로 본다.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  ROOT_DIR="$SCRIPT_DIR"
else
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# Debian/Ubuntu·root·apt-get이 모두 갖춰진 경우에만 apt로 자동 설치한다 — 그 밖의
# 환경(macOS, 비root, apt 없는 배포판)에서는 임의로 시스템을 건드리지 않고 안내만 한다.
APT_UPDATED=0
can_apt_install() {
  [[ "$(uname -s)" == "Linux" ]] && [[ "$(id -u)" -eq 0 ]] && command -v apt-get >/dev/null 2>&1
}
apt_install_once() {
  if [[ "$APT_UPDATED" -eq 0 ]]; then
    apt-get update -qq
    APT_UPDATED=1
  fi
  apt-get install -y --no-install-recommends "$@" >/dev/null
}

# 필수 실행 파일이 PATH에 있는지 확인한다. 없고 apt로 자동 설치 가능하면 바로 설치하고,
# 아니면 설치 안내와 함께 중단한다.
require_command() {
  local command_name="$1"
  local apt_package="$2"
  local install_hint="$3"
  if command -v "$command_name" >/dev/null 2>&1; then return; fi
  if [[ -n "$apt_package" ]] && can_apt_install; then
    printf '%s\n' "$command_name이(가) 없어 apt로 자동 설치합니다: $apt_package"
    apt_install_once "$apt_package"
    if command -v "$command_name" >/dev/null 2>&1; then return; fi
  fi
  printf '%s\n' "$command_name 명령이 필요합니다. $install_hint" >&2
  exit 1
}

# Debian/Ubuntu 기본 apt 저장소의 nodejs는 보통 22보다 낮아(예: Ubuntu 24.04 기본은 18)
# 그냥 apt install로는 버전 요구사항을 못 맞춘다. NodeSource 공식 22.x 저장소를 등록한
# 뒤에 설치한다.
ensure_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    return
  fi
  if can_apt_install; then
    printf '%s\n' "Node.js 22 이상이 없어 NodeSource 저장소로 자동 설치합니다."
    apt-get install -y --no-install-recommends ca-certificates curl gnupg >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y --no-install-recommends nodejs >/dev/null
  fi
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' "Node.js 22 이상을 설치하세요: https://nodejs.org/" >&2
    exit 1
  fi
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    printf '%s\n' "Node.js 22 이상이 필요합니다. 현재 버전: $(node --version)" >&2
    exit 1
  fi
}
ensure_node
require_command npm "" "Node.js 22 이상을 설치하세요: https://nodejs.org/"
if [[ "$(uname -s)" == "Darwin" ]]; then
  require_command tmux "" "Homebrew 사용 시: brew install tmux"
else
  require_command tmux tmux "Debian/Ubuntu 사용 시: sudo apt install tmux"
fi
require_command git git "Debian/Ubuntu 사용 시: sudo apt install git"
require_command gh gh "Debian/Ubuntu 사용 시: sudo apt install gh (또는 https://cli.github.com/ 참고)"
# node-pty 등 네이티브 모듈은 이 환경용 prebuild가 없으면 npm이 그 자리에서 컴파일을
# 시도한다(실측: linux-x64인데도 prebuild 미존재로 빌드 전환). 미리 확인해 gyp 에러
# 대신 명확한 안내를 주거나(가능하면) 바로 설치한다.
require_command python3 python3 "Debian/Ubuntu 사용 시: sudo apt install python3"
require_command make build-essential "Debian/Ubuntu 사용 시: sudo apt install build-essential"
require_command g++ build-essential "Debian/Ubuntu 사용 시: sudo apt install build-essential"

cd "$ROOT_DIR"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [[ -f dist/server/src/server/index.js ]]; then
  printf '%s\n' "web-agent-manager v${PACKAGE_VERSION} production 의존성을 설치합니다."
  npm ci --omit=dev
else
  # 배포 zip과 달리 git 저장소는 dist/가 미리 빌드돼 있지 않다 — devDependencies까지
  # 설치해 소스를 직접 빌드한다.
  printf '%s\n' "빌드된 dist/가 없어 web-agent-manager v${PACKAGE_VERSION}을 소스에서 빌드합니다."
  npm ci
  npm run build
fi
mkdir -p data
chmod 700 data
export WEB_AGENT_MANAGER_DATA_DIR="${WEB_AGENT_MANAGER_DATA_DIR:-${MYAGENT_DATA_DIR:-$ROOT_DIR/data}}"
printf '%s\n' "설치된 Claude·Codex 연동을 확인합니다."
node dist/server/scripts/install-agent-integrations.js
printf '\n%s\n' "설치 완료"
printf '%s\n' "개별 실행: ./create-admin.sh 후 ./run.sh"
