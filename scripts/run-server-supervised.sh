#!/usr/bin/env bash
# 프로덕션 서버를 감시하다가 죽으면 자동으로 다시 띄우는 supervisor 루프.
# 이 실행 환경은 PID 1이 docker-init인 컨테이너라 systemd(deploy/web-agent-manager.service)의
# Restart=on-failure도, cron @reboot도, 도커 재시작 정책도 쓸 수 없어 tmux pane 안의 이 루프가 그 역할을 대신한다.
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${WAM_APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
# npm/npx/Volta shim 대신 실제 Node 실행 파일을 직접 쓴다. shim PID만 추적하면 종료 뒤 실제 서버가
# 고아로 남을 수 있으므로, override가 없을 때 현재 node가 보고하는 process.execPath를 기본값으로 쓴다.
NODE_BIN="${WAM_NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  NODE_COMMAND="$(command -v node || true)"
  if [ -n "$NODE_COMMAND" ] && [ -x "$NODE_COMMAND" ]; then
    NODE_BIN="$("$NODE_COMMAND" -p 'process.execPath' 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then NODE_BIN="$NODE_COMMAND"; fi
  fi
fi
ENTRY="$APP_DIR/dist/server/src/server/index.js"
RUN_DIR="${WAM_RUN_DIR:-$APP_DIR/data/supervisor}"
PID_FILE="$RUN_DIR/server.pid"
STOP_FLAG="$RUN_DIR/server.stop"
LOG_FILE="$RUN_DIR/server.log"
RESTART_DELAY="${WAM_RESTART_DELAY:-3}"
HEALTH_INTERVAL="${WAM_HEALTH_INTERVAL:-5}"
HEALTH_FAIL_LIMIT="${WAM_HEALTH_FAIL_LIMIT:-3}"
STARTUP_TIMEOUT="${WAM_STARTUP_TIMEOUT:-60}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf '실행 가능한 Node를 찾지 못했다. WAM_NODE_BIN에 절대경로를 지정하세요.\n' >&2
  exit 1
fi

# 서버 설정은 process.cwd()를 rootDir로 삼아 데이터·프로젝트 경로를 계산하므로 반드시 앱 폴더에서 실행한다.
cd "$APP_DIR" || exit 1
mkdir -p "$RUN_DIR"

export NODE_ENV=production
export WEB_AGENT_MANAGER_HOST="${WEB_AGENT_MANAGER_HOST:-0.0.0.0}"
export WEB_AGENT_MANAGER_PORT="${WEB_AGENT_MANAGER_PORT:-14003}"

log() { printf '%s [supervisor] %s\n' "$(date -Is)" "$1" | tee -a "$LOG_FILE"; }

# 프로세스 생존만으로는 부족하다. 서버가 SIGTERM을 받으면 server.close() 콜백이 열린 WebSocket 때문에
# 끝나지 않아, 리스너만 닫힌 채 프로세스가 매달리는 상태가 실제로 발생한다(서비스는 죽었는데 PID는 살아있음).
# 그래서 헬스 응답을 살아있음의 기준으로 삼는다.
health_ok() { curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${WEB_AGENT_MANAGER_PORT}/health"; }

# 종료를 기다리다 grace 시간이 지나면 SIGKILL로 확실히 정리한다(위의 hang 때문에 SIGTERM만으로는 부족하다).
stop_child() {
  local pid="$1" waited=0
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "정상 종료가 끝나지 않아 강제 종료한다 pid=$pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
}

if [ ! -f "$ENTRY" ]; then
  log "빌드 산출물이 없다: $ENTRY (npm run build 필요)"
  exit 1
fi

# 지난 중지 요청이 남아 새 기동을 곧바로 끝내버리지 않도록 시작 시 플래그를 지운다.
if [ -f "$STOP_FLAG" ]; then
  rm -f "$STOP_FLAG"
  log "이전 중지 플래그를 정리했다."
fi

# 루프 자체가 종료 신호를 받으면 감시 중인 서버도 같이 정리한다(고아 프로세스 방지).
child=""
terminate() {
  log "종료 신호를 받아 서버를 정리한다."
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    stop_child "$child"
    wait "$child" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  exit 0
}
trap terminate INT TERM

log "감시 시작 host=$WEB_AGENT_MANAGER_HOST port=$WEB_AGENT_MANAGER_PORT entry=$ENTRY"
log "중지하려면: touch $STOP_FLAG 후 서버 프로세스 종료"

while true; do
  # 서버 로그를 pane과 파일에 함께 남기되, $!가 tee가 아닌 node의 PID가 되도록 프로세스 치환을 쓴다.
  "$NODE_BIN" "$ENTRY" > >(tee -a "$LOG_FILE") 2>&1 &
  child=$!
  echo "$child" > "$PID_FILE"
  log "서버 시작 pid=$child"

  # 프로세스 생존과 헬스 응답을 함께 감시한다. 기동 중에는 STARTUP_TIMEOUT까지 기다려 주고,
  # 한 번이라도 정상 응답한 뒤에는 연속 실패가 한계를 넘을 때 죽은 것으로 판정해 정리한다.
  serving=0
  fails=0
  waited=0
  while kill -0 "$child" 2>/dev/null; do
    if health_ok; then
      if [ "$serving" -eq 0 ]; then
        serving=1
        log "헬스 응답 확인 pid=$child"
      fi
      fails=0
    elif [ "$serving" -eq 1 ]; then
      fails=$((fails + 1))
      if [ "$fails" -ge "$HEALTH_FAIL_LIMIT" ]; then
        log "헬스 응답이 ${fails}회 연속 실패해 정리 후 재시작한다 pid=$child"
        stop_child "$child"
        break
      fi
    else
      waited=$((waited + HEALTH_INTERVAL))
      if [ "$waited" -ge "$STARTUP_TIMEOUT" ]; then
        log "${STARTUP_TIMEOUT}초 안에 헬스가 열리지 않아 정리 후 재시작한다 pid=$child"
        stop_child "$child"
        break
      fi
    fi
    sleep "$HEALTH_INTERVAL"
  done

  wait "$child" 2>/dev/null
  status=$?
  child=""
  rm -f "$PID_FILE"
  log "서버 종료 exit=$status"

  # 되살리기를 멈추는 유일한 신호는 중지 플래그다. 플래그 없이 죽은 것은 크래시나 외부 종료로 보고 다시 띄운다.
  if [ -f "$STOP_FLAG" ]; then
    log "중지 플래그를 확인해 재시작하지 않고 감시를 끝낸다."
    exit 0
  fi

  log "${RESTART_DELAY}초 뒤 재시작한다."
  sleep "$RESTART_DELAY"
done
