# WAM Agent Control Plane 구현 계획

작성일: 2026-09-12

상태: 코드 범위 구현·QA 완료, 운영 관찰·프로젝트별 승인 단계 대기(16장 종료 감사 참고)

대상: web-agent-manager 0.5.x 이후

## 1. 결론

WAM의 다음 목표는 Codex·Claude·Grok 앱의 모든 UI를 복제하는 것이 아니다. 여러 공급자의 에이전트 작업을 **유실·중복 없이 접수하고, 현재 상태를 한 근거로 설명하며, 프로젝트별 정책에 따라 검증한 뒤 완료시키는 제어면(control plane)**이 되는 것이다.

구현 순서는 다음과 같이 고정한다.

1. 일반 프롬프트 원장과 단일 상태 머신
2. 공급자 구조화 이벤트 어댑터와 TUI 폴백
3. 프로젝트 프로필과 채팅별 불변 설정 스냅샷
4. 자동 검증 게이트와 완료 판정
5. CLI 호환성 canary·단계 배포·롤백
6. 외부 접속 보안과 전체 백업·복구
7. 목표 작업 보드, 예산·계정·모델 라우팅
8. Live preview, 시각 diff, 원격 worker 등 작업대 기능

## 2. 현재 기준선

### 이미 확보된 것

- Codex·Claude·Grok 대화형 CLI를 독립 tmux/PTY 세션으로 실행한다.
- 공급자 JSONL을 정본 대화 기록으로 읽고 WAM DB에는 상태와 메타데이터를 저장한다.
- 공급자 훅, 권한 승인, rate limit 대기·재개, 계정별 사용량, 예약 실행을 지원한다.
- 프로젝트와 Git worktree, GitHub 이슈·PR·Actions, diff·커밋·push를 연결한다.
- Agent Lab에는 append-only 이벤트, 멱등 키, 체크포인트, 예산, 구조화 비대화형 런타임이 있다.
- Agent preset은 공급자·모델·추론·샌드박스·스킬·하네스·예산 설정을 버전으로 고정할 수 있다.
- 세션 백업, 감사 로그, 내부망 보호, 모바일 기기 신뢰 기능이 있다.

### 확인된 공백

- 일반 웹 프롬프트에는 Agent Lab 수준의 멱등 키와 영속 전달 원장이 없다.
- 프롬프트 제출·작업 중·완료 상태가 tmux 화면, JSONL, 훅, DB의 여러 신호에서 사후 추론된다.
- Codex app-server는 일부 계정 기능에만 사용하며 일반 채팅은 TUI 조작에 의존한다.
- 프로젝트별 Agent preset을 담을 구조는 있으나 2026-09-12 운영 DB 기준 실제 preset은 없다.
- 등록 프로젝트마다 같은 WAM 공통 스킬만 설치되며 프로젝트별 검증·권한·완료 정책은 정식 데이터 모델이 아니다.
- `TODO_LIST.md`와 GitHub 이슈 상태에 이미 구현된 항목이 남아 로드맵 정본이 어긋나 있다.
- 로그인 제한은 프로세스 메모리와 IP+계정 조합에 의존하고, 폐기된 웹 세션이 열린 WebSocket에 즉시 반영되지 않는다.
- CLI 업데이트가 공급자 계약 검증보다 먼저 운영 세션에 적용될 수 있다.

## 3. 설계 원칙

1. **접수 먼저, 실행 나중:** 사용자 입력을 DB에 커밋하기 전에는 CLI에 전달하지 않는다.
2. **멱등 실행:** 같은 사용자 동작·예약·재시도가 WAM 안에서 두 번 dispatch되지 않게 한다.
3. **모호함을 숨기지 않음:** 공급자 ACK가 불충분하면 성공이나 실패로 추측하지 않고 `delivery_unknown`으로 둔다.
4. **상태의 단일 정본:** `chats.busy`를 독립 판단값으로 쓰지 않고 활성 task 상태의 projection으로 만든다.
5. **구조화 신호 우선:** 공급자 API/event → 공급자 hook → JSONL → TUI 화면 순으로 신뢰한다.
6. **기능 협상:** 공급자와 CLI 버전이 실제로 제공하는 기능만 켜고 폴백 이유를 화면에 표시한다.
7. **설정 불변성:** 프로젝트 기본값이 바뀌어도 이미 시작한 채팅·작업은 시작 당시 profile version을 유지한다.
8. **완료와 발화 분리:** 에이전트의 완료 문구는 검증 입력일 뿐이며, WAM의 gate가 통과해야 완료 상태가 된다.
9. **운영 동작 분리:** 빌드·코드 변경과 서버 재시작·DB 반영·배포·외부 전송을 별도 승인 경계로 둔다.
10. **추가형 마이그레이션:** 기존 tmux 채팅과 JSONL을 유지하면서 새 원장을 병행 도입하고, 검증 뒤 정본을 전환한다.

## 4. 목표 구조

```text
Web / Mobile / Scheduler / AgentBridge
                  │
                  ▼
          TaskCommandService
      접수·멱등 키·profile pinning
                  │
          append-only task events
                  │
                  ▼
             Dispatcher
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
Structured Provider      TUI Fallback
Adapter/API/Event        tmux/PTY parser
       └──────────┬──────────┘
                  ▼
        Normalized Agent Events
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
 State Projection      Verification Engine
 chat/task/board        test/build/UI/live gates
       │                     │
       └──────────┬──────────┘
                  ▼
      Timeline · artifacts · audit · alerts
```

기존 `SessionManager`는 전환 기간 동안 대화형 세션 수명주기를 담당한다. 새 `TaskCommandService`가 접수·상태 정본을 소유하고 `SessionManager`에는 명시적인 dispatch command만 전달한다. Agent Lab의 이벤트·예산·체크포인트 구현은 개념과 공통 유틸을 재사용하되 실험 데이터와 일반 작업 데이터를 한 테이블에 섞지 않는다.

## 5. 상태 모델

### 5.1 프롬프트 명령 상태

```text
received → dispatching → delivered → queued → started
    │           │            │         │        │
    ├───────────┴────────────┴─────────┴──────→ cancelled
    ├─────────────────────────────────────────→ rejected
    └─────────────────────────────────────────→ delivery_unknown
                                                │
                                                ├→ reconciled_delivered
                                                └→ reconciled_failed
```

- `received`: HTTP 요청과 본문 해시, 사용자, 채팅, 멱등 키가 DB에 저장됐다.
- `dispatching`: 한 dispatcher가 lease를 선점했다.
- `delivered`: 공급자 구조화 ACK 또는 신뢰 가능한 제출 증거가 있다.
- `queued`: 실행 중 턴 뒤 follow-up 대기열에 들어갔다.
- `started`: 해당 입력의 실제 user turn 또는 공급자 start event가 확인됐다.
- `delivery_unknown`: WAM은 키 입력을 시도했지만 제출 여부를 증명할 수 없다. 자동 재전송하지 않는다.
- `reconciled_*`: 이후 훅·JSONL·사용자 판단으로 모호한 상태를 확정했다.

