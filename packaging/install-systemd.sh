#!/usr/bin/env bash
set -euo pipefail

# 애플리케이션 빌드/설치부터 systemd 서비스 등록·기동까지 한 번에 끝낸다.
# root 권한(sudo)이 필요하다 — 시스템 사용자 생성과 /etc/systemd/system 등록 때문이다.
if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' "root 권한이 필요합니다: sudo bash packaging/install-systemd.sh" >&2
  exit 1
fi

# install.sh와 같은 방식으로 저장소 루트를 찾는다(압축 zip에서 평평해진 경우와
# git 저장소에서 packaging/ 안에 있는 경우 둘 다 지원).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  ROOT_DIR="$SCRIPT_DIR"
else
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

SERVICE_USER="${WEB_AGENT_MANAGER_SERVICE_USER:-web-agent-manager}"
ENV_DIR="/etc/web-agent-manager"
ENV_FILE="$ENV_DIR/web-agent-manager.env"
UNIT_FILE="/etc/systemd/system/web-agent-manager.service"

printf '%s\n' "[1/5] 애플리케이션 설치(빌드·의존성) — $ROOT_DIR"
bash "$ROOT_DIR/packaging/install.sh"

printf '%s\n' "[2/5] 전용 시스템 사용자 준비 ($SERVICE_USER)"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$ROOT_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$ROOT_DIR"

printf '%s\n' "[3/5] 환경변수 파일 준비 ($ENV_FILE)"
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  printf '%s\n' "  새로 생성됨 — 필요한 값을 채운 뒤 'systemctl restart web-agent-manager'로 반영하세요."
else
  printf '%s\n' "  이미 있어 그대로 둠."
fi

printf '%s\n' "[4/5] systemd 유닛 등록"
# deploy/web-agent-manager.service는 /opt/web-agent-manager를 예시 경로로 고정해두므로,
# 실제 설치 위치(ROOT_DIR)로 치환해 어디에 설치하든 그대로 동작하게 한다.
sed "s#/opt/web-agent-manager#$ROOT_DIR#g" "$ROOT_DIR/deploy/web-agent-manager.service" > "$UNIT_FILE"
systemctl daemon-reload

printf '%s\n' "[5/5] 서비스 활성화·기동"
systemctl enable --now web-agent-manager
sleep 1
systemctl status --no-pager web-agent-manager || true

printf '\n%s\n' "설치 완료. 로그 확인: journalctl -u web-agent-manager -f"
