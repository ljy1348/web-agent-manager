# 에이전트 실험실 설계 및 구현 계획

## 1. 한 줄 정의

하나의 작업 명령을 미리 저장한 여러 실행 조건으로 반복 실행하고, 비용·시간·산출물·에이전트 심사 결과를 같은 화면에서 비교하는 재현 가능한 실험 기능이다.

### 핵심 전제

공정한 실험은 Claude Code와 Codex의 native 차이를 무조건 없애는 것이 아니다. **무엇을 통제하고 무엇을 평가 대상으로 삼는지 실험 정의에 명시하는 것**이다. 모델만 비교할 때는 도구·권한·지침을 통제하고, 하네스 전체를 비교할 때는 공급자 native 도구·기본 컨텍스트까지 평가 변수에 포함한다. 선언하지 않은 차이가 발견되면 결과를 막기보다 비교 유효성 경고를 표시한다.

## 2. 목표와 범위

### 제품 목표

- 같은 모델에서 스킬 사용 여부만 바꾼 A/B 실행을 지원한다.
- 모델, 공급자, 프롬프트, 스킬, 하네스, 루프, 훅, 멀티 에이전트 구성을 독립 변수로 저장한다.
- 각 실행의 입력·출력·추론·캐시 토큰, 경과 시간, 종료 이유, 도구 호출, 산출물을 보존한다.
- 복수의 심사 에이전트가 결과를 독립적으로 평가하고 합의·불일치·편향 가능성을 표시한다.
- 자동 점수와 별도로 사용자의 최종 판정을 기록한다.
- 선택한 우승 Variant를 버전 있는 실제 WAM Agent preset으로 승격해 일반 작업에 사용한다.
- 중단된 실행을 체크포인트에서 재개하고 예산·반복 횟수·시간으로 무한 루프를 차단한다.

### 첫 구현 범위(MVP)

1. 실험·변형(variant)·실행(run)·노드·이벤트·산출물·평가 데이터 모델
2. Codex `exec --json`과 Claude print/stream JSON을 공통 이벤트로 바꾸는 비대화형 런타임
3. 단일 실행, 조정자-작업자, 평가자-개선자 루프 하네스
4. 스킬 켜기/끄기, 모델·추론 강도·샌드박스·예산·최대 반복 설정
5. 실행 전후와 노드·평가 경계에 적용되는 WAM HookBus
6. 결정적 검사, 블라인드 루브릭 평가, 쌍대 비교, 사용자 최종 판정
7. 실험 목록·상세·실행·중단·재개 API와 비교 UI

Claude Agent Teams처럼 공급자 자체가 제공하는 실험적 팀 기능은 후속 프로필로 둔다. MVP 멀티 에이전트는 WAM이 실행 그래프와 상태를 소유해 공급자가 달라도 동일한 방식으로 비교할 수 있게 한다.

## 3. 설계 원칙

- **격리:** 각 변형은 독립 작업 디렉터리와 설정 오버레이를 사용하며 전역 설정을 수정하지 않는다.
- **재현성:** 프롬프트, 모델, CLI 버전, 스킬 경로·해시, 설정, 기준 커밋, 환경 요약을 실행 스냅샷에 고정한다.
- **공정성:** 비교 변형은 명시적으로 달라진 조건 외에는 같은 입력, 제한, 기준 커밋을 사용한다.
- **비교 유효성:** 모델 버전·실행 시각·도구·권한 프로필이 다른 실행에는 차이를 표시하고, 통제하지 않은 조건이 있으면 비교 경고를 낸다.
- **관측 가능성:** 모든 상태 변화는 append-only 이벤트로 남기고 현재 상태는 이벤트에서 투영한다.
- **중단 안전성:** 노드 경계마다 체크포인트를 저장하고 멱등 키로 중복 실행을 막는다.
- **비용 분리:** 작업 에이전트 비용과 심사 에이전트 비용을 각각 집계한다.
- **블라인드 평가:** 심사 시 변형 이름·공급자·모델 정보를 숨기고 순서를 무작위화한다.
- **기존 기능 보호:** 대화형 tmux 세션은 `SessionManager`, 실험은 별도 `AgentRuntime`이 담당한다.

## 4. 전체 구조

```text
실험 정의/API/UI
      │
      ▼
ExperimentService ── 예산·취소·재개·비교 정책
      │
      ▼
HarnessEngine ────── Single / OrchestratorWorker / EvaluatorOptimizer
      │                         │
      │                         ├─ HookBus
      │                         ├─ CheckpointStore
      │                         └─ ArtifactStore
      ▼
AgentRuntime
  ├─ CodexExecRuntime  ── codex exec --json
  └─ ClaudePrintRuntime ─ claude -p --output-format stream-json
      │
      ▼
정규화 이벤트·토큰·산출물 ── SQLite 원장 ── 비교/평가 UI
```

기존 `AgentBridge`는 사용자가 만드는 일반 자식 채팅 위임에 계속 사용한다. 실험 그래프는 실행 단위의 재시도·체크포인트·조건 스냅샷이 필요하므로 일반 위임 레코드와 섞지 않는다. 기존 `TokenUsageLedger`도 대화 기록용으로 유지하고, 실험 런타임이 직접 받은 구조화 usage는 실험 실행 원장에 저장한 뒤 통계 화면에서 합산할 수 있게 한다.

## 5. 도메인 모델

| 개체 | 역할 | 핵심 필드 |
| --- | --- | --- |
| `experiment` | 한 작업과 비교 목적 | 이름, 명령, 가설, 통제 변수, 평가 변수, 반복·무작위화, 루브릭, 상태 |
| `experiment_variant` | 한 실행 조건 묶음 | 모델, 스킬, 하네스, 훅, 예산, 반복 정책 |
| `experiment_run` | 변형의 실제 1회 실행 | 스냅샷, 상태, 시작/종료, 종료 이유, 합계 usage |
| `experiment_node` | 그래프의 에이전트 한 번 호출 | 역할, 시도 번호, 입력/출력, 부모 노드 |
| `experiment_event` | append-only 상태/관측 원장 | 순번, 종류, payload, 발생 시각 |
| `experiment_checkpoint` | 재개 가능한 노드 경계 | 그래프 상태, 다음 노드, 산출물 참조 |
| `experiment_artifact` | 파일·패치·보고서 등 결과 | 종류, 경로, 해시, 크기, 미리보기 |
| `experiment_evaluation` | 평가 한 라운드 | 방식, 루브릭 버전, 블라인드 매핑 |
| `experiment_evaluation_call` | evaluator CLI 한 번 | 멱등 키, 모델·계정·CLI, 상태, usage·비용·오류 |
| `experiment_judgment` | 심사 에이전트 한 명의 판단 | 점수, 근거, 순위, 신뢰도, usage |
| `experiment_human_verdict` | 사용자 최종 판단 | 선택 변형, 메모, 채택 여부 |
| `agent_preset` | 실제 작업에서 선택할 운영 설정 | 프로젝트, 이름, 활성 버전, 상태 |
| `agent_preset_version` | 승격 당시의 불변 설정 | 출처 실험·변형·run, 설정 스냅샷, 지표, 버전 |

변형 설정은 버전이 있는 JSON 스키마로 저장한다. 실행 시작 시 해석된 최종 설정도 별도로 복사해 이후 기본값 변경의 영향을 받지 않게 한다.

```json
{
  "schemaVersion": 1,
  "runtime": {
    "provider": "codex",
    "model": "configured-default",
    "reasoningEffort": "high",
    "sandbox": "workspace-write",
    "maxTurns": null
  },
  "skills": {
    "mode": "all",
    "enabled": [],
    "disabled": [],
    "profile": "isolated_overlay",
    "baseline": "installed",
    "additions": ["lab:review"],
    "comparisonId": "codex-default",
    "activation": "native"
  },
  "harness": {
    "type": "single",
    "maxIterations": 1,
    "minimumScore": null
  },
  "hooks": ["artifact_manifest", "test_command"],
  "budget": {
    "maxSeconds": 1800,
    "maxTokens": 200000,
    "maxCostUsd": null
  }
}
```

## 6. 실행 상태와 종료 조건

실험 실행 상태는 다음과 같다.

```text
queued → preparing → running → evaluating → completed
                     │    │          │
                     ├────┴──────────┴→ failed
                     ├───────────────→ cancelled
                     └───────────────→ budget_exceeded

running → paused → running
```

모든 루프는 다음 종료 이유 중 하나를 반드시 남긴다.

- `success`: 완료 조건 충족
- `max_iterations`: 최대 반복 도달
- `max_turns`: 공급자 내부 turn 상한 도달(`max_iterations`와 별도)
- `token_budget`, `time_budget`, `cost_budget`: 예산 소진
- `no_improvement`: 정해진 횟수 동안 개선 없음
- `runtime_error`, `hook_error`, `evaluation_error`: 계층별 오류
- `cancelled`: 사용자 취소
- `policy_blocked`: 권한·샌드박스 정책 차단

중단 요청은 먼저 현재 자식 프로세스에 정상 종료 신호를 보내고 제한 시간 뒤 강제 종료한다. 체크포인트는 완료된 노드까지만 확정해 부분 출력이 재개 입력에 중복 합쳐지지 않게 한다.

## 7. 공통 런타임 계약

공급자 어댑터는 대화 UI 파싱이 아니라 아래 계약만 구현한다.