외부 CLI가 멱등 키를 받지 않는 동안 end-to-end exactly-once를 주장하지 않는다. WAM 내부에서는 같은 command의 중복 dispatch를 막고, 외부 결과가 모호하면 보존·표시·수동 조정한다.

### 5.2 작업 상태

```text
created → running → needs_input → running
             │
             ├→ verifying → completed
             ├→ failed
             ├→ cancelled
             └→ budget_exceeded
```

- 한 task는 하나 이상의 prompt command와 provider turn을 포함할 수 있다.
- `chats.busy`는 호환 API용 projection으로만 남기고, 활성 task가 `running|verifying`이면 true로 계산한다.
- 승인 요청, rate limit, 사용자 질문은 task의 reason을 별도 필드로 기록한다.
- 상태 전이는 반드시 이벤트와 함께 한 transaction에서 기록한다.

## 6. 데이터 모델 초안

| 테이블 | 목적 | 핵심 필드 |
| --- | --- | --- |
| `agent_tasks` | 사용자 관점의 작업 | chat, project, profile_version, state, reason, goal, budget, timestamps |
| `agent_task_events` | append-only 상태 원장 | task, sequence, idempotency_key, type, payload, created_at |
| `prompt_commands` | 웹·예약·위임 입력 명령 | task, chat, source, content_hash, encrypted/redacted preview, state, idempotency_key |
| `prompt_delivery_attempts` | 실제 공급자 전달 시도 | command, attempt, adapter, evidence_type, baseline, outcome, error |
| `project_profiles` | 프로젝트별 프로필 이름과 활성 버전 | project, name, task_kind, status, active_version |
| `project_profile_versions` | 불변 실행 정책 | runtime, permissions, skills, instructions, verification, protected_actions, budget |
| `verification_runs` | task별 검증 한 회차 | task, profile_version, state, trigger, summary |
| `verification_steps` | 개별 명령·시각 검사 | run, kind, command, cwd, exit_code, duration, status |
| `verification_artifacts` | 로그·스크린샷·리포트 | run/step, path, hash, mime, size, redaction status |
| `provider_capability_snapshots` | CLI 버전별 실제 기능 | provider, account, version, capabilities, checked_at |
| `provider_canary_runs` | 업데이트 전 계약 검사 | provider, old/new version, suite, result, report, timestamps |

### 저장 제한

- 일반 메시지 원문을 WAM DB에 복제하지 않는 현재 원칙을 유지한다.
- `prompt_commands`에는 멱등성을 위한 본문 해시와 길이, 민감정보 제거 preview만 둔다.
- 재시작 후 실제 재전달이 필요하면 암호화된 단기 outbox 또는 공급자별 안전한 queue 중 하나를 별도 설계한다. 평문 본문 영속화는 기본값으로 채택하지 않는다.
- 로그·스크린샷·artifact는 프로젝트 허용 경로 안에 두고 만료·용량 정책을 적용한다.

## 7. API 초안

기존 API를 즉시 제거하지 않고 새 계약을 추가한다.

```text
POST /api/chats/:chatId/tasks
POST /api/tasks/:taskId/prompts
GET  /api/tasks/:taskId
GET  /api/tasks/:taskId/events?after=<sequence>
POST /api/prompt-commands/:id/reconcile
POST /api/tasks/:taskId/cancel

GET  /api/projects/:projectId/profiles
POST /api/projects/:projectId/profiles
POST /api/projects/:projectId/profiles/:id/versions
POST /api/projects/:projectId/profiles/:id/activate
POST /api/projects/:projectId/profile-draft

POST /api/tasks/:taskId/verifications
GET  /api/tasks/:taskId/verifications

GET  /api/providers/capabilities
POST /api/providers/:provider/canary
```

- 쓰기 요청은 `Idempotency-Key`를 받는다.
- 생성 응답은 `202`와 task/command ID, 영속 접수 시각을 반환한다.
- 기존 `POST /api/chats/:id/messages`는 내부적으로 task/prompt command를 만든 뒤 같은 응답 의미를 유지한다.
- WebSocket은 상태 문자열을 임의 갱신하지 않고 저장된 event sequence를 전달한다.
- 클라이언트 재연결 시 마지막 sequence 이후 이벤트를 HTTP로 보충한 뒤 실시간 구독을 이어간다.

## 8. 단계별 실행 계획

### Phase 0. 계획 정본과 측정 기준 정리

목표: 새 기능을 시작하기 전에 실제 완료 상태와 실패 기준을 신뢰할 수 있게 한다.

작업:

1. `TODO_LIST.md`의 구현 완료·부분 완료·미착수 항목을 현재 코드와 대조한다.
2. 완료된 GitHub 이슈를 커밋·검증 기록에 연결하고 닫는다.
3. 남은 항목을 `runtime reliability`, `project policy`, `security`, `workbench` epic으로 다시 분류한다.
4. 최근 프롬프트 제출 실패·중복·상태 불일치의 기준 건수를 익명 집계한다.
5. 전환 feature flag와 운영 dashboard 지표 이름을 확정한다.

완료 기준:

- TODO, GitHub issue, 이 문서의 milestone 상태가 서로 연결된다.
- 현재 실패율과 상태 불일치 수를 재현 가능한 쿼리로 얻는다.
- 이미 구현된 기능을 새 작업으로 다시 계획하지 않는다.

### Phase 1. 일반 프롬프트 원장과 단일 상태 머신

목표: 서버 재시작, 화면 재그리기, 후속 입력에서도 접수·전달·실행 상태를 잃거나 추측하지 않는다.

작업:

1. `agent_tasks`, `agent_task_events`, `prompt_commands`, `prompt_delivery_attempts` 추가형 마이그레이션을 작성한다.
2. event append와 projection 갱신을 한 transaction으로 묶는 repository를 만든다.
3. 웹 클라이언트가 UUID 멱등 키를 생성하고 재시도에서 재사용하게 한다.
4. 기존 `sendPrompt` 앞에 영속 접수와 dispatcher lease를 둔다.
5. WAM이 제출을 증명하지 못하면 초안을 파괴하거나 자동 재전송하지 않고 `delivery_unknown`으로 전환한다.
6. JSONL·훅이 늦게 도착하면 같은 본문 해시·기준선·시각을 대조해 reconcile한다.
7. `busy` 직접 쓰기를 줄이고 task projection으로 전환한다.
8. UI에 `접수됨`, `전달 중`, `대기열`, `실행 중`, `확인 필요`를 구분해 표시한다.

