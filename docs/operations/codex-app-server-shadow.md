# Codex app-server shadow와 제한적 구조화 transport

작성일: 2026-09-12

## 목적과 안전 경계

기본 상태에서는 기존 Codex tmux/TUI 채팅의 실행 경로를 바꾸지 않는다. 현재 설치된 `codex-cli 0.153.4`가 생성한 experimental app-server schema를 버전별 계약 기준으로 삼아, 이미 연결된 Codex session ID의 thread 상태와 turn history metadata만 읽고 WAM의 `chats.busy` projection 및 turn lifecycle 완전성을 검사한다. 공식 [Codex App Server 문서](https://developers.openai.com/codex/app-server/)의 JSON-RPC·stdio JSONL·`initialize`/`initialized`·thread/turn/approval 흐름도 함께 대조하되, 설치 CLI가 생성한 schema를 해당 배포 버전의 최종 근거로 사용한다.

- 호출하는 대화 메서드: `thread/read` (`includeTurns: false`), `thread/turns/list` (`itemsView: notLoaded`, 최신 100개)
- shadow가 호출하지 않는 메서드: `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, approval 결정
- 저장하는 값: session ID, 계정 ID, 구조화/TUI 상태, busy 일치 여부, turn ID·상태·시작/종료 시각·duration, scan 건수·지연·오류 분류
- 저장하지 않는 값: 메시지, turn 본문, 도구 인자, 승인 요청 내용, app-server 오류 본문
- read-only shadow에서 예기치 않은 app-server 서버 요청은 JSON-RPC `-32601`로 거부하며 자동 승인하거나 실행하지 않는다. session adapter는 command/file 승인만 정제된 식별 메타데이터로 기존 WAM 승인 원장에 연결하고, 공급자가 광고하지 않은 결정과 다른 thread 요청을 거부한다.

## 활성화

기본값은 `off`다. 운영 설정에 다음 값을 추가하고 별도 승인 절차로 서버를 재시작해야 동작한다.

```text
WEB_AGENT_MANAGER_CODEX_APP_SERVER_SHADOW=1
```

활성화되면 서버 시작 직후와 5분마다 `status IN ('starting','running','resuming')`인 최근 Codex 채팅을 최대 20개 읽는다. 같은 tick이 아직 진행 중이면 다음 tick은 중복 실행하지 않는다. 설정만 추가해도 현재 실행 중인 서버에는 반영되지 않는다.

두 read-only gate가 모두 통과한 뒤 제한적 구조화 연결을 허용하려면 세 값을 모두 명시한다. flag만 켜고 cohort 또는 quota를 비우면 신규 채팅 배정은 0건이다.

```text
WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_CANDIDATE=1
WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_COHORT=qa-20260913
WEB_AGENT_MANAGER_CODEX_INTERACTIVE_TRANSPORT_MAX_NEW_CHATS=1
```

세 값과 두 readiness gate가 모두 통과한 뒤 만들어진 무기록 신규 Codex 채팅만 quota까지 app-server가 소유한다. 기존·재개 채팅은 TUI를 유지한다. 후보 채팅은 `thread/start|resume`, `turn/start|interrupt`, streamed notification과 command/file approval을 사용하고 UI에서 `app-server 후보`로 표시한다. PTY는 만들지 않으며 터미널 모드·CLI rename/model/mode 전환·계정 변경은 차단한다.

안전한 폴백 경계는 다음과 같다.

- thread 연결 또는 시작 실패처럼 프롬프트 전달 시도 전 오류만 TUI로 한 번 폴백한다.
- `turn/start`를 호출한 뒤 ACK가 없거나 연결이 끊기면 `delivery_unknown`으로 남기고 자동 재전송하지 않는다.
- ACK 뒤 WAM이 재시작돼 terminal event를 놓친 경우에도 완료로 추정하지 않고 확인 필요 상태로 잠근다.
- 운영자가 원장을 대조해 `failed`(미전달)를 명시적으로 조정한 경우에만 TUI 폴백을 연다. `delivered` 확인은 중복 전송을 막되 잃어버린 event channel을 임의로 복구하지 않는다.
- transport/receipt에는 command/thread/turn ID, 시각, 상태와 정제된 오류 코드만 저장하고 prompt·assistant delta·도구 인자 원문은 저장하지 않는다.
- 현재 계약 밖의 app-server 요청은 fail-closed다. 제한 후보에서 반복되면 quota 확대 전에 설치 CLI schema와 adapter를 갱신한다.

## 관리자 API

```text
GET  /api/admin/providers/codex/shadow
POST /api/admin/providers/codex/shadow/chats/:chatId/probe
```

GET은 최근 7일의 `match`, `mismatch`, `inconclusive`, `error`, thread-status gate, turn-history gate와 최근 50개 scan을 반환한다. turn scan 응답에도 item/message/error 본문이나 turn ID 목록은 포함하지 않는다. POST는 지정 채팅을 한 번 읽지만 flag가 꺼져 있으면 `409`, Codex session ID가 없으면 `404`다.

관측 해석:

- `match`: app-server의 `active|idle`과 기존 busy projection이 같다.
- `mismatch`: 둘이 반대다. 시점 차이인지 상태 판정 오류인지 후속 조사한다.
- `inconclusive`: `notLoaded`, `systemError`, 알 수 없는 새 status라 busy를 단정하지 않았다.
- `error`: initialize, RPC, timeout, 프로세스 종료 중 하나로 읽지 못했다. DB에는 오류 클래스/코드만 저장한다.

## 승격 조건

이 shadow 결과만으로 구조화 세션을 기본 경로로 켜지 않는다. 최소 7일 관측 뒤 다음을 모두 확인해야 한다.

설정의 readiness 카드는 두 범위를 분리해 자동 판정한다.

- `thread_status`: 7개 UTC 날짜, 100건, 현재 활성 Codex 세션 80% 이상 coverage, busy/idle 각 1건 이상, mismatch/error/inconclusive 0건, 최근 15분 표본과 p95 timeout 이내
- `turn_history_metadata`: 7개 UTC 날짜, 100 scan, 종료 turn 10건 이상, 모든 종료 turn의 start/terminal pair, 잘못되거나 역행한 metadata와 scan 오류 0건, 최근 15분 표본과 p95 timeout 이내

turn event 원장은 같은 chat/turn/event를 한 번만 append하고, 이미 terminal인 turn이 `inProgress`로 돌아가거나 시작·종료 시각/terminal status가 바뀌면 정상 전이로 덮어쓰지 않고 invalid scan으로 남긴다. `candidateEligible`과 `transitionEligible`은 두 gate, 후보 flag, 비어 있지 않은 cohort, 1개 이상의 quota가 모두 갖춰졌다는 뜻이다. 실제 배정은 그 이후 생성되는 신규·무기록 Codex 채팅에만 원자적으로 수행한다.

1. 원인 없는 turn start/end 누락이 없다.
2. mismatch가 요청/응답 경계의 단기 시점 차이로 설명되거나 수정됐다.
3. initialize, out-of-order response, notification, timeout, exit, 서버 approval request 계약 테스트가 대상 CLI 버전에서 통과한다.
4. 신규 채팅 일부만 대상으로 하는 별도 구조화 session/turn feature flag, cohort, quota와 안전한 pre-delivery TUI fallback이 준비됐다.

CLI가 업데이트되면 `codex app-server generate-json-schema --experimental` 결과를 다시 대조하고 canary를 통과하기 전에는 승격하지 않는다. 자동 QA의 fake app-server 통과는 운영 7일 shadow·실제 전용 credential·사람 승인 증거를 대신하지 않는다.