```ts
/** 비대화형 에이전트 실행을 공통 이벤트 스트림으로 변환한다. */
interface AgentRuntime {
  prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot>;
  run(input: RuntimeRunInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  resume(input: RuntimeResumeInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  cancel(runId: string): Promise<void>;
}

type RuntimeEvent =
  | { type: "started"; providerRunId?: string; details?: object }
  | { type: "message"; role: string; text: string; parentToolCallId?: string }
  | { type: "tool_started" | "tool_finished"; name: string; toolCallId?: string; parentToolCallId?: string; payload: unknown }
  | { type: "usage"; usage: RuntimeUsageSnapshot }
  | { type: "artifact"; path: string; kind: string }
  | { type: "completed"; result: unknown }
  | { type: "failed"; error: string; reason?: ExperimentTerminationReason };
```

### Codex 런타임

- `codex exec --json`의 JSONL 이벤트를 정규화한다.
- 필요한 경우 `--output-schema`, `--model`, `--sandbox`, `--cd`와 실행별 config override를 사용한다.
- `thread.started`, `turn.*`, `item.*`, usage를 원본 이벤트와 함께 보존한다.

### Claude 런타임

- `claude -p --output-format stream-json --verbose`의 init/assistant/user/result JSONL을 정규화하고 session ID로 resume한다.
- `runtime.maxTurns`는 `claude --help` 출력에 실제 옵션이 존재할 때만 전달한다. Claude 2.1.231은 알 수 없는 인자를 성공 코드로 무음 수용하므로 실행 성공 여부를 capability로 간주하지 않는다. 이는 하네스 반복 횟수와 독립이다.
- Claude가 보고하는 `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`를 분리하고 합계는 WAM 파생값으로 표시한다. 비용은 `total_cost_usd` 보고값을 사용한다.
- native `skills:none`은 `--disable-slash-commands`를 사용한다. strict single 비교는 별도 plugin bundle로 installed/clean/additions를 구성하며 native selected 또는 일부 disabled 조합은 실험 조건을 왜곡하지 않고 거부한다.
- read-only는 native `plan`, workspace-write는 `acceptEdits`, danger-full-access는 bypass 권한으로 매핑하고 이 native 의미 차이를 환경 provenance에 남긴다.

공통 JSONL runner는 prompt를 argv가 아닌 stdin으로 보내며 shell을 사용하지 않는다. POSIX에서는 CLI를 별도 프로세스 그룹으로 실행해 취소 시 그 CLI가 만든 Bash·MCP·서브에이전트 후손까지 TERM→grace→KILL하고, Windows에서는 직접 자식 종료로 대체한다.

`--include-hook-events`, `--forward-subagent-text`, `--include-partial-messages`는 기본 SingleHarness의 중복 이벤트를 늘리므로 켜지 않는다. 이후 훅·서브에이전트 자체를 평가 변수로 삼는 명시적 native 프로필에서만 capability와 원본 fixture를 고정한 뒤 사용한다.

첫 구현은 이미 설치된 공식 CLI를 자식 프로세스로 실행한다. 새로운 SDK 의존성을 추가하지 않아 기존 인증 저장소를 읽거나 복제하지 않고, 이후 세밀한 제어가 필요하면 Codex App Server 또는 각 공급자 SDK 런타임을 같은 계약 아래 추가한다.

## 8. 스킬 켜기/끄기 실험

strict single 비교는 같은 provider 안에서 다음 네 조건을 만든다.

| 기준선 | 추가 없음 | 선택 스킬 추가 |
| --- | --- | --- |
| 현재 설치 custom skills | `installed` | `installed + additions` |
| 공급자 built-in만 | `clean` | `clean + additions` |

Claude 2.1.231 실측에서 `--disable-slash-commands`는 built-in까지 모두 제거하고 `--setting-sources`는 settings·MCP·hook에도 영향을 줬다. 따라서 strict 비교의 모든 Claude arm에 같은 `--setting-sources ""`와 `--strict-mcp-config`를 적용하고, 현재 설치된 project/user custom skills와 선택 additions를 실행별 Claude plugin bundle로 다시 구성한다. Codex는 사용자 config를 유지한 채 `--strict-config`와 디렉터리 경로의 `skills.config`만 사용해 발견된 custom skills를 켜거나 끄고 additions 디렉터리를 활성화한다. 두 공급자 모두 전역 설정을 수정하지 않는다.

Claude의 `activation`은 `native`와 `session_start`를 구분한다. `native`는 Claude의 스킬 발견·선택 자체를 평가한다. `session_start`는 자동 발견만으로 켜지지 않는 스킬을 평가하기 위해 모든 arm의 실행별 plugin에 동일한 무상태 SessionStart 훅을 넣고, 공통 머리말 뒤에 처리군 additions의 frontmatter를 뺀 지시 본문만 이어 붙인다. 생성 훅은 bundle의 정적 파일만 읽어 stdout으로 내보내며 사용자 `CLAUDE_CONFIG_DIR`, statusline, mode flag를 읽거나 쓰지 않는다. 따라서 제3자 plugin의 UI·상태 관리 부작용은 treatment에서 제외되고, 그 plugin의 지시 본문 효과만 측정한다. full native plugin hook 자체를 평가하려면 별도 plugin 후보·부작용 격리가 필요하다.

후보는 공급자의 현재 project/user/system 위치, 프로젝트 `.agent-lab/skills`, WAM `skills/`에서 찾는다. 선택한 스킬은 `SKILL.md` 하나가 아니라 해당 디렉터리 전체를 실행별 bundle로 복사하며 내부 symlink·특수 파일, 스킬당 500파일·10MiB 초과를 거부한다. 상대 경로·크기·mode·SHA-256을 digest로 고정하고 실행 성공·실패 모두에서 변조를 확인한다. Git에서 제외된 project skills도 원본 checkout에서 detached worktree로 고정 복제하고 별도 digest를 남긴다.

같은 `comparisonId`의 Variant는 provider·계정·모델·reasoning·sandbox·하네스·훅·예산·스킬 활성화 방식이 같아야 한다. 모델·reasoning은 명시값만 허용하고, Git HEAD가 기존 run과 달라지면 실행을 거부한다. `session_start`는 Claude single에서만 허용한다. strict additions는 실행 시 공급자별 bundle을 따로 만들어 graph/loop에서도 허용한다. 다만 SessionStart 주입은 Claude 전용 plugin hook이라 single에서만 쓴다.

### 공정성 규칙

- 스킬 외 조건을 같게 고정한다.
- 스킬이 참조하는 파일도 해시로 기록한다.
- 첫 실행 순서 편향을 줄이기 위해 반복 실행 순서를 무작위화하거나 교차한다.
- 각 변형을 1회만 실행한 결과는 성능 결론이 아니라 관찰값으로 표시한다.
- 반복 결과에는 평균만이 아니라 분산·신뢰구간과 표본 수를 함께 표시한다.

## 9. 하네스와 루프

### `SingleHarness`

한 에이전트가 한 번 수행한다. 모델·스킬 효과의 기준선이며 가장 먼저 구현한다.

현재 구현은 queued run 하나를 준비 snapshot, 단일 `worker` node, Runtime 이벤트·provider session ID·usage/cost, HookBus, 하드 예산과 사용자 취소, 완료 node 체크포인트에 연결한다. 최초 종료 이유를 고정해 사용자 취소와 동시에 예산 타이머가 발화해도 결과가 뒤집히지 않으며, Runtime이 완료/실패 이벤트 없이 끝나면 성공으로 추정하지 않고 `runtime_error`로 종료한다.

### `OrchestratorWorkerHarness`

조정자가 작업을 분해하고 독립 agent session의 작업자들이 노드를 수행한 뒤 조정자가 결과를 합친다. 목표 구조에서는 작업자별 디렉터리를 격리하고, 동일 파일을 수정해야 하는 작업은 병렬 배치하지 않은 채 조정자가 병합 순서를 정한다.

현재 첫 구현은 primary Runtime의 read-only 계획, secondary Runtime 작업자 1~8명의 workspace-write 실행, primary 통합을 한 detached worktree에서 순차 실행한다. 각 호출은 별도 node·Runtime session이며 부모 관계와 답변·usage를 기록한다. 파일 충돌과 측정 CPU 경합을 피하려고 병렬 실행은 아직 하지 않으며, worker별 worktree와 patch merge는 후속 격리 단계다.

### `EvaluatorOptimizerHarness`

초안 생성 → 평가 → 개선을 반복한다. 최소 점수, 최대 반복, 무개선 허용 횟수, 예산 중 먼저 만족한 조건으로 종료한다. 평가 원문과 개선 지시는 각 반복에 연결해 왜 결과가 바뀌었는지 추적한다.

현재 구현은 primary가 초안/개선을 workspace-write로 수행하고 secondary가 read-only에서 `score`·`reason` JSON을 반환한다. 최소 점수에 도달하면 마지막 후보를 완료하고, 최대 반복·무개선·공통 시간/토큰/비용 예산은 세분화된 종료 이유로 run을 끝낸다. 역할별 provider·계정·model은 Variant snapshot에 고정한다.

### 공급자 네이티브 프로필

- Codex custom agents/subagents 구성은 별도 변형 프로필로 지원한다.
- Claude subagents는 별도 변형 프로필로 지원한다.
- Claude Agent Teams는 실험적 기능이며 재개·작업 조정·종료에 알려진 제약이 있어 MVP 기본값에서 제외하고 명시적 opt-in으로만 제공한다.

## 10. WAM HookBus

훅은 실험 상태를 직접 임의 변경하지 않고 명시된 이벤트와 반환 계약을 사용한다.

```text
before_run / after_run
before_node / after_node
before_tool / after_tool
before_evaluate / after_evaluate
on_checkpoint / on_budget / on_error
```