필수 테스트:

- 같은 멱등 키 100회 요청이 command 하나만 만든다.
- HTTP 응답 유실 후 재시도해도 WAM dispatch는 한 번이다.
- `received` 직후 서버 종료, `dispatching` 직후 종료, 전달 직후 ACK 유실을 각각 재현한다.
- 유휴 입력, 작업 중 follow-up, resume 초기화, `/clear`, slash command를 공급자별로 검증한다.
- JSONL·훅이 지연되거나 순서가 바뀌어도 상태가 뒤로 가지 않는다.
- `delivery_unknown` 입력은 사용자 조정 전 자동 재전송되지 않는다.

완료 기준:

- 일반 입력에 영속 command ID와 event timeline이 생긴다.
- 서버 재시작 후 모든 비종료 command가 자동 복구 또는 명시적 확인 필요 상태가 된다.
- 화면 busy와 DB busy를 독립 정본으로 비교하는 코드가 제거되거나 호환 projection으로 한정된다.
- 손실·중복을 숨기는 성공 응답이 없다.

### Phase 2. 구조화 공급자 어댑터

목표: 정상 경로에서 TUI 화면 문구를 상태 정본으로 사용하지 않는다.

진행 상태(2026-09-13): 공통 capability·정규화 이벤트 계약, CLI 버전별 snapshot, hook 관찰 원장, `prompt.started` task 반영, 조회 API와 폴백 UI를 구현했다. 현재 설치된 Codex app-server schema에 맞춘 JSON-RPC client와 `thread/read(includeTurns:false)` 상태 shadow, `thread/turns/list(itemsView:notLoaded)`의 본문 없는 turn-history lifecycle 원장·별도 7일 gate를 구현했다. 두 gate와 명시적 flag·cohort·quota가 모두 맞을 때만 이후 생성되는 무기록 신규 Codex 채팅을 quota만큼 원자 배정하는 limited transport를 SessionManager에 연결했다. `thread/start|resume`, `turn/start|interrupt`, notification 정규화, command/file approval, provider turn ACK 기반 task delivery evidence와 chat별 provenance를 제공한다. 전송 전 연결 실패만 TUI로 폴백하고, turn 요청 뒤 ACK 유실·재시작은 자동 재전송하지 않고 수동 확인 상태로 잠근다. 전용 credential acceptance를 사람이 실행할 self-contained 10단계 Codex app-server harness와 단계별 지연 UI도 추가했다. 실제 운영 seed의 harness 실행, 7일 관찰과 quota 확대 승인은 남아 있으며 기본 flag/cohort/quota는 모두 off다.

공통 계약:

```ts
interface InteractiveAgentAdapter {
  capabilities(): ProviderCapabilities;
  start(input: StartSessionInput): Promise<SessionHandle>;
  send(command: PromptCommand): Promise<DeliveryReceipt>;
  events(handle: SessionHandle, cursor?: string): AsyncIterable<NormalizedAgentEvent>;
  approve(input: ApprovalDecision): Promise<ApprovalReceipt>;
  interrupt(handle: SessionHandle): Promise<void>;
  stop(handle: SessionHandle): Promise<void>;
  reconcile(command: PromptCommand): Promise<ReconciliationResult>;
}
```

작업:

1. 정규화 이벤트 종류와 공급자 capability matrix를 먼저 고정한다.
2. Codex app-server 세션 어댑터를 feature flag 아래 구현한다. — JSON-RPC transport, 읽기 `thread/read`·metadata-only `thread/turns/list`, limited 신규 session/turn과 WAM approval·ACK/재시작 계약 완료; 운영 opt-in 대기
3. 기존 TUI와 구조화 어댑터를 동시에 관찰하는 shadow mode를 둔다. — thread-status·turn-history 코드/독립 7일 readiness gate/UI 완료, 실제 운영 관찰 대기
4. 이벤트 일치가 확인되면 Codex 신규 채팅부터 구조화 경로를 기본으로 전환한다. — quota 제한 후보 연결 완료, 운영 기본값 전환은 대기
5. Claude는 공식 stream-json/SDK와 hook이 보장하는 범위를 나눠 구현한다.
6. Grok은 지원 capability만 선언하고 없는 기능은 TUI 폴백 이유를 표시한다.
7. 터미널 UI는 실제 세션 표시·수동 복구 채널로 유지한다.

필수 이벤트:

- session started/bound/ended
- prompt accepted/queued/started
- turn completed/failed/interrupted
- approval requested/resolved
- rate limit entered/reset
- tool started/completed
- usage observed

완료 기준:

- 구조화 경로에서는 프롬프트 제출 성공을 composer 문자열로 판정하지 않는다.
- 공급자·CLI 버전별 capability와 현재 폴백 경로가 UI에 보인다.
- 7일 shadow 관찰에서 원인 없는 turn start/end 누락이 없다.
- 폴백 전환이 세션과 task 원장을 잃지 않는다.

### Phase 3. 프로젝트 프로필

목표: 프로젝트마다 다른 지식·검증·권한·운영 경계를 새 채팅에 일관되게 적용한다.

진행 상태(2026-09-13): 기존 Agent preset/version을 중복 없이 일반 project profile로 확장해 네 task kind, 수동 draft/version, 명시적 활성화, 프로젝트 지침·package script 기반 미저장 초안, task kind별 단일 활성 profile과 일반/worktree 채팅의 불변 version pinning을 구현했다. 9장의 현재 8개 프로젝트 추천 catalog도 실제 wrapper/script 존재를 확인하는 초안과 연결했으며 추천 ID를 snapshot에 보존한다. 저장·새 version·활성화·실험 승격·채팅 실행에서 같은 안전 parser를 적용하고, pin한 sandbox·승인·model·reasoning·추가 경로·tool 정책을 공급자별 TUI argv 또는 안전한 구조화 경로에 전달한다. 대응할 수 없는 옵션과 안전 경계를 넘는 설정은 시작 전에 거부하고 structured transport는 ACK 전에 TUI로 폴백한다. 설정 UI에서 지침·검증·보호 정책 경고와 JSON을 검토해 draft/version을 저장하고 특정 version만 확인 후 활성화한다. worktree 생성 직후 profile pin, 지침 content hash, Claude import 정합성도 증거로 남긴다. 활성 프로젝트 전체의 필수 analysis/implementation active version·verification·보호 정책과 현재 지침/import 경고를 본문·경로·명령 원문 없이 batch로 집계해 owner가 부족 항목에서 개별 검토로 이동할 수 있다. 모든 운영 프로젝트의 실제 profile 생성·owner 승인은 남아 있다.

프로필 내용:

