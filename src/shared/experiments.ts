import type { Provider } from "./types";

// 실험실이 실제로 돌릴 수 있는 공급자. 채팅 코어는 grok까지 지원하지만 실험실은 아직 하네스·평가자·DB
// 제약이 codex·claude만 다루므로, 채팅용 Provider와 구분해 실험실 경계에서 좁힌다.
// TODO: 실험실이 grok 실행·평가를 지원하게 되면 이 별칭을 없애고 Provider로 되돌린다(experiment_* 테이블의
// provider CHECK 제약과 실험 생성 UI도 함께 넓혀야 한다).
export type ExperimentProvider = Extract<Provider, "codex" | "claude">;

// 실험실이 다룰 수 있는 공급자인지 확인한다. 실험 설정을 만드는 입구에서 이 검사로 좁힌다.
export function isExperimentProvider(value: Provider): value is ExperimentProvider {
  return value === "codex" || value === "claude";
}

export const EXPERIMENT_RUN_STATUSES = [
  "queued", "preparing", "running", "paused", "evaluating",
  "completed", "failed", "cancelled", "budget_exceeded",
] as const;

export type ExperimentRunStatus = typeof EXPERIMENT_RUN_STATUSES[number];
export type ExperimentStatus = "draft" | "active" | "archived";
export type ExperimentHarnessType = "single" | "orchestrator_worker" | "evaluator_optimizer";
export type ExperimentSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type ExperimentSkillMode = "all" | "none" | "selected";
export type ExperimentSkillProfile = "native" | "isolated_overlay";
export type ExperimentSkillBaseline = "installed" | "clean";
// native=환경에만 설치하고 모델이 발견, explicit=사용자가 슬래시 명령으로 직접 호출, session_start=지시 본문 주입.
export type ExperimentSkillActivation = "native" | "explicit" | "session_start";
export type ExperimentTerminationReason =
  | "success"
  | "max_iterations"
  | "max_turns"
  | "token_budget"
  | "time_budget"
  | "cost_budget"
  | "no_improvement"
  | "provider_limit"
  | "context_exceeded"
  | "runtime_error"
  | "hook_error"
  | "evaluation_error"
  | "cancelled"
  | "policy_blocked";

// 9-2 과제 유형. 유형마다 시작 상태·정답 기준·금지 사항이 다르다. null은 유형을 지정하지 않은
// 기존 실험이다.
export const EXPERIMENT_TASK_KINDS = ["maintenance", "greenfield", "feature", "security"] as const;
export type ExperimentTaskKind = typeof EXPERIMENT_TASK_KINDS[number];

// 9-1 저장소 규모. 용량이 아니라 에이전트가 탐색해야 하는 LOC 기준으로 나눈다.
export const EXPERIMENT_FIXTURE_SIZE_CLASSES = ["small", "medium", "large"] as const;
export type ExperimentFixtureSizeClass = typeof EXPERIMENT_FIXTURE_SIZE_CLASSES[number];

// 적격성 게이트를 통과하기 전에는 실험 대상으로 쓰지 않는다.
export const EXPERIMENT_FIXTURE_STATUSES = ["draft", "ready", "rejected"] as const;
export type ExperimentFixtureStatus = typeof EXPERIMENT_FIXTURE_STATUSES[number];

export interface ExperimentFixtureInput {
  name: string;
  url: string;
  pinnedCommit: string;
  sizeClass: ExperimentFixtureSizeClass;
  language: string | null;
  license: string | null;
  linesOfCode: number | null;
  // shell 없이 execFile로 실행하기 위해 argv 배열로 고정한다. 임의 shell 문자열은 저장하지 않는다.
  setupCommand: string[];
  testCommand: string[];
}

export interface ExperimentRuntimeConfig {
  provider: ExperimentProvider;
  accountId: number | null;
  model: string | null;
  reasoningEffort: string | null;
  sandbox: ExperimentSandbox;
  maxTurns: number | null;
}

export interface ExperimentSkillConfig {
  mode: ExperimentSkillMode;
  enabled: string[];
  disabled: string[];
  profile: ExperimentSkillProfile;
  baseline: ExperimentSkillBaseline;
  additions: string[];
  comparisonId: string | null;
  activation: ExperimentSkillActivation;
}

export interface ExperimentHarnessConfig {
  type: ExperimentHarnessType;
  maxIterations: number;
  minimumScore: number | null;
  maxNoImprovement: number;
  workerCount: number;
  secondaryRuntime: Omit<ExperimentRuntimeConfig, "sandbox" | "maxTurns"> | null;
}