훅은 `observe`, `transform`, `validate`, `block` 네 종류로 구분한다. 기본 타임아웃과 실패 정책(`fail_run`, `warn`, `ignore`)을 저장한다. 변형 간 비교에서 훅이 다르면 독립 변수로 명시하며, 비결정적 외부 호출을 한 훅은 재현성 경고를 표시한다.

기본 훅은 `observe`만 허용한다. 입력 변경이나 실행 차단이 가능한 훅은 변형에 명시적으로 opt-in하고, 변경 전후 payload를 이벤트로 남겨야 한다.

초기 내장 훅은 다음으로 제한한다.

- 산출물 manifest와 SHA-256 생성
- 허용된 검증 명령 실행 및 결과 수집
- 민감 경로·대용량 파일 산출물 제외
- 노드 전후 Git diff 통계 수집

현재 UI에서 실행 가능한 ID는 `diff_stats`와 `git_diff_check`다. 전자는 `after_node` payload에 tracked 파일·추가·삭제 줄 수를 더하고, 후자는 `git diff --check` 실패를 validate 정책 차단으로 바꾼다. 임의 shell/명령 문자열은 Variant가 등록할 수 없다.

공급자 자체 훅은 원본 이벤트로 수집할 수 있지만 WAM HookBus와 동일한 의미라고 간주하지 않고 별도 출처로 표시한다.

## 11. 결과 평가

평가는 작업 실행과 분리된 단계다.

1. **결정적 검사:** 테스트 통과, JSON Schema, 파일 존재, lint, 사용자 지정 명령
2. **독립 루브릭 심사:** 정확성·완전성·안전성·유지보수성 등을 0~1 또는 1~5로 채점
3. **쌍대 비교:** A/B와 순서를 뒤집은 B/A를 모두 물어 위치 편향을 확인
4. **합의 계산:** 중앙값, 분산, 순위 일치율, 심사자별 이탈값 표시
5. **사용자 판정:** 채택, 기각, 보류와 메모 기록

심사 입력에는 변형 이름, 공급자, 모델, 스킬 사용 여부를 숨긴다. 심사자는 구조화된 JSON Schema로 점수, 근거, 확인한 증거, 불확실성, 최종 순위를 반환한다. 판정 모델과 피험 모델의 계열 분리는 강제하지 않는다. Claude 결과를 Claude·Codex·사람이 각각 판단하고 Codex 결과도 같은 평가자 집합으로 판단할 수 있으며, 동일 계열 심사는 금지 대상이 아니라 self-bias 측정 대상이다.

evaluator Runtime도 공급자 capability를 따른다. 현재 Claude CLI가 `maxTurns`를 지원하지 않으면 제한을 전달하지 않고 WAM 시간·토큰·비용 예산으로 종료를 통제하며, Codex evaluator에는 기존 최대 3 turn 제한을 적용한다.

각 판단에는 피험 provider/model/family, evaluator kind/provider/model/family, `same_family`, 블라인드 라벨, 제시 순서, rubric·prompt 버전을 provenance로 남긴다. 기본 비교 UI에는 동일 계열 evaluator 경고를 표시하고, 충분한 교차 평가가 있으면 `동일 계열 점수 - 타 계열 점수`를 self-bias 관찰값으로 보여준다. 이 값은 교정 세트와 표본 수 없이 평가자의 보편적 편향으로 단정하지 않는다.

평가 비용은 다음처럼 분리한다.

```text
총비용 = 작업 실행 비용 + 자동 검증 비용 + 심사 에이전트 비용
```

심사 실패는 작업 결과를 실패로 바꾸지 않는다. 평가 상태를 별도로 `partial`로 표시하고 재평가할 수 있게 한다.

현재 rubric 구현은 완료 run의 마지막 assistant 답변과 tracked Git diff만 새 `SubjectPacket`으로 allowlist 투영한다. 공급자·모델·세션 지문은 마스킹하고 절단·치환 건수를 provenance에 남기며, 도구 로그·원본 완료 이벤트·계정·Variant 객체는 심사 입력에서 제외한다. evaluator는 피험 worktree가 아닌 별도 빈 Git cwd에서 `read-only`, skills none으로 순차 실행된다. 피험 산출물은 신뢰할 수 없는 데이터 구간으로 감싸 내부 지시를 따르지 않도록 명시한다.

평가 라운드와 evaluator 호출은 작업 run 상태와 분리된다. 한 evaluator만 실패하면 성공 judgment와 호출 usage를 보존한 채 `partial`로 끝나고, 재부팅 때 남은 queued/running 평가·호출은 명시적 실패로 종결한다. `experiment_evaluation_call`이 비용의 정본이며 rubric judgment의 usage 복사본은 현재 상세 UI 호환용이다. pairwise에서는 한 호출에 복수 judgment가 연결되므로 호출 usage만 합산해야 한다.

## 12. 비교 지표

| 구분 | 지표 |
| --- | --- |
| 품질 | 결정적 검사 통과율, 루브릭 총점·항목별 점수, 쌍대 승률 |
| 비용 | 입력·캐시·출력·추론 토큰, 총 토큰, 비용 추정치 |
| 속도 | 준비 시간, 실행 시간, 평가 시간, 총 경과 시간 |
| 안정성 | 실패율, 재시도 수, 예산 초과, 체크포인트 재개 성공 여부 |
| 복잡도 | 에이전트 호출 수, 루프 수, 도구 호출 수, 산출물 수 |
| 판단 | 심사자별 순위, 합의율, 분산, 사용자 최종 선택 |

토큰을 보고하지 않는 공급자 이벤트는 `unknown`으로 남기며 0으로 계산하지 않는다. 비용은 실행 당시 가격표 버전을 함께 저장할 수 있을 때만 추정하고, 토큰과 비용을 같은 의미로 표시하지 않는다.

## 13. API와 UI 개요

### API

- `GET/POST /api/projects/:id/experiments`
- `GET /api/projects/:id/experiment-skills`
- `POST /api/experiments/:id/variants`
- `POST /api/experiment-variants/:id/runs`
- `GET /api/experiment-runs/:id`
- `POST /api/experiment-runs/:id/cancel`
- `POST /api/experiment-runs/:id/evaluations`
- `GET /api/experiment-evaluations/:id`
- `POST /api/experiment-evaluations/:id/cancel`
- `GET /api/projects/:id/agent-presets`
- `POST /api/experiment-runs/:id/promote`

현재 구현된 생성·실행·중단·복수 rubric 평가는 관리자 전용이며 감사 로그에 남긴다. run 상세는 node·최대 1,000개 이벤트·체크포인트·평가 호출·judgment provenance를 함께 반환하고, 진행 중 blind map은 숨긴다. 재개, 별도 이벤트 커서, pairwise·사람 판정 API와 이후 SSE 실시간 갱신은 후속 단계다.

### UI

- **실험 목록:** 상태, 변형 수, 최근 실행, 우승 후보, 총 토큰·시간
- **실험 편집기:** 공통 명령과 변형별 차이만 보이는 조건 매트릭스
- **실행 상세:** 그래프/루프 타임라인, 이벤트, 도구, 체크포인트, 산출물
- **비교 화면:** 품질·토큰·시간 표, 심사자별 판단, 합의·불일치, 사용자 판정
- **안전 제어:** 실행 전 예상 호출 수와 예산, 실행 중 중단, 재개 가능 지점
- **승격 제어:** 사용자 판정이 끝난 Variant의 `프로덕션 프리셋으로 승격`, 출처·비용 증가 확인, 버전 전환·롤백

## 14. Winner promotion

실험에서 찾은 조합을 실제 WAM 작업으로 연결해 다음 순환을 완성한다.

```text
실험 → 측정 → 선택 → Agent preset 승격 → 실제 사용 → 새 실험 기준선
```

승격은 Variant의 현재 편집값을 복사하지 않고, 사용자가 선택한 완료 run의 `config_snapshot_json`을 불변 preset 버전으로 복사한다. 함께 저장할 출처는 실험·Variant·대표 run, 사용자 판정, 표본 수, 성공률·품질 점수, 토큰·시간 중앙값과 기준선 대비 증감이다.

예시는 다음과 같다.

```text
Codex High
  성공률 87%

Codex High → Claude Review
  성공률 98%
  비용 +31%
  시간 +22%

[프로덕션 프리셋으로 승격]
```

승격 안전 규칙은 다음과 같다.

- 관리자와 명시적 확인이 필요하며 감사 로그를 남긴다.
- 완료 run과 사용자 `accepted` 판정이 있어야 기본 승격 버튼을 활성화한다.
- 단일 실행, 부분 평가, 서로 다른 도구·권한 프로필에는 경고를 표시하되 관리자가 근거를 남겨 진행할 수 있다.
- 승격 직전 현재 CLI·모델·스킬·훅 호환성을 다시 검사하고, 누락 항목이 있으면 활성화하지 않는다.
- 같은 preset 재승격은 기존 버전을 덮어쓰지 않고 새 버전을 만든다.
- 활성 버전 전환과 직전 버전 롤백은 원자적으로 처리한다.
- 실제 채팅은 시작할 때 선택한 preset 버전을 스냅샷으로 붙잡아, 나중의 preset 변경이 실행 중 작업을 바꾸지 않게 한다.
- preset으로 수행한 실제 작업의 성공·비용 지표를 이후 실험의 운영 기준선으로 가져올 수 있게 한다.