- provider, model, reasoning effort
- sandbox, approval mode, allowed/disallowed tools
- 추가 읽기·쓰기 경로
- 활성 skills/plugins/MCP/hooks
- AGENTS.md와 공급자별 지침 상태
- quick/full/UI/live verification steps
- 보호 작업과 추가 승인 규칙
- 시간·토큰·비용·동시 실행 예산
- 기본 branch/worktree/issue/PR 정책

작업:

1. 기존 Agent preset 스키마를 일반 채팅용 project profile version으로 확장하거나 명확한 변환 계층을 둔다. — 완료
2. 프로젝트마다 `분석`, `일반 구현`, `고위험 변경`, `운영` task kind를 지원한다. — 완료
3. 프로젝트 등록 시 스택·패키지 스크립트·지침 파일을 읽어 profile 초안을 만든다. — 현재 8개 등록 프로젝트 맞춤 catalog와 일반 npm 탐지 완료
4. 초안은 자동 적용하지 않고 사용자가 검토·승인한다. — 저장·활성화 분리 API 완료
5. 채팅 생성 시 활성 profile version을 복사해 고정한다. — 일반/worktree 채팅 완료
6. WAM 지침 화면에 `AGENTS.md 없음`, `CLAUDE.md import 불일치`, 검증 명령 없음, 보호 정책 없음을 표시한다. — profile 검토 카드 완료
7. worktree 생성 시 profile과 로컬 지침 복사 결과를 함께 검증한다. — 생성 직후 profile pin·지침 hash·Claude import 증거 완료

현재 8개 프로젝트의 초기 profile은 9장의 표를 기준으로 실제 초안에 연결한다. 초안·운영 DB 자동 저장은 하지 않는다.

완료 기준:

- 모든 활성 프로젝트에 최소 `분석`·`일반 구현` profile이 있다.
- 새 채팅이 어떤 profile version으로 시작했는지 UI와 감사 로그에 남는다.
- 실행 중 profile 변경은 기존 task에 영향을 주지 않는다.
- 프로젝트 밖 쓰기와 보호 작업은 profile 정책에서 차단 또는 추가 승인된다.

### Phase 4. 검증 게이트

목표: 에이전트의 완료 발화와 검증된 완료를 구분한다.

진행 상태(2026-09-12): task의 시작 profile version pinning과 verification run/step/artifact 추가형 원장, 관리자 실행·timeline API, argv 기반 무-shell·최소 환경 실행, timeout·출력 제한, 강화 redaction·quarantine·artifact hash·보존 cleanup, Git commit/diff/untracked content snapshot, 변경 경로 glob 기반 step 선택·필수 step 생략 사유, 멱등 재요청, 동일 commit/diff/profile의 출처 연결 재검증, 필수 단계 실패/통과에 따른 task failed/completed, live·human 명시 승인 및 workspace 재검증, 재시작 복구, 안전한 관리자 artifact 다운로드, read-only PR check gate와 채팅 검증 결과·재실행 UI까지 구현했다.

검증 단계 종류:

- `static`: typecheck, lint, compile
- `focused_test`: 변경 범위 관련 테스트
- `full_test`: 프로젝트 전체 테스트
- `build`: production/package build
- `ui`: Playwright, screenshot, accessibility
- `contract`: API/schema/provider contract
- `live`: 외부 서비스·실DB·운영 환경 검증
- `human_review`: diff, 보안, 제품 판단

작업:

1. profile version에 순서·timeout·실패 정책이 있는 verification recipe를 저장한다. — 기반 완료
2. diff를 기준으로 필요한 step을 선택하되 필수 step 생략 이유를 기록한다. — 완료
3. 명령 stdout/stderr 전체는 용량 제한 artifact로 저장하고 UI에는 요약을 표시한다. — 완료
4. 토큰·쿠키·환경변수·개인 경로를 artifact에서 제거하는 redaction 단계를 둔다. — 강화 redaction·quarantine·다운로드 차단·보존 cleanup 완료
5. `live`와 배포·DB migration·프로세스 재시작은 항상 별도 사용자 승인으로 둔다. — 명시 결정·승인 전후 workspace 비교 완료
6. 검증이 실패하거나 미실행이면 task를 `completed`로 전환하지 않는다. — 완료
7. PR check와 로컬 검증 결과를 같은 gate 요약에 연결한다. — 완료

완료 기준:

- 완료 task마다 profile version, diff hash, 실행한 step, 결과와 artifact hash가 남는다.
- 테스트 미실행·실패 상태가 완료로 표시되지 않는다.
- 동일 commit/profile에서 검증 recipe를 다시 실행할 수 있다. — 완료
- 민감정보 redaction 실패 artifact는 UI 제공과 외부 전송이 차단된다.
- PR head·check가 현재 clean commit을 증명하지 못하면 로컬 단계가 통과해도 완료로 표시되지 않는다. — 완료

### Phase 5. CLI 호환성 canary와 업데이트 안전성

목표: 공급자 CLI 변경을 운영 채팅보다 먼저 발견하고 되돌릴 수 있게 한다.

진행 상태(2026-09-13): 공급자/현재·후보 버전별 추가형 canary 원장, 고정 10단계 suite, 최소 환경·임시 HOME/cwd·고정 argv 프로세스 계약, 버전 일치와 capability diff, 재시작 blocked 복구, 멱등 관리자 API와 대시보드 결과 UI를 구현했다. 서버 고정 공급자 harness·소유자 전용 테스트 credential seed·동일 candidate binary를 연결하는 opt-in production 경로도 추가했으며 미설정 기본값은 과장 없이 blocked다. Codex에는 실제 app-server stdio 계약을 검사하는 self-contained harness를 제공하고 단계별 지연·제한 evidence만 표시한다. passed canary 후보 binary의 version/hash를 고정해 quota 내 신규 채팅에만 적용하고, 영속 오류 0건·quota 완료 뒤에만 전체 update를 허용하는 단계 rollout과 중단 UI를 구현했다. 설치 전 CLI binary와 비밀 제외 설정의 hash backup, 원자 복원, 이전 버전·불변성 재검증, 멱등 원클릭 rollback도 완료했다. 실제 전용 유료 테스트 계정 seed는 운영자가 명시적으로 연결해야 하며 Claude·Grok harness는 아직 별도 구현 대상이다.

작업:

1. 공급자별 canary suite를 만든다: 로그인, 새 세션, resume, 유휴 입력, follow-up, 승인, interrupt, 완료, rate limit 표본, 사용량 조회. — 고정 suite 및 opt-in 공급자 harness 연결 계약 완료
2. 현재 버전과 후보 버전을 격리된 임시 HOME·작업공간에서 실행한다. — 후보 고정 binary·credential seed·임시 HOME/cwd·최소 환경 완료
3. parser/hook/API capability snapshot 차이를 보고한다. — 완료
4. 통과 전에는 운영 기본 버전을 바꾸지 않는다. — 최근 24시간·동일 current version·10단계 전체 통과 gate 및 설치 후 후보 버전 재확인 완료
5. 일부 새 채팅에만 단계 적용한 뒤 전체 적용한다. — quota/hash/error gate 및 승격·중단 완료
6. 이전 CLI 바이너리·설정 백업과 원클릭 rollback을 제공한다. — 완료

완료 기준:

- CLI 업데이트 화면에서 canary 결과와 호환성 차이를 먼저 확인한다. — 완료
- 실패한 후보 버전은 운영 세션에 자동 적용되지 않는다. — 완료
- 롤백 뒤 기존 세션 ID·task 상태·프로필 스냅샷이 유지된다. — 완료

### Phase 6. 보안·백업·복구

목표: 외부 접속과 장기 운영에서 WAM이 가진 호스트 권한의 위험을 줄인다.

작업:

1. IP 전체와 계정 전체 기준의 영속 rate limit을 추가하고 프로세스 재시작 후에도 유지한다. — 완료
2. Passkey/WebAuthn 또는 TOTP 기반 MFA를 제공한다. — TOTP 완료
3. 세션 목록, 현재 세션 외 전체 폐기, 비밀번호 변경 시 전체 폐기를 지원한다. — 완료
4. DB에서 세션·역할·기기 권한이 폐기되면 열린 WebSocket을 즉시 종료한다. — 완료
5. idle session timeout과 중요 작업 직전 재인증을 추가한다. — 완료
6. HTTPS·Secure cookie·HSTS·trusted proxy 설정을 기동 시 진단한다. — 완료
7. MCP/API 자격증명은 별도 vault에 암호화하고 실행 환경에 최소 범위·짧은 수명으로 전달한다. — 완료
8. SQLite, profile, schedule, session mapping, 암호화 키 메타데이터를 포함한 전체 백업 manifest를 만든다. — 완료
9. 빈 설치 환경에서 복구하는 자동화와 정기 복구 훈련을 추가한다. — 완료

진행 상태(2026-09-12): 온라인 SQLite snapshot과 WAM 관리 MFA·vault·일회용 key를 요청 passphrase 기반 AES-256-GCM package로 만들고, owner-only 파일·형식/KDF·ciphertext 및 항목 hash·DB 건수를 manifest로 고정했다. 관리자+최근 재인증+신뢰 네트워크 생성/다운로드/삭제 UI와 기존 설치를 절대 덮어쓰지 않는 offline restore CLI를 제공한다. 복구는 모든 검증을 staging에서 끝낸 뒤 빈 dataDir로 원자 반영하며 기존 로그인·challenge·lease와 실행 상태는 폐기하고 session/profile/task mapping은 보존한다. 실제 package를 OS 임시 빈 환경에 복구해 DB 건수와 vault/MFA key를 확인하고 정리하는 `backup:drill`을 cron/CI에서 반복할 수 있다.

완료 기준:

- 분산 IP 로그인 공격과 서버 재시작 우회 방어 테스트가 통과한다.
- 로그아웃·역할 변경·기기 해제 직후 기존 WebSocket 명령이 거부된다.
- HTTPS 오설정은 dashboard 경고 또는 production 기동 차단으로 드러난다.
- 문서화된 복구 절차로 새 환경에서 프로젝트·예약·채팅 매핑을 복원한다. — 완료

### Phase 7. 목표 작업 보드와 자원 라우팅

목표: 여러 프로젝트의 장기 작업을 사람의 기억 대신 WAM이 관리한다.

작업:

1. task 상태 기반 `Working`, `Needs input`, `Verifying`, `Failed`, `Completed`, `Scheduled` 보드를 만든다. — 완료
2. 목표, 완료 조건, 체크포인트, 다음 행동, 예산을 저장한다. — 완료
3. 계정별 잔여 한도·reset 시각·현재 동시 실행·모델 capability를 라우팅 입력으로 사용한다. — 완료(비용·모델 목록의 실제 근거가 없으면 확인 불가로 표시)
4. 자동 라우팅은 추천부터 시작하고, 사용자 승인 뒤에만 공급자·계정을 바꾼다. — 완료
5. 장기 task 재개는 profile version과 마지막 verified checkpoint를 유지한다. — 완료
6. 프로젝트·계정·공급자별 동시 실행 상한과 queue 우선순위를 둔다. — 완료

진행 상태(2026-09-12): 기존 task/event·verification·schedule·rate-limit 원장을 Working/Needs input/Verifying/Failed/Completed/Scheduled 보드로 투영하고 active/idle/rate-limit/queued를 별도 표시한다. 목표·완료 조건·체크포인트·다음 행동·예산·우선순위와 성공 verification checkpoint를 영속화했다. 추천은 fresh 사용량/reset, 최신 provider capability, profile 고정 model/provider, 세 범위 점유·상한을 snapshot으로 남기며 비용 근거가 없으면 unavailable이다. 추천만으로 실행 설정을 바꾸지 않고 관리자의 별도 확인 뒤에만 적용하며, 적용 트랜잭션에서 점유를 다시 확인해 우선순위 queue/admission을 결정한다. 5초 reconciler가 종료 예약을 해제하고 빈 자리에 높은 우선순위부터 올리지만 실제 프롬프트를 자동 전송하지 않는다.

완료 기준:

- 서버 재시작 뒤 작업 보드가 실제 task 원장에서 복원된다. — 완료
- `Needs input`과 rate limit 대기를 단순 idle과 구분한다. — 완료
- 라우팅 결정에 사용한 비용·한도·capability 근거가 표시된다. — 완료

### Phase 8. 작업대 기능

핵심 제어면이 안정된 뒤 다음을 진행한다.

1. Live preview와 console/network/viewport/screenshot 수집 — 완료
2. hunk 단위 diff accept/reject와 라인 주석 재전송 — 완료
3. 시각 회귀 diff와 접근성 검사 — 완료
4. 원격 worker/SSH host — 코드 완료(host/probe, workspace 제한 mapping, 명시 승인형 task start/status client, 고정 recipe worker CLI 완료; 실제 host 설치·프로젝트별 recipe 승인 대기)
5. PR check 모니터링과 조건부 자동 merge — 완료
6. 필요한 connector 추가 — 완료(HTTPS signed outbound webhook)
7. 선택적 Monaco 편집기 — 미선택(기존 제한 편집기 유지; 성능/사용성 요구가 확인될 때 lazy-load로 재평가)

이 단계의 결과도 별도 상태를 만들지 않고 기존 task event와 verification artifact에 연결한다.

