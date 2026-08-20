import type { ExperimentBudgetConfig, ExperimentTerminationReason, ExperimentVariantConfig } from "../../shared/experiments";

export interface RuntimeUsageSnapshot {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  totalTokensSource: "reported" | "derived" | null;
  costUsd: number | null;
}

export interface RuntimeSnapshot {
  provider: "codex" | "claude";
  cliVersion: string;
  resolvedModel: string | null;
  toolProfile: Record<string, unknown>;
  permissionProfile: Record<string, unknown>;
  skillManifest: Array<{ id: string; path: string; sha256: string }>;
  skillOverlay?: ExperimentSkillOverlaySnapshot | null;
  preparedAt: string;
}

export interface ExperimentSkillOverlaySnapshot {
  profile: "isolated_overlay";
  baseline: "installed" | "clean";
  comparisonId: string;
  activation: "native" | "explicit" | "session_start";
  bundleRoot: string;
  pluginManifest: string;
  baselineSkills: Array<{ id: string; name: string; source: string; directory: string }>;
  additions: Array<{ id: string; name: string; source: string; directory: string }>;
  files: Array<{ path: string; sha256: string; size: number; mode: number }>;
  digest: string;
}

export interface RuntimePrepareInput {
  runId: string;
  workingDirectory: string;
  prompt: string;
  config: ExperimentVariantConfig;
  // fixture가 선언한 검증 명령. 비대화형 실행에는 승인할 사람이 없어 기본 권한 모드로는 Bash가 전부
  // 거부되므로, 이 명령만 정확히 허용해 에이전트가 스스로 검증할 수 있게 한다.
  allowedCommands?: string[][];
}

export interface RuntimeRunInput extends RuntimePrepareInput {
  snapshot: RuntimeSnapshot;
  outputSchema?: Record<string, unknown>;
}

export interface RuntimeResumeInput extends RuntimeRunInput {
  providerRunId: string;
  checkpoint: Record<string, unknown>;
}

export type RuntimeEvent =
  | { type: "started"; providerRunId: string | null; occurredAt: string; details?: Record<string, unknown> }
  | { type: "message"; role: "user" | "assistant" | "system" | "tool"; text: string; occurredAt: string; parentToolCallId?: string | null }
  | { type: "tool_started" | "tool_finished"; name: string; payload: Record<string, unknown>; occurredAt: string; toolCallId?: string | null; parentToolCallId?: string | null }
  | { type: "usage"; usage: RuntimeUsageSnapshot; occurredAt: string }
  | { type: "artifact"; path: string; kind: string; occurredAt: string }
  | { type: "completed"; result: Record<string, unknown>; occurredAt: string }
  | { type: "failed"; error: string; reason?: ExperimentTerminationReason; occurredAt: string };

// Codex·Claude의 비대화형 실행을 같은 준비·실행·재개·취소 이벤트 계약으로 노출한다.
export interface AgentRuntime {
  prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot>;
  run(input: RuntimeRunInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  resume(input: RuntimeResumeInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  cancel(runId: string): Promise<void>;
}

export interface BudgetObservation {
  elapsedSeconds: number;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface BudgetViolation {
  dimension: "time" | "tokens" | "cost";
  reason: Extract<ExperimentTerminationReason, "time_budget" | "token_budget" | "cost_budget">;
  observed: number;
  limit: number;
}

// 대기 구간을 제외한 실작업 시간을 잰다. 공급자 사용량 한도로 기다린 시간은 구성의 성질이 아니라
// 그날 계정에 남아 있던 사용량의 문제라, 예산 판정과 비교 지표 양쪽에서 빼야 한다.
export class ActiveClock {
  private waitedMs = 0;
  private pausedAtMs: number | null = null;

  constructor(private readonly startedAtMs = Date.now()) {}

  // 대기 시작. 이미 멈춘 상태의 재호출은 무시해 대기 시간이 이중 계산되지 않게 한다.
  pause(nowMs = Date.now()): void {
    if (this.pausedAtMs === null) this.pausedAtMs = nowMs;
  }

  // 대기 종료. 멈춘 적 없으면 아무것도 하지 않는다.
  resume(nowMs = Date.now()): void {
    if (this.pausedAtMs === null) return;
    this.waitedMs += Math.max(0, nowMs - this.pausedAtMs);
    this.pausedAtMs = null;
  }

  // 진행 중인 대기까지 포함한 누적 대기 시간.
  waitedSeconds(nowMs = Date.now()): number {
    const pending = this.pausedAtMs === null ? 0 : Math.max(0, nowMs - this.pausedAtMs);
    return (this.waitedMs + pending) / 1_000;
  }

  // 시작 이후 경과에서 대기를 뺀 실작업 시간.
  activeSeconds(nowMs = Date.now()): number {
    return Math.max(0, (nowMs - this.startedAtMs) / 1_000 - this.waitedSeconds(nowMs));
  }
}

// WAM 하드 예산을 실작업 시간과 공급자가 보고한 누적 usage에 대해 판정한다.
export class RuntimeBudgetPolicy {
  private readonly clock: ActiveClock;

  constructor(
    private readonly budget: ExperimentBudgetConfig,
    startedAtMsOrClock: number | ActiveClock = Date.now(),
  ) {
    this.clock = typeof startedAtMsOrClock === "number" ? new ActiveClock(startedAtMsOrClock) : startedAtMsOrClock;
  }

  // 현재 관측값을 만들되 공급자가 보고하지 않은 토큰·비용은 null로 유지한다.
  observe(usage: RuntimeUsageSnapshot | null, nowMs = Date.now()): BudgetObservation {
    return {
      elapsedSeconds: this.clock.activeSeconds(nowMs),
      totalTokens: usage?.totalTokens ?? null,
      costUsd: usage?.costUsd ?? null,
    };
  }

  // 시간 예산까지 남은 실작업 시간(ms). 대기 중에는 타이머를 다시 걸 때 이 값을 쓴다.
  remainingActiveMs(nowMs = Date.now()): number {
    return Math.max(0, this.budget.maxSeconds * 1_000 - this.clock.activeSeconds(nowMs) * 1_000);
  }

  // 시간·토큰·비용 순으로 하드 상한을 확인해 첫 초과 차원을 반환한다.
  check(usage: RuntimeUsageSnapshot | null, nowMs = Date.now()): BudgetViolation | null {
    const observation = this.observe(usage, nowMs);
    if (observation.elapsedSeconds >= this.budget.maxSeconds) {
      return { dimension: "time", reason: "time_budget", observed: observation.elapsedSeconds, limit: this.budget.maxSeconds };
    }
    if (this.budget.maxTokens !== null && observation.totalTokens !== null && observation.totalTokens >= this.budget.maxTokens) {
      return { dimension: "tokens", reason: "token_budget", observed: observation.totalTokens, limit: this.budget.maxTokens };
    }
    if (this.budget.maxCostUsd !== null && observation.costUsd !== null && observation.costUsd >= this.budget.maxCostUsd) {
      return { dimension: "cost", reason: "cost_budget", observed: observation.costUsd, limit: this.budget.maxCostUsd };
    }
    return null;
  }
}