현재 구현은 완료 run 상세의 `프리셋 승격`에서 이름·선택 근거를 확인한 뒤 accepted human verdict와 새 preset version을 한 transaction으로 만든다. 지표는 같은 Variant의 terminal 표본에서 성공률, 완료 표본 중앙 토큰/비용, 평균 judgment 점수를 서버가 계산한다. 표본 부족, 점수 있는 evaluator 없음, partial 평가, 비용 미보고는 compatibility warning으로 저장하되 관리자의 명시적 승격을 막지는 않는다. 같은 이름을 다시 승격하면 v2·v3로 누적하고 활성 버전만 원자적으로 바꾼다.

## 15. 구현 단계와 예정 파일

### 1단계 — 기반 데이터와 실행 원장 (`#27`)

- `src/shared/experiments.ts`: 설정·상태·이벤트 공통 타입과 검증 스키마
- `src/server/services/experiment-repository.ts`: 실험·실행·이벤트·체크포인트 저장
- `src/server/database.ts`: 실험 테이블과 인덱스 마이그레이션
- `tests/experiment-repository.test.ts`: 멱등 이벤트·상태 전이·재개 검증

### 2단계 — 런타임과 하네스 (`#28`, `#31`)

- `src/server/experiments/agent-runtime.ts`
- `src/server/experiments/codex-exec-runtime.ts`
- `src/server/experiments/claude-print-runtime.ts`
- `src/server/experiments/harness-engine.ts`
- `src/server/experiments/hook-bus.ts`
- 자식 프로세스 취소, 예산, 반복, 체크포인트 테스트

### 3단계 — 평가 (`#29`)

- `src/server/experiments/evaluation-service.ts`
- 결정적 검사, 블라인드 매핑, 복수 심사, 쌍대 순서 교차, 합의 계산
- 평가 usage와 작업 usage 분리 검증

### 4단계 — API와 UI (`#30`)

- `src/server/routes/experiment-routes.ts`
- `src/client/features/experiments/*`
- 관리자 권한·CSRF·감사 로그 테스트
- Playwright로 생성→실행→비교→사용자 판정 흐름 검증 및 스크린샷

현재는 실험/Variant 생성, 세 하네스 run 시작/취소/상세, 두 내장 hook, 복수 블라인드 rubric 평가와 Winner promotion의 버전/활성 전환까지 구현했다. 자동 반복, pairwise A/B·B/A, 합의 통계와 일반 채팅의 preset 버전 선택·실행 스냅샷 고정은 이어서 구현한다.

### 5단계 — 공급자 네이티브 프로필과 고급 분석

- Codex custom agents, Claude subagents/Agent Teams opt-in
- 반복 실행 통계와 신뢰구간
- 실험 템플릿 내보내기/가져오기
- 통합 토큰 대시보드 연결

### 6단계 — Winner promotion (`#37`)

- `agent_presets`, `agent_preset_versions`와 출처·승격 지표 원장
- 평가 결과에서 preset 새 버전 생성·활성화·롤백 API
- 일반 채팅/작업 생성 시 preset 버전 선택과 실행 스냅샷 고정
- 승격 전 호환성 검사, 관리자 확인, 감사 로그, 실제 사용 지표 환류

### 7단계 — 실험 설계와 측정 정확도 보강

채팅 `#219`의 Ponytail 비교(단건 1회, 목표 기반 3턴 1쌍)를 사후 검토해 확인한 측정 한계를 반영한다. 사용자 결정으로 구현은 뒤로 미루고 범위만 계획에 고정한다.

- **과제 유형을 실험 변수로 명시:** 완료 기준이 전부 명시된 과제는 "만들지 않는다"는 판단을 요구하는 스킬의 작용점을 지워 스킬 가설 자체를 검정할 수 없게 만든다. 실험 정의에 해법 자유도(명세형·개방형)를 넣고 비교 UI와 결론 문구에 함께 표시한다.
- **평가 packet과 rubric 확장:** 17장의 tracked 전용 한계를 해소해 untracked 산출물을 심사 입력에 포함하고, rubric에 `새 의존성 도입 여부`와 `산출물이 fixture 환경에서 실제로 실행되는가`를 항목으로 추가한다. 단건 비교에서 control이 fixture에 없는 `pytest`를 새로 도입해 실행에 실패했는데도 두 심사자가 그 사실을 볼 수 없었다.
- **표본 수와 순서 통제:** arm당 최소 3회 반복과 순서 교차를 실행 계획 단계에서 강제하고, 8장 공정성 규칙의 "무작위화하거나 교차한다"를 교차 필수로 좁힌다. 단건과 멀티턴 두 실험 모두 무작위 결과가 Ponytail 선행으로 같아 순서 효과를 분리할 수 없었다.
- **출력측 지표 표면화:** 12장 지표의 출력·추론 토큰을 비교 UI 기본 열로 올리고 최종 답변 길이를 함께 기록한다. Ponytail arm은 누적 토큰 2.63배만이 아니라 출력 토큰 1.80배, 추론 토큰 2.01배, 최종 답변 길이 4.40배를 썼고 턴이 진행될수록 답변이 길어졌다. 출력을 줄이라고 지시하는 스킬이 출력을 늘리는 역효과는 입력측 누적 토큰만 보면 드러나지 않는다.
- **스킬 강도를 arm 변수로 지원:** `argument-hint`로 강도를 받는 스킬(`lite|full|ultra` 등)을 강도별 arm으로 비교할 수 있게 additions 설정에 인자를 포함한다. 현재는 기본값 고정이라 강도가 토큰 증가의 원인인지 분리할 수 없다.
- **스킬 규칙 준수율을 독립 지표로 측정:** 스킬을 켠 것과 스킬 지시가 지켜진 것은 다르다. `#219` 산출물 검토에서 Ponytail arm은 스킬이 요구한 `ponytail:` 한계 주석을 하나도 남기지 않았고, 파일 수 최소 규칙을 어겨 `verify.py`를 중복 추가했으며, 요청에 없던 예외 캐싱을 도입해 그 검증 테스트가 스위트를 실패시켰다. 반대로 스킬이 "단순화하지 말라"고 예외 처리한 입력 검증 경계에서는 대조군보다 정확했다. 스킬 본문에서 기계적으로 채점 가능한 조항(필수 주석 마커, 파일 수 증가, 새 의존성, 요청 범위 밖 기능 추가)을 rubric 항목으로 만들어 준수율을 품질과 분리해 기록한다. 이 지표가 없으면 "스킬이 나쁜가"와 "모델이 규범을 유지하지 못하는가"를 구분할 수 없고, 다른 스킬을 평가할 때도 같은 혼동이 반복된다.

### 8단계 — 에이전트 셀프서비스와 기존 프로젝트 대상 실험

- **스킬과 MCP로 실험실 노출:** 실험·Variant 생성, 실행, 진행 조회, 비교 결과 회수를 WAM 자체 MCP 도구와 스킬로 제공해 사람이 웹 UI를 직접 조작하지 않아도 에이전트가 실험을 관리·실행하게 한다. 기존 `web_agent_manager_*` 도구와 위임 스킬의 명명·인자 관례를 따르고 관리자 권한·CSRF·감사 로그 경계는 그대로 유지한다.
- **기존 프로젝트를 실험 대상으로 지정:** 지금은 실험 전용 fixture 저장소를 새로 만들어야 비교할 수 있다. 등록된 기존 프로젝트를 대상으로 직접 지정하고 기준 HEAD, 미커밋·untracked 변경 처리 정책, worktree 격리 범위, 정리 주기를 실험 정의에서 고르게 한다. 17장의 detached worktree 한계를 이 경로에서 어떻게 다루는지 명시하고, 원본 작업 트리를 실험이 변경하지 않는다는 보장을 provenance로 남긴다.

### 9단계 — 다중 저장소·과제 유형 비교 스위트

이 단계의 목적은 실행 표를 만드는 것이 아니라 **조건부 권고를 만드는 것**이다. 최종 산출물은 "어떤 상황에서는 어떤 구성이 낫고, 상황 전반에서 일반적으로 권할 만한 기본 스킬셋은 무엇인가"를 근거와 함께 적은 플레이북이며, 표와 점수는 그 결론의 재료일 뿐이다. 그래서 설계는 **상황을 제한적으로 재현하는 축**과 **그 위에서 겨루는 여러 구성 프로필**을 분리해서 세운다.

사용자 요구를 그대로 옮기면 "공개 GitHub 저장소를 대형·중형·소형으로 받아 **에러 유지보수 / 새로 만들기 / 신규 기능 추가 / 보안 취약점** 네 관점에서 여러 비교군을 한 번에 돌리고 완성도·소모 토큰·소요 시간을 비교한다"이다. 현재 실험실은 `프로젝트 1개 · 명령 1개 · Variant N개 · 사람이 1회씩 수동 실행`이므로 아래 여섯 갭을 메워야 이 요구가 성립한다.

