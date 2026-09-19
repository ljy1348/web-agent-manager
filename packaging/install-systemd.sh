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

# zip은 packaging/을 최상위로 평탄화하므로 install.sh는 이 스크립트와 같은 폴더에 있다.
if [[ -f "$SCRIPT_DIR/install.sh" ]]; then
  INSTALL_SH="$SCRIPT_DIR/install.sh"
elif [[ -f "$ROOT_DIR/packaging/install.sh" ]]; then
  INSTALL_SH="$ROOT_DIR/packaging/install.sh"
else
  printf '%s\n' "install.sh를 찾지 못했습니다." >&2
  exit 1
fi

SERVICE_USER="${WEB_AGENT_MANAGER_SERVICE_USER:-web-agent-manager}"
ENV_DIR="${WEB_AGENT_MANAGER_ENV_DIR:-/etc/web-agent-manager}"
ENV_FILE="$ENV_DIR/web-agent-manager.env"
UNIT_FILE="${WEB_AGENT_MANAGER_UNIT_FILE:-/etc/systemd/system/web-agent-manager.service}"

# zip에는 deploy/가 없으므로 저장소 유닛 파일이 없으면 같은 내용을 내장 템플릿으로 쓴다.
write_unit_file() {
  local src="" candidate
  for candidate in "$ROOT_DIR/deploy/web-agent-manager.service" "$SCRIPT_DIR/web-agent-manager.service" "$ROOT_DIR/web-agent-manager.service"; do
    if [[ -f "$candidate" ]]; then src="$candidate"; break; fi
  done
  if [[ -n "$src" ]]; then
    sed "s#/opt/web-agent-manager#$ROOT_DIR#g" "$src" > "$UNIT_FILE"
    return
  fi
  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Codex and Claude Web Agent Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=web-agent-manager
Group=web-agent-manager
WorkingDirectory=$ROOT_DIR
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node $ROOT_DIR/dist/server/src/server/index.js
Restart=on-failure
RestartSec=5
KillMode=process
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
}

# zip에는 .env.example이 없을 수 있어, 없으면 기동에 필요한 최소값을 쓴다.
write_env_file() {
  local src="" candidate
  for candidate in "$ROOT_DIR/.env.example" "$SCRIPT_DIR/.env.example"; do
    if [[ -f "$candidate" ]]; then src="$candidate"; break; fi
  done
  if [[ -n "$src" ]]; then
    cp "$src" "$ENV_FILE"
    return
  fi
  cat > "$ENV_FILE" <<'ENV'
WEB_AGENT_MANAGER_PORT=4317
WEB_AGENT_MANAGER_HOST=127.0.0.1
WEB_AGENT_MANAGER_DATA_DIR=./data
WEB_AGENT_MANAGER_PROJECTS_DIR=
WEB_AGENT_MANAGER_ALLOWED_ROOTS=
WEB_AGENT_MANAGER_PUBLIC_URL=http://127.0.0.1:4317
ENV
}

printf '%s\n' "[1/5] 애플리케이션 설치(빌드·의존성) — $ROOT_DIR"
bash "$INSTALL_SH"

printf '%s\n' "[2/5] 전용 시스템 사용자 준비 ($SERVICE_USER)"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$ROOT_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$ROOT_DIR"

printf '%s\n' "[3/5] 환경변수 파일 준비 ($ENV_FILE)"
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  write_env_file
  chmod 600 "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  printf '%s\n' "  새로 생성됨 — 필요한 값을 채운 뒤 'systemctl restart web-agent-manager'로 반영하세요."
else
  printf '%s\n' "  이미 있어 그대로 둠."
fi

printf '%s\n' "[4/5] systemd 유닛 등록"
# deploy/web-agent-manager.service는 /opt/web-agent-manager를 예시 경로로 고정해두므로,
# 실제 설치 위치(ROOT_DIR)로 치환해 어디에 설치하든 그대로 동작하게 한다.
write_unit_file
systemctl daemon-reload

printf '%s\n' "[5/5] 서비스 활성화·기동"
systemctl enable --now web-agent-manager
sleep "${WEB_AGENT_MANAGER_SYSTEMD_WAIT:-1}"
if ! systemctl is-active --quiet web-agent-manager; then
  systemctl status --no-pager web-agent-manager || true
  printf '%s\n' "web-agent-manager 서비스가 활성 상태가 아닙니다." >&2
  exit 1
fi
systemctl status --no-pager web-agent-manager

printf '\n%s\n' "설치 완료. 로그 확인: journalctl -u web-agent-manager -f"
