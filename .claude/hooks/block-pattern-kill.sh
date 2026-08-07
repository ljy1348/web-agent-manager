#!/usr/bin/env bash
# 커맨드라인 문자열로 프로세스를 찾아 죽이는 명령을 차단한다.
# myagent에서 이 방식으로 사용자 개발 서버를 세 번 죽였다(2026-08-05 두 번, 2026-08-06 한 번).
# tsx watch가 spawn한 실제 서버 자식 프로세스는 커맨드라인에 "tsx watch"가 없어
# `grep -v "tsx watch"` 같은 필터를 통과해 함께 죽는다.
set -uo pipefail

command_text=$(jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$command_text" ] && exit 0

deny() {
  jq -cn --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# pkill·killall은 그 자체가 패턴 매칭 kill이라 무조건 차단한다.
if printf '%s' "$command_text" | grep -qE '(^|[;&|`(]|[[:space:]])(pkill|killall)([[:space:]]|$)'; then
  deny "pkill·killall은 myagent에서 금지입니다(사용자 개발 서버를 3회 죽인 원인). 내가 띄운 서버의 PID를 파일에 남겨두고 그 PID만 kill하세요. 생존 확인은 curl http://127.0.0.1:14003/health 가 200인지로만 합니다."
fi

# pgrep / ps|grep 으로 찾은 결과를 kill·xargs로 넘기는 조합도 같은 사고다.
if printf '%s' "$command_text" | grep -qE '(pgrep|ps[[:space:]][^|]*\|[^|]*grep)' \
  && printf '%s' "$command_text" | grep -qE '(^|[;&|`(]|[[:space:]])(kill|xargs)([[:space:]]|$)'; then
  deny "이름으로 프로세스를 찾아 kill하는 명령은 myagent에서 금지입니다(pgrep|kill, ps|grep|kill 포함). tsx watch의 자식 서버 프로세스가 필터를 통과해 함께 죽습니다. PID 파일에 기록해둔 PID만 kill하세요."
fi

exit 0