| # | 현재 구현 | 요구와의 갭 | 필요한 것 |
| --- | --- | --- | --- |
| G1 | `experiments.project_id`가 필수이고 `ExperimentWorkspaceService.create()`가 등록 프로젝트의 현재 Git HEAD에서 worktree를 만든다 | 외부 공개 저장소를 받아 특정 commit에 고정하는 경로가 없다. HEAD는 시간이 지나면 움직인다 | 저장소 fixture 개체(9-1) |
| G2 | 과제는 `experiments.command` 자유 텍스트 하나뿐이다 | 네 관점은 시작 상태·정답 기준·위험이 각각 다른데 이를 구분할 자리가 없다 | 과제 유형(9-2) |
| G3 | 실행은 `POST /api/experiment-variants/:id/runs`를 Variant마다 사람이 호출한다. `design.repetitions`는 저장만 되고 소비되지 않으며 전역 동시 실행은 1개로 고정이다 | "여러 비교군을 넣어서 결과를 받는다"의 핵심인 배치 실행이 없다 | 실행 계획 큐(9-5) |
| G4 | 완성도는 블라인드 rubric(LLM 심사)만으로 매긴다. 내장 훅은 `diff_stats`·`git_diff_check` 둘뿐이다 | 유지보수·기능 추가·보안은 "테스트가 통과하는가"가 1차 지표인데 결정적 검사가 실행되지 않는다 | 검증 명령 훅(9-7) |
| G5 | 비교 화면은 실험 하나 안의 Variant만 나열한다 | 저장소 규모 × 과제 유형 × 비교군 매트릭스를 한 화면에서 볼 수 없다 | 스위트 집계 뷰(9-8) |
| G6 | 결과는 run별 점수·토큰·시간까지만 남는다 | "어디엔 뭐가 좋더라"라는 **조건부 권고**로 바꾸는 규칙이 없어 표를 사람이 매번 눈으로 해석해야 한다 | 권고 산출 규칙(9-8) |

비교군이 스킬 on/off 두 개뿐이면 나오는 결론도 "그 스킬이 이 과제에서 이겼다" 하나뿐이다. 권고를 만들려면 겨루는 구성이 여러 개여야 하고(9-4), 그 구성들이 여러 상황에 걸쳐 반복돼야 한다(9-3).

11장의 평가 패킷은 이미 tracked·untracked 산출물을 함께 투영하도록 보강 중이므로, 산출물이 전부 새 파일인 "새로 만들기" 관점의 선행 조건은 이 단계에서 다시 만들지 않는다.

#### 9-1. 저장소 fixture

`experiment_repo_fixture`를 새 개체로 둔다. 필드는 `url`, `pinnedCommit`, `sizeClass(small|medium|large)`, `언어·빌드 도구`, `setupCommand`, `testCommand`, `license`, `획득 시각`이다. 서버는 fixture별 bare mirror를 `dataDir`에 한 번만 clone해 캐시하고, run마다 그 mirror에서 `pinnedCommit`의 detached worktree를 만든다. 기존 `ExperimentWorkspaceService`는 "등록 프로젝트 경로"만 원본으로 받으므로 원본 종류를 `project | fixture`로 넓히고, 정리·경로 탈출 검사·24시간 보존 규칙은 그대로 재사용한다.

- `pinnedCommit` 고정은 필수다. 지금도 같은 실험 안에서 기준 commit이 달라지면 실행을 거부하므로, fixture가 이 검사의 정본이 된다.
- 규모 기준은 저장소 용량이 아니라 **에이전트가 실제로 탐색해야 하는 양**으로 정의한다. 소형 1만 LOC 미만, 중형 1만~20만, 대형 20만 이상을 기본값으로 두고 fixture에 실측값을 함께 저장한다.
- 공개 저장소만 허용하고 라이선스를 fixture에 기록한다. 산출물은 실험 worktree 밖으로 나가지 않으며 원본 저장소에 push하지 않는다.
- clone과 `setupCommand` 이후에는 네트워크를 끊는 것을 기본으로 한다. 대형 저장소의 의존성 설치 성공 여부 자체가 비교를 오염시키므로 fixture 준비 단계에서 한 번만 수행하고 그 상태를 mirror와 함께 캐시한다.

**적격성 게이트.** 규모가 크다고 실험 대상이 되지는 않는다. 아래를 모두 통과한 저장소만 fixture로 등록하고, 실패한 후보는 사유와 함께 기록해 다시 시도하지 않는다.

| 게이트 | 기준 | 떨어뜨리는 이유 |
| --- | --- | --- |
| 오프라인 재현 | `setupCommand`가 네트워크 없이 캐시 상태에서 재현된다 | 매 run마다 설치가 달라지면 시간·토큰 측정이 의존성 다운로드 속도를 재게 된다 |
| 기준선 녹색 | `pinnedCommit`에서 `testCommand`가 통과한다 | 원래 깨진 스위트에서는 "에이전트가 깼는가"를 판별할 수 없다 |
| 검사 시간 | `testCommand`가 10분 이내에 끝난다 | 검사 시간이 실행 시간을 넘으면 예산이 과제가 아니라 CI에 쓰인다 |
| 도구 무관성 | 특수 하드웨어·유료 서비스·독점 SDK가 필요 없다 | 실패가 구성 차이가 아니라 환경 부재로 발생한다 |
| 라이선스 | 공개 라이선스가 명확하다 | 산출물 취급 근거가 없다 |
| 과제 성립 | 유형별 추가 조건(9-2)을 만족한다 | 정답 기준이 없으면 완성도를 못 잰다 |

대형 저장소는 마지막 두 게이트보다 앞의 세 게이트에서 주로 탈락한다. 그래서 대형 칸은 "가장 유명한 저장소"가 아니라 **게이트를 통과하는 저장소 중 가장 큰 것**으로 채운다. 이 순서를 뒤집으면 준비에만 며칠이 들고 실험은 시작하지 못한다.

#### 9-2. 과제 유형

`experiment.taskKind`를 추가하고 유형마다 시작 상태·정답 기준·금지 사항을 다르게 둔다.

| 유형 | 시작 상태 | 완성도 1차 지표 | 주의 |
| --- | --- | --- | --- |
| `maintenance` | 버그가 있는 commit + 재현되는 실패 테스트 | 그 테스트가 통과하고 기존 스위트가 깨지지 않는가 | upstream 수정 commit을 oracle로 쓰되 에이전트에게 노출하지 않는다 |
| `greenfield` | 빈 worktree + 명세 | 명세 수용 테스트 통과, 새 의존성 도입 여부 | 저장소 규모 축이 성립하지 않으므로 **명세 규모**(소·중)로 대체한다 |
| `feature` | 안정 commit + 기능 명세 | 숨김 수용 테스트 통과, 기존 스위트 유지 | 명세를 테스트에서 역추론할 수 없게 테스트는 실행만 하고 내용을 숨긴다 |
| `security` | 알려진 취약점이 있는 commit | 취약점 식별 정확도와 수정 후 재현 실패 여부 | **정적 분석과 수정까지만 한다.** 익스플로잇 실행·외부 대상 시도는 금지하고 네트워크를 끊은 채 실행한다 |

`greenfield`의 시작 상태는 fixture worktree가 아니라 빈 Git 디렉터리이므로, 9-1의 원본 종류에 `empty`를 하나 더 둔다.

#### 9-3. 상황 축과 부분요인 설계

"다양한 상황"을 네 축으로 제한 재현한다. 축은 늘리기 쉽고 줄이기 어려우므로 여기서 고정한다.

| 축 | 수준 | 왜 이 축인가 |
| --- | --- | --- |
| S1 과제 유형 | `maintenance` / `greenfield` / `feature` / `security` | 사용자가 지정한 네 관점이며 요구 능력이 서로 다르다 |
| S2 코드베이스 규모 | 소 / 중 / 대 | 탐색 비용이 구성의 이득을 덮는 지점을 찾는 축 |
| S3 명세 명확도 | 명세형 / 개방형 | 7단계 결론. 완료 조건이 전부 적힌 과제는 "만들지 않는 판단"을 요구하는 스킬의 작용점을 지운다 |
| S4 생태계 | 정적 타입·컴파일 / 동적 | 타입 검사기가 피드백을 주는 환경과 아닌 환경에서 자가 검토의 값이 다르다 |

완전요인은 `4 × 3 × 2 × 2 = 48`셀이고 구성 5개 × 3회면 720 run이라 성립하지 않는다. 관심 대상은 축끼리의 고차 상호작용이 아니라 **구성 × 상황 상호작용**뿐이므로 부분요인으로 줄인다.

- S1 × S2를 기본 격자(12셀)로 두고 `greenfield`의 S2는 명세 규모로 대체한다.
- S3와 S4는 그 12셀에 **균형 배치**한다. 각 과제 유형 안에서 명세형·개방형이 한 번씩, 정적·동적 생태계가 한 번씩 나타나게 fixture를 고른다. 이러면 S3·S4의 주효과는 관찰할 수 있고 셀 수는 늘지 않는다.
- 균형 배치는 fixture 선정 제약이 되므로 9-1 적격성 게이트와 함께 확인한다. 배치가 깨진 축은 "이 스위트로는 분리할 수 없음"으로 명시하고 결론에서 그 축을 주장하지 않는다.

#### 9-4. 구성 프로필 카탈로그

비교군을 스킬 on/off 두 개로 두면 나올 수 있는 결론도 하나뿐이다. 기본 카탈로그를 여섯 개로 두고 스위트마다 필요한 것만 고른다.

| 프로필 | 구성 | 검정하려는 가설 |
| --- | --- | --- |
| `P0 clean` | 스킬 `clean`, single, 기본 추론 | 하한선. 나머지는 이걸 이겨야 의미가 있다 |
| `P1 installed` | 현재 설치 스킬 그대로, single | 실무의 실제 상태. 운영 기준선 |
| `P2 task-kit` | `clean` + 과제 유형 특화 스킬만 | 다 켜는 것보다 필요한 것만 얹는 게 나은가 |
| `P3 self-review` | `clean` + `evaluator_optimizer` | 스킬 대신 자가 검토 루프가 대체재인가 |
| `P4 decompose` | `clean` + `orchestrator_worker` | 대형·개방형에서 분해가 실제로 이득인가 |
| `P5 more-thinking` | `clean` + 추론 강도 상향, single | **비용 대조군.** 같은 추가 토큰을 그냥 추론에 쓰면? |