export interface ExperimentBudgetConfig {
  maxSeconds: number;
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface ExperimentVariantConfig {
  schemaVersion: 1;
  runtime: ExperimentRuntimeConfig;
  skills: ExperimentSkillConfig;
  harness: ExperimentHarnessConfig;
  hooks: string[];
  budget: ExperimentBudgetConfig;
}

export interface ExperimentEvaluatorConfig {
  label: string;
  provider: ExperimentProvider;
  accountId: number | null;
  model: string | null;
  reasoningEffort: string | null;
  family: string;
}

export interface ExperimentDesign {
  schemaVersion: 1;
  hypothesis: string | null;
  controlledVariables: string[];
  treatmentVariables: string[];
  repetitions: number;
  randomizeOrder: boolean;
}

export interface ExperimentTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  totalTokensSource: "reported" | "derived" | null;
}

export interface ExperimentEventRecord {
  id: string;
  runId: string;
  sequence: number;
  idempotencyKey: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExperimentCheckpointRecord {
  runId: string;
  nodeId: string | null;
  eventSequence: number;
  state: Record<string, unknown>;
  artifacts: string[];
  createdAt: string;
  updatedAt: string;
}

// JSON 입력이 객체인지 확인해 중첩 설정 검증을 안전하게 이어간다.
function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 설정은 객체여야 합니다.`);
  return value as Record<string, unknown>;
}

// 선택 문자열을 허용 목록과 대조해 타입이 다른 실행 조건을 차단한다.
function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`지원하지 않는 ${label}입니다.`);
  return value as T;
}

// 선택 가능한 문자열 값을 공백 제거 후 정규화한다.
function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${label}은 문자열이어야 합니다.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) throw new Error(`${label}은 1자 이상 500자 이하여야 합니다.`);
  return normalized;
}

// 필수 짧은 문자열을 evaluator label·family 같은 provenance 값으로 검증한다.
function requiredShortString(value: unknown, label: string): string {
  const normalized = optionalString(value, label);
  if (!normalized) throw new Error(`${label}이 필요합니다.`);
  return normalized;
}

// 중복 없는 짧은 문자열 목록으로 스킬·훅 식별자를 정규화한다.
function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label}은 최대 100개의 문자열 목록이어야 합니다.`);
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 1_000) throw new Error(`${label} 항목이 올바르지 않습니다.`);
    return entry.trim();
  });
  return [...new Set(normalized)];
}

// 정수 설정을 지정 범위 안으로 제한한다.
function integerValue(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || Number(selected) < minimum || Number(selected) > maximum) {
    throw new Error(`${label}은 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
  }
  return Number(selected);
}

// 선택 가능한 숫자 설정을 지정 범위 안으로 제한한다.
function optionalNumber(value: unknown, minimum: number, maximum: number, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label}은 ${minimum}~${maximum} 범위의 숫자여야 합니다.`);
  }
  return value;
}

