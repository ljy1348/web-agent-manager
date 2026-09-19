# 공급자 CLI canary 운영 계약

## 목적

CLI 후보 버전을 운영 채팅에 적용하기 전에 고정된 호환성 suite 결과와 현재/후보 capability 차이를 원장에 남긴다. canary 실행은 CLI 업데이트, 운영 기본 변경, 터미널 재시작을 수행하지 않는다.

## 실행·조회

- `POST /api/providers/:provider/canaries`: 관리자 또는 test_only tester. 본문은 `candidateVersion`만 허용하며 `Idempotency-Key`가 필수다.
- `GET /api/providers/:provider/canaries`: 관리자 또는 test_only tester, 최근 20회를 반환한다.
- `GET /api/providers/capabilities`: 현재 capability와 공급자별 최신 canary를 반환하고, 관리자에게만 최근 update 요약을 함께 반환한다. backup manifest는 이 응답에 포함하지 않는다.

suite 순서는 `login`, `new_session`, `resume`, `idle_input`, `follow_up`, `approval`, `interrupt`, `completion`, `rate_limit_sample`, `usage_read`로 고정한다. 한 단계가 실패하거나 확인 불가이면 뒤 단계는 `skipped`로 남긴다. 후보가 보고한 버전이 요청 버전과 다르거나 capability 최소 계약을 보고하지 않으면 `blocked`다.

## 격리와 저장 제한

- 서버에 고정된 command/argv만 `shell: false`로 실행한다. HTTP 요청은 실행 파일·인자·환경을 제공할 수 없다.
- run별 임시 HOME과 cwd를 만들고 PATH, HOME, 공급자 config 위치, canary 식별자만 전달한다.
- 단계 종료 후 임시 영역을 삭제하며, 원장에는 stdout/stderr·프롬프트·토큰·경로를 저장하지 않는다.
- evidence는 짧은 코드와 session/event 관찰 여부만, capability는 허용 목록만 저장한다.
- 이 격리는 최소 환경과 임시 HOME/cwd를 제공하는 프로세스 격리다. 커널 namespace, 네트워크 차단, syscall 제한을 제공하는 OS sandbox라고 간주하면 안 된다.

## 재시작·실패 처리

서버 재시작 전에 끝나지 않은 run/step은 자동 재실행하지 않고 `blocked` 및 `server_restart_reconciliation_required`로 확정한다. 같은 공급자와 멱등 키의 재요청은 기존 run을 반환하며 다른 후보 버전에 키를 재사용하면 409다.

공급자별 production harness가 연결되지 않은 경우 결과는 `candidate_harness_unavailable`의 `blocked`다. 이 상태는 통과로 취급하거나 기존 `/providers/:provider/update`를 자동 호출하지 않는다. Codex에는 아래 app-server harness가 제공되며 Claude·Grok은 같은 출력 계약의 별도 harness를 운영자가 연결해야 한다. 일부 신규 채팅 rollout도 통과 canary와 candidate root가 함께 있어야만 명시적으로 시작할 수 있다.

## 실제 harness 연결

실제 공급자 probe는 명시적 opt-in이다. `WEB_AGENT_MANAGER_PROVIDER_CANARY_HARNESS_DIR` 아래에 `codex`, `claude`, `grok` 중 사용할 공급자 이름과 같은 실행 파일을 둔다. root와 실행 파일은 symlink가 아니어야 하고 다른 사용자가 쓸 수 없어야 한다. `WEB_AGENT_MANAGER_PROVIDER_CANARY_CREDENTIALS_DIR/<provider>`는 mode 0700의 전용 테스트 계정 seed이며, 그 하위 일반 파일만 10MiB까지 매 run의 임시 HOME으로 0600 복제한다. symlink/device는 거부되고 source 내용은 읽어 원장이나 로그에 쓰지 않는다. 이 seed는 운영 HOME·일반 사용자 계정 credential과 공유하지 않는다.