**모델 등급은 통제 변수로 고정한다.** 여섯 프로필은 모두 같은 모델을 쓰고, `P5`만 그 모델의 추론 강도를 올린다. 기본 등급은 **가성비 등급**으로 둔다 — Claude는 `claude-sonnet-5`, Codex는 frontier 기본값(`gpt-5.5`) 아래의 중간 등급을 `/model` 메뉴 실측으로 확정한다. 최상위 등급(`claude-opus-5`)은 품질 상한을 확인할 때만 별도 축으로 쓰고 기본값으로 삼지 않는다.

| 모델 | 입력 $/1M | 출력 $/1M | 컨텍스트 |
| --- | --- | --- | --- |
| `claude-opus-5` | $5.00 | $25.00 | 1M |
| `claude-sonnet-5` | $3.00 (2026-08-31까지 인트로 $2.00) | $15.00 (인트로 $10.00) | 1M |
| `claude-haiku-4-5` | $1.00 | $5.00 | **200K** |

**Haiku 4.5는 이 스위트의 피험 모델에서 제외한다.** 싸다는 이유로 고르기 쉽지만 두 축을 동시에 망가뜨린다.

- **컨텍스트 200K.** Sonnet 5·Opus 5의 1M 대비 5분의 1이다. 중형·대형 저장소(9-3의 S2)에서는 탐색 도중 컨텍스트 상한에 먼저 걸려, 측정되는 것이 "구성의 차이"가 아니라 "모델의 상한"이 된다. 규모 축을 세워 놓고 규모를 못 재게 되는 셈이다.
- **`effort` 미지원.** Haiku 4.5는 effort 파라미터를 받지 않으므로 `P5 more-thinking` 대조군 자체가 성립하지 않는다. 게다가 `isolated_overlay` 비교는 모델과 추론 강도를 **둘 다 명시**하도록 강제하는데(`parseExperimentVariantConfig()`), Haiku에는 넣을 값이 없다. 실험실은 `reasoningEffort`가 있으면 Claude에 `--effort`, Codex에 `model_reasoning_effort`를 그대로 넘긴다.

가격 차이도 생각만큼 크지 않다. 인트로 가격이 적용되는 동안 Sonnet 5는 Haiku 대비 입력·출력 모두 2배인데 컨텍스트는 5배다. 대형 저장소를 다루는 스위트에서 이 교환은 Sonnet 쪽이 유리하다.

심사 evaluator 모델도 같은 이유로 명시해 고정한다. 지금 평가 UI는 모델 칸이 비면 CLI 기본값을 그대로 상속하므로, 공급자가 기본 모델을 바꾸면 같은 rubric의 점수가 조용히 달라진다. 스위트 안에서는 evaluator 모델을 고정하고 그 값을 judgment provenance에 남긴다.

`P5`가 카탈로그의 중심이다. 스킬이나 루프를 얹은 구성은 거의 항상 토큰을 더 쓰므로, 대조군 없이 이기면 "그 구성이 좋다"가 아니라 "토큰을 더 썼다"를 측정한 것이 된다. 7단계에 기록된 `#219` 사례에서 처리군은 2.63배 토큰을 쓰고도 졌다. `P5`는 추가 토큰의 기회비용을 고정한다.

**현재 구현이 강제하는 제약이 있다.** `parseExperimentVariantConfig()`는 `isolated_overlay` 스킬 비교를 single 하네스로만 허용하고, 같은 `comparisonId` 안에서는 스킬 외 조건이 모두 같아야 한다. 따라서 프로필을 한 비교 그룹에 다 넣을 수 없고 두 그룹으로 나눈다.

```text
그룹 A(스킬 축)  : P0 · P1 · P2   → isolated_overlay, 같은 comparisonId, single 고정
그룹 B(하네스 축): P0 · P3 · P4   → 스킬은 native로 고정하고 하네스만 변경
공통 대조군      : P5            → 두 그룹의 토큰 증가분을 같은 자로 재기 위해 양쪽에 넣는다
```

`P0`가 두 그룹에 모두 들어가므로 그룹 간 결과를 `P0` 기준 상대값으로 이어 붙일 수 있다. 이 연결은 근사이므로 그룹을 가로지르는 직접 순위(예: `P2` 대 `P4`)는 확증 등급으로 올리지 않는다.

#### 9-5. 실행 계획 큐

`experiment_run_plan`을 두고 `Variant × repetitions`를 미리 펼쳐 큐로 만든다.

- 순서는 8장 공정성 규칙과 7단계 결론에 따라 무작위가 아니라 **arm 교차**를 기본으로 한다(`A B C / B C A / C A B`). 지금 무작위화가 적용되는 곳은 evaluator 순서뿐이다.
- 전역 동시 실행 1개는 유지한다. CPU 경합이 곧 시간 지표 오염이므로 처리량이 아니라 측정 정확도를 택한다. 대신 큐가 순차 소비하고 진행률·남은 예상 시간을 표시한다.
- 중간 실패는 큐를 멈추지 않고 그 항목만 기록한 뒤 다음으로 넘어간다. 사용자는 큐 단위로 중단·재개할 수 있어야 한다.
- 평가도 같은 CLI 슬롯을 쓰므로 큐에 함께 넣어 계산한다.
- 큐는 `스크리닝 → 격자 → 확증`(9-9) 중 어느 단계인지를 함께 들고 있어야 한다. 단계에 따라 반복 횟수와 권고 등급 상한이 달라지기 때문이다.

#### 9-6. 공급자 한도 대기와 재개

공급자 사용량 한도는 실패가 아니라 **대기**로 처리한다. WAM에 이미 있는 한도 대기·재개 장치를 그대로 쓰고, 실험용으로 새로 만들지 않는다.

**재사용하는 것.**

| 자산 | 위치 | 실험실에서의 역할 |
| --- | --- | --- |
| `usage_status` 테이블 | `usage-monitor.ts`가 계정별로 60초마다 갱신 | 한도 상태(`reset_at`, `remaining_percent`)의 정본 |
| `parseResetTime()` | `rate-limit-resume.ts` | CLI가 찍은 리셋 문구를 실제 시각으로 해석 |
| `isRateLimitRecovered()` | `rate-limit-resume.ts` | 예정 시각 경과 **또는** 잔여 10% 이상이면 회복으로 판정 |

**바꿔 끼우는 것 하나.** `RateLimitResumeService.resumeChat()`은 tmux 채팅에 `"계속"`을 보내 이어가는데, 실험 run은 비대화형 자식 프로세스라 그 경로가 없다. 대신 이미 구현된 `AgentRuntime.resume()`과 원장에 기록된 provider session ID로 이어간다. 별도 예약 타이머를 두지 않고 폴링으로 판단하는 원래 방식은 그대로 따른다 — 서버가 재시작돼도 다음 폴링에서 이어서 판단된다.

**흐름.** 새 run 상태는 만들지 않고 6장의 `running → paused → running` 전이를 그대로 쓴다.

```text
한도 감지 → run.paused, 대기 시작 시각 기록
          → usage_status 폴링(60초)
          → isRateLimitRecovered() 참
          → runtime.resume(providerRunId, checkpoint) → run.running, 대기 종료 시각 기록
```

**전역 슬롯을 잡고 있으면 안 된다.** 9-5의 동시 실행 1개 제한 아래에서 대기 중인 run이 슬롯을 계속 점유하면 큐 전체가 몇 시간 멈춘다. 대기에 들어가면 슬롯을 반납하고 재개할 때 다시 잡는다. worktree와 체크포인트는 그대로 보존한다. 같은 계정을 쓰는 후속 큐 항목은 어차피 같은 한도에 걸리므로 함께 보류하고, 다른 계정·공급자 항목은 그동안 진행시킨다.

**감지 경로를 먼저 만들어야 한다.** 지금은 한도든 컨텍스트 초과든 모두 `runtime_error`로 뭉개져 대기 대상을 골라낼 수 없다(17장). 종료 이유에 `provider_limit`을 추가해 한도만 분리한 뒤에 이 대기 경로를 연결한다.

**재현성 표시.** 대기 후 재개한 run은 중간에 모델 버전이 바뀌었을 수 있고, 프롬프트 캐시가 만료돼 재개 이후 입력 토큰이 부풀 수 있다. 대기 횟수·총 대기 시간·재개 시각을 provenance에 남기고, 비교 UI에서 대기가 있었던 run을 표시한다.

#### 9-7. 완성도의 결정적 검사

10장이 예고한 "허용된 검증 명령 실행"을 이 단계에서 구현한다. Variant가 임의 셸 문자열을 등록하는 것은 계속 금지하고, **fixture에 선언된 `testCommand`만** `after_run` 훅으로 실행해 종료 코드·요약 로그를 산출물로 남긴다. 완성도는 다음 순서로 합성한다.

```text
완성도 = 결정적 검사(통과/실패) 우선 → 동률일 때 블라인드 rubric 점수 → 사람 최종 판정
```

7단계가 요구한 `새 의존성 도입 여부`와 `산출물이 fixture 환경에서 실제로 실행되는가`는 이 검사로 자동 판정할 수 있게 된다.

#### 9-8. 스위트 집계와 권고 산출

`experiment_suite`를 최상위에 둔다. 계층은 `suite → experiment(fixture × taskKind) → variant(구성 프로필) → run(반복)`이다. 실험을 `fixture × taskKind` 단위로 쪼개는 이유는 기준 commit 동일성 검사가 이미 실험 단위이기 때문이며, 이 구조는 기존 스키마를 바꾸지 않고 상위 개체만 더한다.