진행 상태(2026-09-13): 프로젝트별 credential/query 없는 loopback target과 viewport, sandbox iframe live view, 실제 headless Chrome screenshot·console·network capture를 작업 카드에 연결했다. browser subresource·WebSocket은 loopback/data/blob 외 차단하고 header/body/cookie/storage를 읽지 않으며 URL은 query 없는 origin+path, console은 credential redaction 뒤 상한 내에서만 task event와 owner-only artifact에 기록한다. capture/target 변경은 관리자+최근 재인증+신뢰 네트워크이고 screenshot도 관리자만 hash 재검증 뒤 읽는다. 로컬 Git 검토는 index→worktree text hunk를 파일/hunk SHA-256 snapshot으로 고정해 stale 결정을 거부하고, 승인 시 해당 hunk만 stage·거부 시 해당 hunk만 역적용한다. 라인 주석은 파일/side/line/hunk 문맥을 기존 멱등 prompt command 원장으로 현재 채팅에 재전송하며 감사에는 diff/주석 본문을 남기지 않는다. 같은 task의 명시적 screenshot 기준선과 새 실제 Chrome capture를 동일 viewport에서 pixel diff로 비교해 0600 diff PNG와 변경 비율을 event에 연결하고, 같은 문서의 axe 검사는 DOM/value 원문 없이 제한된 rule/impact/selector와 합계만 보존한다. 원격 worker는 pinned host key·vault private key·absolute workspace root로 등록하고 forwarding/password/TOFU를 끈 `wam-worker/v1` probe/start/status만 실행한다. 프로젝트 path는 workspace root 내부로 제한하고 task 카드의 별도 확인 뒤 probe가 선언한 `build|test|verify|preview`만 제한 JSON으로 멱등 접수한다. ACK 유실·재시작은 unknown으로 보존해 자동 재전송하지 않고 host 1개·전역 4개 SSH 상한을 적용했다. 원격 host용 worker CLI도 owner-only 설정의 absolute executable·고정 argv만 shell 없이 detached 실행하고 exact schema·realpath·동시성·timeout·출력 redaction을 강제한다. 실제 host 설치와 프로젝트별 recipe 승인은 운영 단계로 남는다. 선택 PR 하나의 head/check/review/conflict/native auto-merge 상태는 보이는 탭에서만 15초 polling하고, 예약 직전 동일 head와 최소 1개 check·failed/unavailable 0·non-draft·mergeable·변경 요청 없음 조건을 재검증한다. 조건 충족 뒤에도 WAM이 직접 branch protection을 우회하지 않고 GitHub `--auto --match-head-commit`에 맡기며 예약/취소는 관리자+최근 재인증+신뢰 네트워크와 task event 요약에 연결한다. 특정 SaaS 자격증명을 무근거로 늘리지 않고 공통 signed outbound webhook을 추가했다. endpoint 전체와 HMAC secret은 vault에만 저장하고 hostname만 표시하며, HTTPS·공개 DNS 전체 일치·실제 TLS lookup IP pin·redirect 차단·10초 timeout을 강제한다. 알림은 event ID 기준 중복을 막는 고정 JSON과 timestamp-bound SHA-256 HMAC만 보내고 설정/테스트는 관리자+최근 재인증+신뢰 네트워크에 한정한다.

## 9. 현재 프로젝트별 초기 프로필

| 프로젝트 | 기본 profile | 기본 검증 | 보호 작업 |
| --- | --- | --- | --- |
| WSS-Server | Java/Spring backend · high reasoning · workspace-write | 변경 대상 Gradle test → `./gradlew test`; API 문서 변경 시 `apiDocs` | 운영 DB·Redis, 인증키, 배포, schema 직접 반영 |
| WSS-admin-web | React/Express full-stack · workspace-write | backend test/build + frontend build; UI 변경은 viewport 확인 | 외부 MySQL, AWS/CloudWatch, FCM, SQL 자동 실행 |
| myagent | provider-runtime · high reasoning · workspace-write | 관련 Vitest → typecheck → `npm run verify`; UI는 Playwright | 운영 DB, 서버 재시작, tmux/CLI 종료, 릴리즈 |
| geulmeok-frontend | React/Tailwind UI · workspace-write | `npm run build` + 390/1280 시각 확인 | 형제 저장소 쓰기, GoCD 배포·대기 |
| geulmeok-scrap | fixture-first scraper · high reasoning | 저장 원본 parser 회귀 검사; 향후 pytest gate 추가 | live scrape, 운영 DB, 세션 쿠키, daily trigger, 장시간 수집 |
| resume | evidence-writing · read-only 기본 | 근거 링크·수치 대조, HTML/PDF 페이지·레이아웃 검사 | 개인정보 원문 저장, 근거 없는 수치, 기존 제출본 덮어쓰기 |
| 스터디 | tutor · single agent | 학습 상태·기록 파일 일관성 검사 | 다중 에이전트 대리 답변, 커리큘럼 무단 변경, 이웃 저장소 접근 |
| genshincalculator | simulation-safe · high reasoning | 관련 Vitest → `npm test` → `npm run typecheck` | gcsim 잠금 해제, 전체 benchmark, 대규모 탐색, 버전·데이터 갱신 |

초기 profile을 만들 때 저장소 파일을 자동 변경하지 않는다. `AGENTS.md`가 없는 프로젝트에는 생성 초안만 보여주고 사용자가 승인한 뒤 기록한다.

2026-09-13 read-only 재분석에서 8개 모두 고유 추천 ID와 검증 recipe·보호 작업을 반환했다. 실제 wrapper/script가 없는 경우 명령을 만들지 않고 경고하며, 분석 포함 전체 활성 profile 수는 아직 0이므로 owner 승인 전 완료로 판정하지 않는다.

## 10. 관측 지표와 알림

### 핵심 지표

- `prompt_commands_received_total`
- `prompt_dispatch_attempts_total`
- `prompt_duplicate_dispatch_prevented_total`
- `prompt_delivery_unknown_total`
- `prompt_reconciliation_seconds`
- `task_state_age_seconds`
- `task_state_transition_invalid_total`
- `provider_structured_adapter_ratio`
- `provider_tui_fallback_total{reason}`
- `provider_event_mismatch_total`
- `verification_runs_total{status,kind}`
- `verification_duration_seconds{project,kind}`
- `provider_canary_runs_total{result,version}`
- `websocket_revoked_session_disconnect_seconds`

### 알림 기준

- `delivery_unknown`이 새로 생기면 사용자에게 즉시 확인 요청
- 동일 command의 두 번째 dispatch 시도가 차단되면 운영 경고
- task가 profile의 허용 시간을 넘어 같은 상태에 머물면 stuck 경고
- 구조화 이벤트와 TUI/JSONL shadow 결과가 다르면 provider compatibility 경고
- canary 실패 시 업데이트 차단 알림
- 검증 artifact redaction 실패 시 외부 알림·다운로드 차단