`WEB_AGENT_MANAGER_PROVIDER_CANDIDATE_CLI_DIR/<provider>`를 함께 설정하면 WAM이 검증한 같은 고정 candidate 실행 파일의 절대 경로를 harness에 `WAM_CANARY_CANDIDATE_COMMAND`로 전달한다. 그 외 입력은 `WAM_CANARY_PROVIDER`, `WAM_CANARY_STEP`, `WAM_CANARY_EXPECTED_VERSION`뿐이다. harness는 stdout에 JSON 객체 하나를 출력하고 0으로 끝내야 한다.

```json
{
  "state": "passed",
  "reportedVersion": "공급자 CLI의 실제 --version 출력",
  "evidence": { "code": "login_ok", "sessionObserved": true, "eventObserved": true },
  "capabilities": { "transport": "app_server", "structuredSession": true, "interrupt": true, "resume": true }
}
```

각 호출은 고정 step 하나만 검사한다. harness가 실제 CLI 설치·대화 비용을 발생시킬 수 있으므로 별도 공급자 테스트 계정과 한도를 적용하는 책임은 운영자에게 있다. WAM의 `test_only` 사용자는 canary를 호출할 수 있는 애플리케이션 권한이고, credential seed는 app-server가 로그인할 별도의 공급자 계정이다. 두 자격증명을 공유하지 않는다. WAM은 부모의 임의 환경·일반 credential을 넘기지 않으며 원문 stdout/stderr도 저장하지 않는다.

### 제공되는 Codex app-server harness

production build는 self-contained `dist/canary/codex-app-server-canary.js`를 만든다. 이를 운영 HOME이나 candidate 폴더와 분리된 owner-only harness root에 실행 파일 이름 `codex`로 복사한다. symlink는 의도적으로 허용하지 않는다.

```bash
install -d -m 0700 /srv/wam-canary/harness
install -m 0700 dist/canary/codex-app-server-canary.js /srv/wam-canary/harness/codex
```

이 harness는 HTTP 입력을 prompt나 argv로 사용하지 않는다. 고정된 다음 계약만 실제 app-server stdio에서 실행한다.

- `account/read`로 전용 seed의 로그인 상태 확인
- `thread/start`와 다음 프로세스의 `thread/resume`
- 도구를 쓰지 않는 세 고정 marker 응답의 정확성 및 terminal event
- read-only sandbox에서 파일 생성을 시도해 command/file approval이 실제 도착하는지 확인하고 항상 `decline`; workspace 무변경 확인
- 장문 응답 turn을 ACK 직후 interrupt하고 `interrupted` terminal 확인
- `account/rateLimits/read` 두 회의 구조화 응답 확인

모델 turn은 총 5회 발생할 수 있고 공급자 사용량·비용을 소비한다. dedicated test account의 제한을 별도로 설정한 뒤 사람이 명시적으로 실행한다. marker/prompt/assistant delta는 메모리에서만 검사하고 canary DB·API·stdout에는 저장하지 않는다. 단계별 wall-clock duration과 제한 evidence code만 남는다. harness는 `.wam-canary-seeded` marker가 없는 HOME, owner-only가 아닌 HOME/workspace, symlink 또는 group/world-writable candidate CLI를 실행 전에 차단한다. wrapper timeout 신호에서는 app-server의 별도 process group을 TERM 후 KILL해 orphan을 남기지 않는다.

필요 설정 예시는 다음과 같다.

```text
WEB_AGENT_MANAGER_PROVIDER_CANARY_HARNESS_DIR=/srv/wam-canary/harness
WEB_AGENT_MANAGER_PROVIDER_CANARY_CREDENTIALS_DIR=/srv/wam-canary/credentials
WEB_AGENT_MANAGER_PROVIDER_CANDIDATE_CLI_DIR=/srv/wam-canary/candidates
```

실제 credential seed와 candidate CLI를 준비하지 않은 자동 QA에서는 별도 fake stdio CLI로 같은 10단계를 검증한다. 이 통과 결과를 운영 credential acceptance로 간주하지 않는다.

## 신규 채팅 단계 rollout

candidate CLI root가 설정된 환경에서는 passed canary 뒤 관리자가 `POST /api/providers/:provider/rollouts`로 1~100개의 신규 채팅 quota를 연다. 시작 시 candidate의 실제 version과 SHA-256을 고정한다. SessionManager는 기존 세션·history가 없는 새 채팅만 원자 배정하고 quota 밖 채팅과 기존/재개 세션은 현재 CLI를 유지한다. 실행 직전 hash가 바뀌면 채팅을 시작하지 않고 오류로 기록한다.