비교표의 행은 구성 프로필, 열은 `과제 유형 × 규모`, 셀은 다음을 함께 보여준다.

```text
결정적 검사 통과율 · rubric 중앙값 · 총 토큰 중앙값(출력·추론 분리) · 실작업 시간 중앙값 · 표본 수
```

12장 지표 중 출력·추론 토큰을 기본 열로 올리는 7단계 항목을 여기서 함께 반영한다.

**시간 지표는 벽시계가 아니라 실작업 시간이다.**

```text
실작업 시간 = (종료 시각 - 시작 시각) - 누적 한도 대기 시간
```

9-6의 대기는 구성의 성질이 아니라 그날 계정에 남아 있던 사용량의 문제다. 대기를 시간에 포함하면 "밤 늦게 돌린 arm이 느린 arm"이 되어 순위가 뒤집힌다. 대기 시간은 운영 정보로 별도 열에 남기되 **셀 승자 결정(9-8)에는 넣지 않는다.**

같은 정의를 **시간 예산에도 적용해야 한다.** 지금 `RuntimeBudgetPolicy`는 `Date.now() - startedAtMs`를 쓰고 `SingleHarness`는 실행 시작 시점에 `setTimeout(maxSeconds × 1000)`을 건다. 둘 다 대기를 모르므로, 한도 대기를 붙이면 4시간 기다리다 `time_budget`으로 run이 죽는다. 예산 타이머와 `elapsedSeconds` 모두 대기 구간을 제외한 실작업 시간으로 바꾸는 것이 9-6 구현의 전제 조건이다.

**셀 승자 결정.** 지표가 여러 개이므로 순서를 미리 고정해 사후 해석을 막는다.

```text
1. 결정적 검사 통과율    (통과가 실패를 이긴다. 여기서 갈리면 끝)
2. 블라인드 rubric 중앙값 (통과율이 같을 때만)
3. 비용 효율             (품질이 같을 때 토큰이 적은 쪽)
4. 그래도 같으면 "무차별"  (억지로 순위를 매기지 않는다)
```

**권고 등급.** 표본 수와 통계적 분리에 따라 세 등급만 쓴다. 최소 표본이 4회인 것은 임의 선택이 아니다 — 3회는 **3승 0패 대 0승 3패여도** 95% Wilson 구간이 `0.438` 대 `0.562`로 겹쳐 "표본 변동을 넘었다"고 말할 수 없다. 완전 분리가 가능해지는 최소 표본이 4회다.

| 등급 | 조건 | 문장 |
| --- | --- | --- |
| 확증 | 셀당 4회 이상이고 두 arm의 95% Wilson 구간이 겹치지 않음 | "이 상황에서는 X를 쓴다" |
| 잠정 | 표본이 4회 미만이거나, 앞서더라도 95% 구간이 겹침 | "이 상황에서 X가 나아 보인다(관찰값)" |
| 무차별 | 차이가 표본 변동 안 | "차이가 확인되지 않았다. 더 싼 쪽을 쓴다" |

**일반 권고의 조건.** "일반적으로 이 스킬셋을 쓰면 좋다"는 문장은 아래를 모두 만족할 때만 낸다.

- 어떤 과제 유형에서도 확증 열세가 아니다.
- 최소 한 유형에서 확증 우세다.
- 비용 배수가 기준선(`P0`) 대비 합의된 상한 안이다.

**상황에 따라 순위가 뒤집히면 일반 권고를 내지 않는다.** 대신 역전이 일어난 축과 지점을 그대로 적는다. 이 규율이 없으면 평균이 상반된 두 상황을 뭉개서 어디서도 맞지 않는 기본값을 권하게 된다. 비용 배수를 조건에 넣는 이유도 같다 — 이겼지만 3배 비싼 구성은 기본값이 아니라 조건부 선택지다.

**산출물은 플레이북이다.** 스위트가 끝나면 다음 형식으로 저장하고, 이후 실험은 이 문서를 기준선으로 갱신한다.

```text
상황: 대형 · 유지보수 · 명세형
  권장   P2 task-kit   (확증, n=3, 통과 3/3, P0 대비 토큰 1.4배)
  대안   P5            (무차별, 통과 3/3, 토큰 1.9배)
  비권장 P4 decompose  (확증 열세, 통과 1/3 — 같은 파일 충돌)
  반례   소형에서는 P2와 P0가 무차별. 규모가 작으면 얹을 이유가 없다.
```

`agent_preset` 승격(14장)은 이 플레이북의 "권장" 항목을 입력으로 삼는다. 실험이 권고를 만들고 권고가 실제 운영 설정이 되는 것이 이 단계의 종착점이다.

#### 9-9. 조합 폭발 통제와 도입 순서

완전 격자는 `12셀 × 7 arm × 4회 = 336 run`이고 전역 동시 1개이므로 평가를 빼고도 몇 주가 든다. 그래서 처음부터 전부 돌리지 않고 **단계마다 후보를 줄이는** 순서로 진행하며, 각 단계 끝에 계속할지 멈출지 판단한다. arm이 7개인 이유는 9-4의 그룹 분리 때문이다(`P0a·P1·P2` + `P0b·P3·P4` + `P5`).

| 단계 | 범위 | run 수 | 목적과 통과 기준 |
| --- | --- | --- | --- |
| 1 스크리닝 | 중형 고정 · 4 유형 × 7 arm × 1회 | 28 | 과제·검증 명령·예산이 성립하는지 확인하고 명백히 못 쓰는 arm을 떨군다. 예산 초과나 검사 실패가 절반을 넘는 arm은 탈락 |
| 2 격자 | 살아남은 4 arm × 나머지 8셀 × 1회 | 32 | 규모·명세 명확도·생태계 축에서 순위가 뒤집히는 지점을 찾는다. 여기까지는 전부 잠정 등급 |
| 3 확증 | 순위가 갈린 6셀 × 상위 3 arm × 4회 | 72 | 확증 등급을 만들 수 있는 유일한 단계(4회 미만은 구간이 겹쳐 확증 불가). 순서 교차 필수 |

1단계만 보면 중형 run 20분 기준 약 9~10시간이라 하루 안에 끝난다. **대형은 3단계에서만 쓴다.** 1단계에서 대형을 쓰면 실패의 원인이 구성인지 예산인지 과제 설계인지 구분되지 않은 채 시간만 소모된다.

중단 기준도 미리 정한다. 1단계에서 모든 arm이 무차별이면 그 과제 유형은 변별력이 없는 것이므로 과제를 다시 만들고, 2단계에서 역전이 하나도 없으면 3단계를 축소해 상위 2 arm만 확증한다.

예산 기본값은 규모별로 나눈다. 현재 기본 `maxSeconds: 1800`은 대형 저장소에서 대부분 `time_budget`으로 끝나므로, 소형 1,800초 / 중형 3,600초 / 대형 7,200초를 출발점으로 두고 실측으로 조정한다. 1·2단계 결과는 8장 규칙대로 성능 결론이 아니라 관찰값으로 표시한다.

## 16. 현재 브랜치의 구현 결과와 잔여 범위

`v0.4.0` 작업 브랜치에서 다음 순서로 구현했다.

1. 이 문서와 README·코드트리를 기준 명세로 정리
2. 실험 공통 타입, DB 스키마, 저장소, 상태 전이와 체크포인트 구현
3. 단일 실행 런타임과 `SingleHarness` 구현
4. HookBus, orchestrator-worker, evaluator-optimizer 구현
5. 독립 복수 rubric 심사와 호출별 provenance 구현
6. API와 비교 UI 구현 후 Playwright 검증
7. 우승 run의 preset 승격·활성 버전 전환 구현
8. single run의 installed/clean + 선택 additions native overlay, 전체 디렉터리 provenance와 비교 조건 고정 구현

이어서 9단계의 다음 항목을 구현했다.

9. 평가 패킷·diff 훅의 untracked 산출물 포함(7단계 첫 항목)
10. 한도 대기를 뺀 실작업 시간 예산(`ActiveClock`)과 `provider_limit` 종료 이유 분리
11. 공급자 한도를 실패 대신 대기·재개로 처리하고 대기 시간·횟수를 원장에 기록
12. 저장소 fixture(bare mirror·고정 commit·적격성 게이트)와 과제 유형, greenfield용 빈 작업공간
13. fixture 검증 명령으로 완성도 1차 지표 측정
14. arm 회전 교차 실행 계획 큐와 스위트 집계·조건부 권고 산출

15. graph 하네스의 한도 대기·재개, `context_exceeded` 분리, 쌍대 비교와 위치 편향 집계, Wilson 신뢰구간 기반 확증 등급
16. 실험실을 MCP 도구와 `web-agent-manager-experiment` 스킬로 노출해 에이전트가 직접 비교 실행·권고 회수(8단계 첫 항목)

17. graph 공급자별 skill overlay 분리, 일반 채팅의 preset 버전 고정, CLI 번들 실측 기반 종료 이유 매핑

남은 범위는 승격 preset의 실제 사용 지표 환류다. `context_exceeded` 표식은 설치된 CLI 번들에서 실측했지만 실제 초과 상황의 라이브 출력까지 확인한 것은 아니다.

각 단계는 별도 논리 커밋으로 나누고 `history.md`에 착수·의사결정·완료 결과를 기록한다. 공개 릴리즈·태그·PR은 이 중간 단계에서 만들지 않는다.

## 17. 한계와 위험