// API·DB·런타임이 공유할 버전 1 실험 변형 설정을 검증하고 기본값을 채운다.
export function parseExperimentVariantConfig(value: unknown): ExperimentVariantConfig {
  const root = objectValue(value, "실험 변형");
  if (root.schemaVersion !== 1) throw new Error("지원하지 않는 실험 변형 스키마 버전입니다.");
  const runtime = objectValue(root.runtime, "런타임");
  const skills = objectValue(root.skills ?? {}, "스킬");
  const harness = objectValue(root.harness ?? {}, "하네스");
  const budget = objectValue(root.budget ?? {}, "예산");
  const secondaryRuntime = harness.secondaryRuntime == null ? null : objectValue(harness.secondaryRuntime, "보조 런타임");
  const accountId = runtime.accountId === undefined || runtime.accountId === null
    ? null
    : integerValue(runtime.accountId, 0, 1, Number.MAX_SAFE_INTEGER, "계정 ID");
  const config: ExperimentVariantConfig = {
    schemaVersion: 1,
    runtime: {
      provider: enumValue(runtime.provider, ["codex", "claude"] as const, "공급자"),
      accountId,
      model: optionalString(runtime.model, "모델"),
      reasoningEffort: optionalString(runtime.reasoningEffort, "추론 강도"),
      sandbox: enumValue(runtime.sandbox ?? "workspace-write", ["read-only", "workspace-write", "danger-full-access"] as const, "샌드박스"),
      maxTurns: runtime.maxTurns === undefined || runtime.maxTurns === null
        ? null
        : integerValue(runtime.maxTurns, 0, 1, 10_000, "공급자 최대 turn 수"),
    },
    skills: {
      mode: enumValue(skills.mode ?? "all", ["all", "none", "selected"] as const, "스킬 모드"),
      enabled: stringList(skills.enabled, "활성 스킬"),
      disabled: stringList(skills.disabled, "비활성 스킬"),
      profile: enumValue(skills.profile ?? "native", ["native", "isolated_overlay"] as const, "스킬 프로필"),
      baseline: enumValue(
        skills.baseline ?? (skills.mode === "none" ? "clean" : "installed"),
        ["installed", "clean"] as const,
        "스킬 기준선",
      ),
      additions: stringList(skills.additions ?? [], "추가 스킬"),
      comparisonId: optionalString(skills.comparisonId, "스킬 비교 그룹"),
      activation: enumValue(skills.activation ?? "native", ["native", "explicit", "session_start"] as const, "스킬 활성화 방식"),
    },
    harness: {
      type: enumValue(harness.type ?? "single", ["single", "orchestrator_worker", "evaluator_optimizer"] as const, "하네스"),
      maxIterations: integerValue(harness.maxIterations, 1, 1, 100, "최대 반복 횟수"),
      minimumScore: optionalNumber(harness.minimumScore, 0, 1, "최소 점수"),
      maxNoImprovement: integerValue(harness.maxNoImprovement, 1, 0, 100, "무개선 허용 횟수"),
      workerCount: integerValue(harness.workerCount, 2, 1, 8, "작업자 수"),
      secondaryRuntime: secondaryRuntime ? {
        provider: enumValue(secondaryRuntime.provider, ["codex", "claude"] as const, "보조 공급자"),
        accountId: secondaryRuntime.accountId == null
          ? null
          : integerValue(secondaryRuntime.accountId, 0, 1, Number.MAX_SAFE_INTEGER, "보조 계정 ID"),
        model: optionalString(secondaryRuntime.model, "보조 모델"),
        reasoningEffort: optionalString(secondaryRuntime.reasoningEffort, "보조 추론 강도"),
      } : null,
    },
    hooks: stringList(root.hooks, "훅"),
    budget: {
      maxSeconds: integerValue(budget.maxSeconds, 1_800, 1, 86_400, "최대 실행 시간"),
      maxTokens: optionalNumber(budget.maxTokens, 1, 2_000_000_000, "최대 토큰"),
      maxCostUsd: optionalNumber(budget.maxCostUsd, 0, 1_000_000, "최대 비용"),
    },
  };
  if (config.skills.profile === "isolated_overlay") {
    if (!config.skills.comparisonId) throw new Error("격리 스킬 비교에는 comparisonId가 필요합니다.");
    const expectedMode = config.skills.baseline === "installed" ? "all" : "none";
    if (config.skills.mode !== expectedMode) throw new Error(`스킬 ${config.skills.baseline} 기준선은 mode:${expectedMode}이어야 합니다.`);
    if (config.skills.enabled.length || config.skills.disabled.length) {
      throw new Error("격리 스킬 비교는 enabled/disabled 대신 baseline과 additions만 사용해야 합니다.");
    }
    // graph는 primary·secondary가 서로 다른 공급자일 수 있어 실행 시 공급자별 bundle을 따로 만든다.
    // SessionStart 주입은 Claude 전용 plugin hook이라 그 조합만 single로 제한한다.
    if (config.harness.type !== "single" && config.skills.activation === "session_start") {
      throw new Error("SessionStart 스킬 활성화는 공급자별 bundle을 공유하지 않는 single 하네스에서만 실행할 수 있습니다.");
    }
    if (!config.runtime.model || !config.runtime.reasoningEffort) {
      throw new Error("격리 스킬 비교는 설정 source의 기본값 영향을 막기 위해 모델과 추론 강도를 명시해야 합니다.");
    }
    if (config.skills.activation === "explicit" && !config.skills.additions.length) {
      throw new Error("명시 호출 활성화에는 부를 추가 스킬이 필요합니다.");
    }
    if (config.skills.activation === "session_start" && config.runtime.provider !== "claude") {
      throw new Error("SessionStart 스킬 활성화는 현재 Claude single 런타임에서만 지원합니다.");
    }
  }
  return config;
}