candidate 채팅에서 한 번이라도 `error`가 관측되면 이후 상태가 회복돼도 오류 증거는 유지되어 전체 승격을 막는다. 관리자는 rollout을 중단할 수 있으며, 이미 떠 있는 candidate 프로세스는 즉시 강제 종료하지 않지만 다음 재시작부터 현재 CLI를 사용한다. quota가 찼고 오류가 0일 때만 기존 update API가 `rolloutRunId`와 canary를 함께 받아 전체 설치·터미널 재시작을 수행하고 rollout을 promoted로 확정한다. tester 자격증명은 canary만 실행할 수 있고 rollout 시작·중단·전체 적용·rollback은 계속 403이다.

## 업데이트 gate

`POST /api/providers/:provider/update`는 `canaryRunId`를 반드시 받는다. 다음 조건을 모두 만족해야 설치 명령을 호출한다.

- 요청 공급자의 run이다.
- 현재 설치 버전이 canary 시작 시 current version과 같다.
- 최근 24시간 안에 끝났다.
- 후보 버전과 suite가 보고한 버전이 같다.
- 고정 10단계가 빠짐없이 모두 `passed`다.

설치 명령이 성공해도 다시 읽은 실제 버전이 후보와 정확히 같지 않으면 사용량·채팅 터미널 재시작을 수행하지 않는다. update UI도 현재 버전에서 통과한 최신 canary가 없으면 비활성화하며, 통과 run ID를 요청 본문에 고정한다.

각 허용된 update는 `provider_update_runs/events`에 멱등 run과 append-only 상태 전이를 만든다. 적용 전 공급자의 모든 채팅에 대해 session ID, 채팅 profile version/snapshot, task ID/state/profile version을 정렬한 SHA-256 불변성으로 고정한다. 터미널 재시작 뒤 이 hash와 행 수가 다르면 `applied`가 아니라 `rollback_required`다. 서버가 `updating` 도중 재시작해도 자동 성공이나 재설치를 하지 않고 같은 상태로 복구한다. 원장 상태는 `pending → updating → applied|rollback_required`, 이후 rollback 전용 전이로 제한한다.

설치 전에 PATH에서 해석한 CLI binary와 인증정보를 제외한 공급자 설정 allowlist를 `dataDir/provider-cli-backups/<update-run-id>`에 0700/0600 권한으로 저장한다. manifest에는 상대 경로, mode, SHA-256만 남기며 HOME·backup 절대 경로나 auth/token 파일은 기록하지 않는다. backup 준비가 실패하면 설치를 시작하지 않는다. 관리자 대시보드의 롤백은 해당 manifest의 모든 hash를 먼저 검증하고 binary/config를 원자 교체한 뒤 이전 버전과 세션 불변성을 재확인한다. 같은 update/rollback 멱등 키는 설치·복원·터미널 재시작을 반복하지 않는다. 백업은 운영자가 복구 가능 기간을 정하기 전까지 자동 삭제하지 않는다.

## QA 기준

- 실제 임시 SQLite, Express HTTP, `shell: false` 자식 프로세스로 10단계를 끝까지 실행한다.
- 부모의 임의 환경변수가 전달되지 않고 HOME/cwd가 run 전용인지 확인한다.
- 임시 영역 삭제, 멱등 replay, 버전 불일치 중단, 재시작 복구를 확인한다.
- HTTP 전체 canary는 5초, 기록 1건 목록 조회는 500ms의 넉넉한 회귀 상한을 둔다.
- Chrome에서 지연 응답 중 500ms 안에 진행 표시와 disabled가 나타나고 중복 요청이 생기지 않는지, 결과와 capability diff가 표시되는지, 390px 화면에서 가로 overflow가 없는지 확인한다.
- 임시 symlink CLI와 설정을 실제 파일로 교체한 뒤 한 HTTP 흐름에서 update/rollback하고, 인증 파일 비복원, version 복원, session/task/profile 불변성, update/rollback 재요청 무실행과 2초 이내 완료를 확인한다.