## 11. 테스트 전략

### 단위 테스트

- 상태 전이 표와 불가능한 전이
- 멱등 키·event sequence·projection
- capability negotiation과 폴백 선택
- profile merge·version pinning·보호 규칙
- verification recipe 선택과 redaction

### 통합 테스트

- 가짜 구조화 공급자와 가짜 PTY를 같은 contract suite로 실행
- DB transaction 중단과 서버 재시작 복구
- 지연·중복·역순 훅 및 JSONL 이벤트
- WebSocket 재연결과 sequence 보충
- profile 변경 중 실행된 task의 불변성

### E2E

- 새 채팅 첫 입력, resume 입력, 작업 중 follow-up
- 승인 요청·거절·재시도
- rate limit 대기와 reset 후 재개
- 검증 성공·실패·사용자 승인 대기
- 프로젝트 전환 중 task 상태 유지
- 모바일에서 접수 상태·확인 필요·승인 처리

### 장애 주입

- 접수 직후 서버 종료
- CLI stdin write 직후 프로세스 종료
- ACK·hook·JSONL 각각 유실 또는 지연
- SQLite busy와 디스크 용량 부족
- WebSocket 단절과 중복 reconnect
- CLI 업데이트 후 이벤트 schema 변화

## 12. 배포와 롤백

### Feature flag

- `WEB_AGENT_MANAGER_TASK_LEDGER_V1`
- `WAM_STRUCTURED_CODEX_SESSIONS`
- `WAM_STRUCTURED_CLAUDE_SESSIONS`
- `WAM_PROJECT_PROFILES`
- `WAM_VERIFICATION_GATES`
- `WAM_PROVIDER_UPDATE_CANARY`

### 단계 배포

0. 새 build 재시작 전 read-only `npm run deploy:check`로 SQLite quick-check, 현재 release 대비 schema drift, busy/전이 채팅과 ACK 전 command·검증/실험/rollout/remote dispatch를 확인한다. 이어 `npm run deploy:drill`로 운영 DB의 online snapshot에만 current migration을 적용해 integrity, foreign key, durable count, 전체 schema와 임시 test_only credential hash를 검증한다. migration이 필요하면 DB를 migration 없이 여는 `npm run backup:create`로 암호화 snapshot과 임시 빈 환경 실제 복구 검증을 완료하고 package/passphrase를 분리 보관한 뒤 blocker가 0인 시점만 선택한다.
1. schema와 event 기록만 추가하고 기존 UI·상태 판정은 유지한다.
2. 기존 상태와 새 projection을 shadow 비교한다.
3. 신규 채팅 일부만 새 원장과 구조화 어댑터를 사용한다.
4. 프로젝트별 opt-in으로 profile과 gate를 적용한다.
5. 운영 관찰 기간 뒤 신규 채팅 기본값을 전환한다.
6. 기존 직접 `busy` 갱신과 화면 기반 성공 판정을 제거한다.

### 롤백 원칙

- 모든 초기 migration은 새 테이블·nullable 컬럼만 추가한다.
- flag를 끄면 기존 tmux/JSONL 경로로 돌아가되 새 event 데이터는 보존한다.
- structured adapter 실패가 task command를 다시 생성하거나 재전송하지 않게 한다.
- profile/gate 롤백은 채팅 시작 당시 pinned version을 보존한다.
- DB downgrade가 필요한 파괴적 rollback은 하지 않는다.

## 13. 작업 분해

### Epic A · Task ledger

1. 상태·이벤트 계약 문서와 shared type
2. 추가형 DB migration과 repository
3. HTTP idempotency와 client UUID
4. dispatcher lease·recovery worker
5. SessionManager bridge
6. task projection과 busy 호환 계층
7. timeline API·UI
8. restart/ambiguity 회귀 테스트

### Epic B · Structured adapters

1. capability와 normalized event 계약
2. 공통 adapter contract suite
3. Codex app-server session spike
4. Codex shadow adapter
5. Codex 단계 전환
6. Claude stream/hook adapter
7. Grok capability·fallback 명시
8. provider compatibility dashboard

### Epic C · Project profiles

1. profile/version schema
2. 기존 Agent preset 변환 경계
3. stack/instruction/command detector
4. profile draft UI
5. chat/task pinning
6. permissions·protected actions enforcement
7. 8개 활성 프로젝트 초안

### Epic D · Verification gates

1. recipe와 step runner
2. artifact store·hash·redaction
3. diff 기반 step 선택
4. task verifying projection
5. PR check 연동 — 완료
6. 결과·재실행 UI — 완료

### Epic E · Runtime safety

1. canary suite와 격리 HOME
2. version/capability snapshot
3. 단계 업데이트·rollback
4. 영속 login limiter
5. MFA·session control
6. WebSocket revocation
7. 전체 backup/restore

## 14. 첫 실행 묶음

다음 일곱 작업을 첫 milestone으로 잡는다.