- LLM 출력은 비결정적이므로 같은 조건 1회 비교만으로 일반적인 우열을 결론 낼 수 없다.
- 공급자마다 usage 이벤트와 캐시·추론 토큰 의미가 달라 완전히 동일한 비용 비교는 어렵다.
- Claude는 총 토큰을 직접 보고하지 않아 cache creation/read를 포함해 파생하고, Codex는 보고값이 없을 때 input+output으로 파생하므로 `totalTokensSource`와 원본 usage를 함께 해석해야 한다.
- CLI JSON 이벤트 형식은 버전에 따라 바뀔 수 있어 원본 이벤트 보존과 계약 테스트가 필요하다.
- 긴 루프의 큰 이벤트 payload는 행 수와 DB 크기를 급격히 늘리므로 본문은 크기 제한 뒤 blob 파일로 분리하고 원장에는 해시·포인터를 저장해야 한다.
- 스킬을 끄더라도 기본 시스템 지침·프로젝트 지침·모델 학습 지식까지 제거되는 것은 아니다.
- strict `clean`은 모델 학습 지식이나 공급자 built-in 기능을 없애는 조건이 아니라 WAM이 발견한 project/user/system custom skill을 제외한 조건이다. Claude installed skills는 원래 setting source가 아니라 native plugin으로 재구성되므로 slash namespace 같은 세부 discovery 의미가 원래 설치와 완전히 같다고 보장하지 않는다.
- Codex는 준비 단계 manifest에 포함한 custom skill만 확실히 on/off하며 bundled/plugin discovery 전체를 열거하지 못할 수 있다. Claude plugin marketplace의 활성 상태도 현재 manifest 범위 밖일 수 있어 실제 init skill 목록을 행동 probe로 대조하는 기능은 후속 과제다.
- graph에서는 primary·secondary가 각자 공급자의 catalog로 만든 bundle을 받는다. 두 공급자의 installed 집합이 원래 다르므로, 같은 additions를 넣어도 baseline이 동일하다고 볼 수 없다.
- 멀티 에이전트는 토큰 소비와 파일 충돌을 크게 늘리며, 병렬성이 항상 더 빠르거나 더 좋지 않다.
- 현재 orchestrator worker는 역할별 독립 Runtime session이지만 같은 worktree를 순차 공유한다. 병렬 속도 비교와 worker별 filesystem 격리·patch 충돌 해결은 아직 평가할 수 없다.
- 심사 에이전트도 편향·환각이 있으므로 결정적 검사와 사람 판정을 대체하지 않는다.
- 외부 도구·네트워크·시간 의존 작업은 동일 기준 커밋만으로 재현되지 않을 수 있다.
- 체크포인트는 외부 시스템에 이미 발생한 부수효과를 되돌리지 못하므로 쓰기 도구는 멱등 계약이 필요하다.
- 현재 격리는 Git HEAD의 detached worktree라 미커밋·untracked 파일을 포함하지 않고 Git object/ref 저장소는 원본과 공유한다. `danger-full-access`는 저장소 밖 접근을 차단하지 못해 실행 API가 거부하며, 결과 평가를 위해 terminal run의 worktree는 24시간 보존한 뒤 앱 관리 경로와 원본 저장소를 재검증해 정리한다.
- Claude `workspace-write`는 native `acceptEdits` 승인 모드이고 Codex `workspace-write` OS sandbox와 같은 보안 경계가 아니다. 더구나 `-p` 비대화형에는 승인할 사람이 없어 **Bash 호출이 전부 `This command requires approval`로 거부된다**(실측). 그 상태에서는 에이전트가 테스트를 스스로 돌릴 수 없어 "고쳐가며 맞추는 능력"이 아니라 "첫 시도 정확도"만 측정되고, 같은 명령을 반복 시도하느라 토큰이 늘어 비교까지 오염된다. 그래서 fixture가 선언한 검증 명령만 `--allowedTools`로 정확히 열어 준다. 이 차이는 `permissionSemantics` provenance와 UI 경고로 드러내며 공급자 native 차이를 평가 변수로 포함할지 실험 설계에 명시해야 한다.
- 실험 자식 CLI는 서버의 전체 환경을 상속하지 않고 PATH·HOME·locale·temp 등 최소 실행 환경과 선택 계정 config 변수만 받는다. 측정 시 CPU 경합을 줄이기 위해 작업 run과 평가를 합쳐 전역 한 작업만 실행한다.
- 현재 평가 패킷의 diff는 tracked 파일만 포함해 untracked 산출물은 최종 답변에 언급되지 않으면 심사할 수 없다. 100KiB 인라인 상한을 넘는 산출물·artifact 미리보기와 공급자 지문이 아닌 간접 문체/도구 흔적의 완전한 익명화는 후속 과제다.
- 별도 빈 evaluator cwd는 피험 경로를 프롬프트에서 숨기고 오작동을 줄이지만 OS namespace 격리는 아니다. Codex read-only와 Claude plan 모드는 호스트의 읽기 접근을 완전히 차단하지 않으므로 judgment에 `read-access-not-isolated` provenance를 남기며, 강한 블라인드가 필요한 실험은 컨테이너/샌드박스 런타임이 추가되기 전까지 이 한계를 포함해 해석해야 한다.
- 실패 원인이 한 덩어리로 뭉개진다. 현재 Claude 런타임은 `error_max_turns`와 `error_max_budget`만 전용 종료 이유로 매핑하고 나머지 result subtype과 0이 아닌 CLI 종료 코드를 모두 `runtime_error`로 넘긴다. 그래서 **모델 컨텍스트 초과, 공급자 사용량 한도, 실제 실행 오류가 같은 값으로 보인다.** 규모 축에서 대형 저장소 arm이 죽었을 때 구성이 나빴는지 컨텍스트가 모자랐는지 구분할 수 없고, 한도 대기(9-6)의 대상도 골라낼 수 없다. `context_exceeded`와 `provider_limit`을 종료 이유로 분리하는 것이 두 기능의 선행 과제다.
- 예산 검사는 사후 판정이다. `RuntimeBudgetPolicy`는 `usage` 이벤트가 도착한 뒤에야 상한과 비교하므로 상한에서 정확히 잘리지 않고 이미 넘긴 것을 확인해 중단한다. 또 공급자가 토큰을 보고하지 않아 `totalTokens`가 `null`이면 토큰 예산 검사를 조용히 건너뛰며, 이때 실제로 작동하는 상한은 시간 예산뿐이다.
- 공개 GitHub 저장소 fixture는 모델 학습 데이터에 이미 포함됐을 수 있다. 유명 저장소의 알려진 버그·CVE를 upstream 수정과 똑같이 고치는 것은 문제 해결 능력이 아니라 암기의 재현일 수 있으므로, fixture에 저장소 인지도와 commit 시점을 남기고 결론에 오염 가능성을 함께 표시해야 한다. 오래된 유명 저장소와 최근 commit을 섞어 이 차이를 관찰한다.
- 대형 저장소에서는 코드 탐색과 컨텍스트 관리 비용이 전체를 지배해 스킬·하네스 차이가 묻힐 수 있다. 컨텍스트나 시간 예산에 먼저 걸린 arm의 낮은 점수는 조건이 나빠서가 아니라 예산이 모자라서일 수 있으므로 종료 이유를 점수와 함께 읽어야 한다.
- 보안 취약점 관점은 정적 식별과 수정까지만 평가한다. 익스플로잇 실행·외부 대상 시도는 실험 범위 밖이며 취약한 fixture 코드는 네트워크를 끊은 격리 worktree에서만 다룬다.
- Claude Agent Teams는 실험적이며 공급자 문서에 알려진 재개·작업 조정·종료 제약이 있다.
- 승격된 preset도 공급자 모델·CLI·스킬 변경으로 시간이 지나면 재현성이 깨질 수 있어 호환성 상태와 마지막 검증 시각이 필요하다.
- 현재 승격 preset은 버전 원장과 활성 상태까지 제공하지만 일반 새 채팅/작업 생성 UI가 preset version을 선택해 Runtime 설정으로 소비하는 경로는 아직 연결되지 않았다.

## 18. 검증 전략

- 단위 테스트: 설정 검증, 상태 전이, 예산, 이벤트 순서, 합의 계산
- 계약 테스트: 기록된 Codex·Claude JSONL fixture를 런타임 공통 이벤트로 변환
- 통합 테스트: 가짜 런타임으로 루프·취소·재개·훅 실패 정책 검증
- 보안 테스트: 관리자 권한, CSRF, 경로 탈출, 민감 파일 제외, 명령 allowlist
- 스킬 격리 테스트: 전체 디렉터리 복사·symlink/용량 차단·digest 변조, project skill worktree 복제, provider별 argv, 비교 config 불일치 차단
- UI 테스트: 두 변형 생성, 실행 진행, 평가 불일치, 최종 사용자 판정
- 실제 CLI 스모크 테스트: 사용량 한도와 비용을 확인한 뒤 작은 고정 프롬프트로 공급자별 1회
- 승격 테스트: 완료 run 스냅샷 불변성, 새 버전 생성, 활성 버전 원자 전환, 롤백, 실제 채팅의 버전 고정

## 19. 참고 자료

### OpenAI Codex 공식 문서

- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Advanced configuration — hooks](https://learn.chatgpt.com/docs/config-advanced#hooks)

### Anthropic Claude Code 공식 문서

- [CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Hooks guide](https://code.claude.com/docs/en/hooks-guide)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Agent SDK: Claude Code features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)

공식 문서를 기준으로 하되 실제 구현은 설치된 CLI의 `--help`와 fixture 계약 테스트로 현재 버전 호환성을 함께 확인한다.