// 복수 evaluator 요청을 중복 label 없는 공급자별 실행 조건으로 검증한다.
export function parseExperimentEvaluators(value: unknown): ExperimentEvaluatorConfig[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error("evaluator는 1~4개가 필요합니다.");
  const evaluators = value.map((entry, index) => {
    const root = objectValue(entry, `evaluator ${index + 1}`);
    const provider = enumValue(root.provider, ["codex", "claude"] as const, "evaluator 공급자");
    const accountId = root.accountId === undefined || root.accountId === null
      ? null
      : integerValue(root.accountId, 0, 1, Number.MAX_SAFE_INTEGER, "evaluator 계정 ID");
    return {
      label: requiredShortString(root.label, "evaluator label"), provider, accountId,
      model: optionalString(root.model, "evaluator 모델"),
      reasoningEffort: optionalString(root.reasoningEffort, "evaluator 추론 강도"),
      family: root.family === undefined || root.family === null || root.family === ""
        ? provider
        : requiredShortString(root.family, "evaluator family").toLowerCase(),
    } satisfies ExperimentEvaluatorConfig;
  });
  if (new Set(evaluators.map((entry) => entry.label)).size !== evaluators.length) {
    throw new Error("evaluator label은 한 평가 안에서 중복될 수 없습니다.");
  }
  return evaluators;
}

// 비교에서 고정할 조건과 평가할 차이를 실험 수준의 재현 가능한 설계로 검증한다.
export function parseExperimentDesign(value: unknown): ExperimentDesign {
  const root = objectValue(value, "실험 설계");
  if (root.schemaVersion !== 1) throw new Error("지원하지 않는 실험 설계 스키마 버전입니다.");
  const controlledVariables = stringList(root.controlledVariables, "통제 변수");
  const treatmentVariables = stringList(root.treatmentVariables, "평가 변수");
  const overlap = controlledVariables.find((entry) => treatmentVariables.includes(entry));
  if (overlap) throw new Error(`같은 조건을 통제 변수와 평가 변수에 함께 둘 수 없습니다: ${overlap}`);
  if (typeof root.randomizeOrder !== "undefined" && typeof root.randomizeOrder !== "boolean") {
    throw new Error("실행 순서 무작위화 설정은 boolean이어야 합니다.");
  }
  return {
    schemaVersion: 1,
    hypothesis: optionalString(root.hypothesis, "실험 가설"),
    controlledVariables,
    treatmentVariables,
    repetitions: integerValue(root.repetitions, 1, 1, 100, "반복 실행 횟수"),
    randomizeOrder: root.randomizeOrder === undefined ? true : root.randomizeOrder,
  };
}

// fixture 명령을 shell 없이 실행할 argv 배열로 검증한다. 빈 배열은 "명령 없음"으로 허용한다.
function commandArgv(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error(`${label}은 최대 40개의 인자 배열이어야 합니다.`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 500) throw new Error(`${label} 인자가 올바르지 않습니다.`);
    return entry.trim();
  });
}

// 외부 공개 저장소 fixture 정의를 검증한다. 임의 URL·짧은 commit·shell 문자열을 받지 않는다.
export function parseExperimentFixtureInput(value: unknown): ExperimentFixtureInput {
  const root = objectValue(value, "저장소 fixture");
  const url = requiredShortString(root.url, "fixture URL");
  // 공개 저장소만 대상으로 하며 file은 로컬 고정 fixture용이다. ssh·git 프로토콜은 받지 않는다.
  if (!/^(https:\/\/|file:\/\/)/.test(url)) throw new Error("fixture URL은 https:// 또는 file://이어야 합니다.");
  const pinnedCommit = requiredShortString(root.pinnedCommit, "fixture 기준 commit");
  // 짧은 SHA는 저장소가 커지면 모호해지므로 40자 전체를 요구한다.
  if (!/^[0-9a-f]{40}$/i.test(pinnedCommit)) throw new Error("fixture 기준 commit은 40자 SHA여야 합니다.");
  const linesOfCode = root.linesOfCode === undefined || root.linesOfCode === null
    ? null
    : integerValue(root.linesOfCode, 0, 0, 1_000_000_000, "fixture LOC");
  return {
    name: requiredShortString(root.name, "fixture 이름"),
    url,
    pinnedCommit: pinnedCommit.toLowerCase(),
    sizeClass: enumValue(root.sizeClass, EXPERIMENT_FIXTURE_SIZE_CLASSES, "fixture 규모"),
    language: optionalString(root.language, "fixture 언어"),
    license: optionalString(root.license, "fixture 라이선스"),
    linesOfCode,
    setupCommand: commandArgv(root.setupCommand, "fixture 준비 명령"),
    testCommand: commandArgv(root.testCommand, "fixture 검증 명령"),
  };
}

// 과제 유형을 검증한다. null은 유형을 지정하지 않은 기존 실험을 뜻한다.
export function parseExperimentTaskKind(value: unknown): ExperimentTaskKind | null {
  if (value === undefined || value === null || value === "") return null;
  return enumValue(value, EXPERIMENT_TASK_KINDS, "과제 유형");
}