1. `TODO_LIST.md`와 완료 이슈 정리 — 완료(#90~#103 구현·운영 커밋 연결 후 종료)
2. `PromptCommand`, `AgentTask`, `AgentTaskEvent` 상태 계약 확정 — 구현·단위 검증 완료
3. 일반 프롬프트 원장 migration과 repository 구현 — 구현·재시작 검증 완료
4. `/messages` 요청의 멱등 접수와 기존 `SessionManager` bridge — 구현·HTTP 검증 완료
5. `delivery_unknown` 비파괴 복구 UI — 구현·회귀 검증 완료
6. 서버 종료·ACK 유실·follow-up 중복 회귀 테스트 — 구현·통과
7. 운영 shadow 지표로 기존 제출 판정과 새 원장 결과 비교 — 지표·쿼리 구현 완료, 실제 운영 관찰 대기

첫 milestone에서는 app-server 전환, 프로젝트 profile, 검증 명령 실행을 함께 넣지 않는다. 프롬프트 접수와 상태 정본이 안정된 다음 각각 독립 milestone로 진행한다.

## 15. 전체 완료 정의

다음을 모두 만족할 때 이 로드맵의 핵심 범위를 완료로 본다.

- 모든 일반 입력이 멱등 command와 task event 원장에 기록된다.
- WAM이 제출 여부를 모르면 성공·실패를 추측하거나 자동 재전송하지 않는다.
- 신규 Codex 채팅의 정상 경로가 구조화 이벤트를 사용하고 TUI는 폴백이 된다.
- 모든 활성 프로젝트에 승인된 profile과 검증 recipe가 있다.
- task 완료는 검증 gate 결과와 연결된다.
- CLI 업데이트는 canary를 통과해야 운영 기본값이 된다.
- 세션 폐기와 권한 변경이 열린 WebSocket에 즉시 반영된다.
- 전체 백업을 빈 환경에 복구하는 자동 테스트가 통과한다.
- 작업 보드가 서버 재시작 뒤 task 원장에서 동일하게 복원된다.
- TODO, 이슈, 코드, 운영 dashboard의 milestone 상태가 서로 일치한다.

## 16. 2026-09-13 종료 감사

코드만으로 확정할 수 있는 항목과 실제 운영 관찰·사용자 승인이 있어야 하는 항목을 섞지 않는다.

| 범위 | 판정 | 근거 또는 다음 입력 |
| --- | --- | --- |
| Phase 0·1 task ledger | 코드·격리 QA 완료 | 일반 prompt command/task/event, 멱등 dispatch, ACK 유실·재시작·`delivery_unknown` 회귀와 익명 지표 구현 |
| Phase 2 구조화 adapter | 코드·격리 limited rollout/acceptance harness QA 완료, 운영 전환 대기 | Codex app-server shadow, 신규 채팅 quota transport, ACK 증거·재시작 비재전송·chat provenance·10단계 실제-stdio harness/UI를 완료. 실제 전용 seed 실행, 7일 두 gate와 사람의 quota 확대 승인 전에는 기본 전환 불가 |
| Phase 3 project profile | 플랫폼·8개 맞춤 초안·실행 정책 강제·batch readiness 완료, 프로젝트별 활성화 대기 | 추천 catalog를 실제 초안과 불변 출처에 연결하고 저장/활성화/실험 승격/채팅 launch에서 안전 parser 및 공급자별 argv를 검증한다. 실제 활성 version은 각 저장소 owner가 readiness 부족 항목과 지침·검증 명령·보호 작업을 승인해야 하며 운영 DB에 자동 반영하지 않음 |
| Phase 4 verification gate | 완료 | diff/profile/commit 고정, 선택 recipe, artifact redaction/quarantine, PR check, live/human 승인, UI·성능 QA 완료 |
| Phase 5 CLI canary/rollout/rollback | 코드·격리 QA 완료 | 공급자별 유료 test credential과 candidate harness는 운영자가 opt-in할 때만 실제 실행 |
| Phase 6 security/backup | 완료 | 영속 limiter, TOTP, session/WS 폐기, re-auth, 배포 진단, vault, 빈 환경 restore drill 완료 |
| Phase 7 task board/routing | 완료 | 원장 projection, checkpoint, 근거 있는 추천, 승인형 적용, 동시성 queue·재시작 복원 완료 |
| Phase 8 workbench | 코드 완료, remote worker 운영 배포 대기 | preview/browser 증거, hunk/line feedback, visual/a11y, SSH pin/probe, workspace 제한 mapping, 명시 승인형 멱등 task start/status client, 고정 recipe worker CLI, PR auto-merge, signed webhook 완료. 실제 host 설치·프로젝트별 recipe 승인은 별도 필요 |
| Monaco editor | 선택하지 않음 | 현재 편집기는 256KiB 상한, 민감경로 차단, dirty 이동 확인, 저장을 제공한다. production 초기 JS가 약 1.04MB이므로 명확한 대형 파일/검색/다중 cursor 요구 없이 Monaco를 추가하지 않음 |

최신 전체 자동 QA 기준선은 TypeScript, Vitest 170파일 1,286개, production client/server/worker와 self-contained canary, deployment preflight/drill, pre-migration backup/tester CLI build·공개 경로 검사, Chrome 49개 통과·운영 로그인 credential 필요 1개 skip·실패 0개다. Phase 2 limited transport는 fake app-server·실제 SQLite/Express/SessionManager를 연결해 350ms connect+350ms ACK에서도 HTTP가 1.5초 안에 끝나고 동일 command가 한 번만 `turn/start` 되는지 확인했으며, 별도 Chrome에서 350ms 지연 중 500ms 이내 피드백·TUI 제어 차단·390px 무overflow를 확인했다. 프로젝트 profile UI도 350ms 분석·저장·활성화·readiness 지연에서 500ms 이내 진행 피드백과 모바일 무overflow를 통과했고, 운영 SQLite를 read-only로 연 실제 8개 프로젝트 맞춤 초안 계산은 총 3.676ms였다. Codex acceptance harness의 실제 stdio fake 10단계는 3.258초, credential marker 선차단은 352ms, timeout과 자식 process group 정리는 1.170초에 통과했다. 배포 preflight는 5,000개 stopped chat fixture에서 1초 상한을 통과했고, 운영 DB 10회 read-only 반복은 p50 59.455ms·p95 174.483ms·최대 319.110ms, 실행 중 서버 `/health` 20회는 p50 2.981ms·p95 5.792ms·최대 51.755ms였다. production pre-migration backup CLI를 최신 table이 없는 임시 legacy DB에 실행한 실제 복구 검증은 251ms였고 원본 DB byte 불변, package 0600, 평문 marker·passphrase 비노출을 확인했다. production backup+tester secret-file handoff 통합은 723ms에 끝났고 test_only scope/hash 저장, 원문 비출력, legacy schema 무변경 차단을 확인했다. 실제 운영 DB snapshot의 production deployment drill은 migration 45.376ms·전체 1.117초였으며 source schema 불변, integrity 정상, foreign-key 위반 0, 기존 durable count 보존, current 85 table·누락 table/column 0과 임시 test_only hash 검증을 통과했다. test_only의 권한은 canary·일반 verification과 자기 로그인 보안 밖으로 확대하지 않았고 app-server 공급자 credential seed와도 분리했다.

2026-09-13 운영 preflight 시점의 SQLite quick-check는 정상이지만 실행 중 서버는 새 build보다 이전 세대이며, 현재 release 기준 28개 table·17개 column migration과 검증된 사전 백업이 필요하다. 진행 중인 busy 채팅 1개만 workload blocker이고 verification/canary/update/rollout/remote/structured dispatch blocker는 0이었다. 운영 환경에는 백업 passphrase나 기존 full-backup package가 없어 실제 백업은 아직 생성하지 않았다. 이 진단은 read-only였으며 운영 서버·DB·프로젝트·CLI·credential을 변경하거나 재시작하지 않았다.

따라서 현재 저장소에서 안전하게 자동 완결할 수 있는 profile 기반 구현까지 진행했지만 로드맵의 운영 완료 선언은 다음 세 가지 증거가 들어온 뒤에만 가능하다.

1. Codex structured shadow 7일 관찰 결과와 전용 credential limited acceptance
2. 프로젝트별 profile 초안에 대한 owner 승인
3. 원격 host에 `web-agent-manager-worker` 설치·프로젝트별 capability recipe 승인과 격리 host acceptance
