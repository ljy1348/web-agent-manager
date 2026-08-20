import type { Provider } from "../../shared/types";
import type { ExperimentRunRecord } from "../services/experiment-repository";
import { ExperimentRepository } from "../services/experiment-repository";
import type { ExperimentProvider, ExperimentTerminationReason } from "../../shared/experiments";
import { classifyFailureReason } from "./failure-classification";
import { ActiveClock, RuntimeBudgetPolicy, type AgentRuntime, type RuntimeEvent, type RuntimeUsageSnapshot } from "./agent-runtime";
import {
  ExperimentHookBus,
  HookBlockedError,
  HookExecutionError,
  HookValidationError,
  type ExperimentHookEvent,
} from "./hook-bus";

interface SingleHarnessExecution {
  controller: AbortController;
  runtime: AgentRuntime;
  externalCancelled: boolean;
  terminationReason: ExperimentTerminationReason | null;
  // 한도 대기 구간을 예산·시간 지표에서 빼기 위해 run 전체에서 하나만 쓴다.
  clock: ActiveClock;
}

export interface SingleHarnessOptions {
  repository: ExperimentRepository;
  runtimes: Partial<Record<Provider, AgentRuntime>>;
  hookBus?: ExperimentHookBus;
  // fixture가 선언한 검증 명령. Runtime에 도구 허용 목록으로 전달한다.
  allowedCommands?: string[][];
  // 명시 호출 활성화에서 프롬프트 앞에 붙일 슬래시 명령.
  promptPrefix?: string;
  // 실패가 공급자 사용량 한도 때문인지 계정 상태로 확인한다. 주입하지 않으면 분류하지 않는다.
  isProviderLimited?: (provider: ExperimentProvider, accountId: number | null) => Promise<boolean>;
  // 한도가 풀릴 때까지 기다린다. true를 반환하면 같은 공급자 세션을 이어서 재개한다.
  waitForProviderLimit?: (runId: string, provider: ExperimentProvider, accountId: number | null, signal: AbortSignal) => Promise<boolean>;
}

// 한도 대기 뒤 같은 공급자 세션을 이어갈 때 보내는 계속 지시. tmux 채팅의 재개와 같은 방식이며,
// 이어붙인 run은 한 번에 끝낸 run과 캐시·턴 구조가 달라 토큰 지표가 오염된다(사용자가 감수하기로
// 결정). 대기 횟수는 run 원장에 남겨 비교 시 드러낸다.
const LIMIT_RESUME_PROMPT = "계속";
// 한 run이 한도 대기를 반복하는 횟수 상한. 넘으면 provider_limit으로 끝낸다.
const MAX_LIMIT_WAITS = 3;

// Runtime 이벤트를 undefined 없이 SQLite JSON payload로 복제한다.
function eventPayload(event: RuntimeEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}

// 훅 오류와 일반 오류를 run 종료 이유로 구분한다.
function errorReason(error: unknown): ExperimentTerminationReason {
  if (error instanceof HookBlockedError || error instanceof HookValidationError) return "policy_blocked";
  if (error instanceof HookExecutionError) return "hook_error";
  return "runtime_error";
}

// unknown 오류를 원장에 저장할 문자열로 바꾼다.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// single 변형 하나를 공급자 Runtime 한 번으로 수행하고 전체 과정을 원장에 투영한다.
export class SingleHarness {
  private readonly repository: ExperimentRepository;
  private readonly runtimes: Partial<Record<Provider, AgentRuntime>>;
  private readonly hookBus: ExperimentHookBus;
  private readonly allowedCommands: string[][];
  private readonly promptPrefix: string;
  private readonly isProviderLimited?: (provider: ExperimentProvider, accountId: number | null) => Promise<boolean>;
  private readonly waitForProviderLimit?: (runId: string, provider: ExperimentProvider, accountId: number | null, signal: AbortSignal) => Promise<boolean>;
  private readonly running = new Map<string, SingleHarnessExecution>();

  constructor(options: SingleHarnessOptions) {
    this.repository = options.repository;
    this.runtimes = options.runtimes;
    this.hookBus = options.hookBus ?? new ExperimentHookBus();
    this.allowedCommands = options.allowedCommands ?? [];
    this.promptPrefix = options.promptPrefix?.trim() ?? "";
    this.isProviderLimited = options.isProviderLimited;
    this.waitForProviderLimit = options.waitForProviderLimit;
  }

  // 일반 실행 오류를 구조화된 종료 이유로 좁힌다. 컨텍스트 초과는 오류 문구로, 공급자 한도는 계정
  // 사용량 상태로 판단하며 컨텍스트 쪽을 먼저 본다(한도와 무관하게 확정적인 신호이기 때문).
  private async narrowFailureReason(
    reason: ExperimentTerminationReason,
    run: ExperimentRunRecord | null,
    evidence: unknown = null,
  ): Promise<ExperimentTerminationReason> {
    if (reason !== "runtime_error") return reason;
    const classified = classifyFailureReason(reason, evidence);
    if (classified !== reason) return classified;
    if (!this.isProviderLimited || !run) return reason;
    try {
      const { provider, accountId } = run.configSnapshot.runtime;
      return await this.isProviderLimited(provider, accountId) ? "provider_limit" : reason;
    } catch {
      return reason;
    }
  }

  // queued run을 준비·실행·완료하며 외부 AbortSignal도 같은 취소 경로에 연결한다.
  async execute(runId: string, externalSignal?: AbortSignal): Promise<ExperimentRunRecord> {
    if (this.running.has(runId)) throw new Error("이미 실행 중인 single harness run입니다.");
    const initial = this.repository.getRun(runId);
    if (!initial) throw new Error("실험 실행을 찾을 수 없습니다.");
    if (initial.status !== "queued") throw new Error("queued 상태의 run만 새로 실행할 수 있습니다.");
    if (initial.configSnapshot.harness.type !== "single") throw new Error("SingleHarness는 single 변형만 실행할 수 있습니다.");
    if (!initial.workingDirectory) throw new Error("SingleHarness 실행에는 격리된 작업 디렉터리가 필요합니다.");
    const workingDirectory = initial.workingDirectory;
    const runtime = this.runtimes[initial.configSnapshot.runtime.provider];
    if (!runtime) throw new Error(`등록되지 않은 실험 Runtime입니다: ${initial.configSnapshot.runtime.provider}`);
    const execution: SingleHarnessExecution = {
      controller: new AbortController(), runtime, externalCancelled: false, terminationReason: null,
      clock: new ActiveClock(),
    };
    this.running.set(runId, execution);
    const externalAbort = () => { void this.cancel(runId); };
    externalSignal?.addEventListener("abort", externalAbort, { once: true });
    if (externalSignal?.aborted) externalAbort();
    try {
      return await this.executeRun(initial, workingDirectory, execution);
    } finally {
      externalSignal?.removeEventListener("abort", externalAbort);
      this.running.delete(runId);
    }
  }

  // 현재 실행 중인 run을 한 번만 취소하고 Runtime 후손 프로세스 정리를 요청한다.
  async cancel(runId: string): Promise<boolean> {
    const execution = this.running.get(runId);
    if (!execution) return false;
    execution.externalCancelled = true;
    execution.terminationReason = "cancelled";
    execution.controller.abort();
    await execution.runtime.cancel(runId);
    return true;
  }

  // 준비 snapshot부터 single node 체크포인트까지 실행 생명주기를 처리한다.
  private async executeRun(initial: ExperimentRunRecord, workingDirectory: string, execution: SingleHarnessExecution): Promise<ExperimentRunRecord> {
    const runId = initial.id;
    let eventOrdinal = this.repository.listEvents(runId, 0, 1_000).at(-1)?.sequence ?? 0;
    let nodeId: string | null = null;
    let latestUsage: RuntimeUsageSnapshot | null = null;
    let completedResult: Record<string, unknown> | null = null;
    let runtimeFailure: Extract<RuntimeEvent, { type: "failed" }> | null = null;

    // 한 실행 안에서 순서가 안정된 멱등 키로 이벤트를 append한다.
    const append = (type: string, payload: Record<string, unknown> = {}) => {
      eventOrdinal += 1;
      return this.repository.appendEvent({
        runId, idempotencyKey: `single:${eventOrdinal}:${type}`, type, payload,
      }).event;
    };
    // 훅 결과와 경고를 변환된 payload와 함께 불변 이벤트로 남긴다.
    const emitHook = async (event: ExperimentHookEvent, payload: Record<string, unknown>) => {
      const emission = await this.hookBus.emit({ event, runId, nodeId, payload });
      append(`hook.${event}`, {
        payload: emission.payload, warnings: emission.warnings, executions: emission.executions,
      });
      return emission;
    };
    // 예산·사용자 요청이 정한 우선 종료 이유를 보존하며 Runtime을 중단한다.
    const stopRuntime = (reason: ExperimentTerminationReason) => {
      if (execution.terminationReason === null) execution.terminationReason = reason;
      execution.controller.abort();
      void execution.runtime.cancel(runId);
    };

    try {
      this.repository.transitionRun({ runId, status: "preparing" });
      append("run.preparing", { provider: initial.configSnapshot.runtime.provider });
      const experiment = this.repository.getExperiment(initial.experimentId);
      if (!experiment) throw new Error("실험 정의를 찾을 수 없습니다.");
      const beforeRun = await emitHook("before_run", { prompt: experiment.command, config: initial.configSnapshot });
      const base = typeof beforeRun.payload.prompt === "string" ? beforeRun.payload.prompt : experiment.command;
      const prompt = this.promptPrefix ? `${this.promptPrefix}\n\n${base}` : base;
      if (!prompt.trim()) throw new Error("before_run 훅이 빈 실행 명령을 만들었습니다.");
      if (execution.controller.signal.aborted) return this.finishStopped(runId, nodeId, execution, append);

      const runtimeInput = {
        runId, workingDirectory, prompt, config: initial.configSnapshot,
        allowedCommands: this.allowedCommands,
      };
      const snapshot = await execution.runtime.prepare(runtimeInput);
      this.repository.mergeRunEnvironmentSnapshot(runId, { runtime: snapshot });
      append("runtime.prepared", { snapshot });
      nodeId = this.repository.createNode({
        runId, role: "worker", provider: initial.configSnapshot.runtime.provider,
        model: snapshot.resolvedModel, payload: { prompt },
      }).id;
      append("node.created", { nodeId, role: "worker" });
      if (execution.controller.signal.aborted) return this.finishStopped(runId, nodeId, execution, append);

      this.repository.transitionRun({ runId, status: "running" });
      this.repository.transitionNode({ nodeId, status: "running" });
      append("run.started", { nodeId });
      await emitHook("before_node", { nodeId, prompt, snapshot });
      const budget = new RuntimeBudgetPolicy(initial.configSnapshot.budget, execution.clock);
      let timeout = setTimeout(() => stopRuntime("time_budget"), budget.remainingActiveMs());
      timeout.unref();
      try {
        for (let attempt = 0; ; attempt += 1) {
          completedResult = null;
          runtimeFailure = null;
          const providerRunId = attempt === 0 ? null : this.repository.getRun(runId)?.providerRunId ?? null;
          const stream = providerRunId
            ? execution.runtime.resume({ ...runtimeInput, snapshot, prompt: LIMIT_RESUME_PROMPT, providerRunId, checkpoint: {} }, execution.controller.signal)
            : execution.runtime.run({ ...runtimeInput, snapshot }, execution.controller.signal);
          for await (const event of stream) {
            append(`runtime.${event.type}`, eventPayload(event));
            if (event.type === "started" && event.providerRunId) this.repository.recordProviderRunId(runId, event.providerRunId);
            if (event.type === "usage") {
              latestUsage = event.usage;
              this.repository.recordRunUsage(runId, event.usage);
              this.repository.recordNodeUsage(nodeId, event.usage);
              const violation = budget.check(event.usage);
              if (violation) stopRuntime(violation.reason);
            } else if (event.type === "completed") {
              completedResult = event.result;
            } else if (event.type === "failed") {
              runtimeFailure = event;
            }
            if (!execution.terminationReason) {
              const violation = budget.check(latestUsage);
              if (violation) stopRuntime(violation.reason);
            }
          }
          if (execution.terminationReason || completedResult || !runtimeFailure) break;
          const failureReason = await this.narrowFailureReason(runtimeFailure.reason ?? "runtime_error", this.repository.getRun(runId), runtimeFailure.error);
          if (failureReason !== "provider_limit") {
            runtimeFailure = { ...runtimeFailure, reason: failureReason };
            break;
          }
          // 한도는 실패가 아니라 대기로 처리한다. 이어붙일 공급자 세션이 없거나 대기 정책이 없으면
          // 그대로 provider_limit으로 끝낸다.
          if (!this.waitForProviderLimit || attempt >= MAX_LIMIT_WAITS || !this.repository.getRun(runId)?.providerRunId) {
            runtimeFailure = { ...runtimeFailure, reason: failureReason };
            break;
          }
          clearTimeout(timeout);
          const waitedFrom = Date.now();
          execution.clock.pause(waitedFrom);
          this.repository.transitionRun({ runId, status: "paused" });
          append("run.waiting", { nodeId, reason: failureReason, attempt });
          const recovered = await this.waitForProviderLimit(
            runId, initial.configSnapshot.runtime.provider, initial.configSnapshot.runtime.accountId, execution.controller.signal,
          ).catch(() => false);
          const waitedUntil = Date.now();
          execution.clock.resume(waitedUntil);
          this.repository.recordWait(runId, (waitedUntil - waitedFrom) / 1_000);
          if (execution.controller.signal.aborted || !recovered) {
            append("run.wait_abandoned", { nodeId, recovered });
            this.repository.transitionRun({ runId, status: "running" });
            runtimeFailure = { ...runtimeFailure, reason: failureReason };
            break;
          }
          this.repository.transitionRun({ runId, status: "running" });
          append("run.resumed", { nodeId, waitedSeconds: (waitedUntil - waitedFrom) / 1_000, attempt });
          timeout = setTimeout(() => stopRuntime("time_budget"), budget.remainingActiveMs());
          timeout.unref();
        }
      } finally {
        clearTimeout(timeout);
      }

      if (execution.terminationReason) {
        if (["time_budget", "token_budget", "cost_budget"].includes(execution.terminationReason)) {
          await emitHook("on_budget", { reason: execution.terminationReason, usage: latestUsage });
        }
        return this.finishStopped(runId, nodeId, execution, append);
      }
      if (runtimeFailure) {
        return this.finishFailed(runId, nodeId, runtimeFailure.reason ?? "runtime_error", runtimeFailure.error, append, emitHook);
      }
      if (!completedResult) {
        return this.finishFailed(runId, nodeId, "runtime_error", "Runtime이 완료 또는 실패 이벤트 없이 종료됐습니다.", append, emitHook);
      }

      await emitHook("after_node", { nodeId, result: completedResult, usage: latestUsage });
      this.repository.transitionNode({ nodeId, status: "completed", output: completedResult });
      const completedEvent = append("node.completed", { nodeId, result: completedResult });
      this.repository.saveCheckpoint({
        runId, nodeId, eventSequence: completedEvent.sequence,
        state: { harness: "single", nodeId, status: "completed", result: completedResult },
      });
      await emitHook("on_checkpoint", { nodeId, eventSequence: completedEvent.sequence });
      await emitHook("after_run", { nodeId, result: completedResult, usage: latestUsage });
      append("run.completed", { nodeId });
      return this.repository.transitionRun({ runId, status: "completed", terminationReason: "success" });
    } catch (error) {
      const reason = execution.terminationReason ?? errorReason(error);
      return this.finishFailed(runId, nodeId, reason, errorMessage(error), append, emitHook);
    }
  }

  // 취소·예산 초과를 node와 run의 서로 다른 terminal 상태로 투영한다.
  private finishStopped(
    runId: string,
    nodeId: string | null,
    execution: SingleHarnessExecution,
    append: (type: string, payload?: Record<string, unknown>) => { sequence: number },
  ): ExperimentRunRecord {
    const reason = execution.terminationReason ?? (execution.externalCancelled ? "cancelled" : "runtime_error");
    if (nodeId) {
      const node = this.repository.getNode(nodeId);
      if (node?.status === "queued" || node?.status === "running") this.repository.transitionNode({ nodeId, status: "cancelled", error: reason });
    }
    append("run.stopped", { nodeId, reason });
    const status = ["time_budget", "token_budget", "cost_budget"].includes(reason) ? "budget_exceeded" : "cancelled";
    return this.repository.transitionRun({ runId, status, terminationReason: reason, error: reason });
  }

  // 오류 훅을 기록한 뒤 node와 run을 실패 상태로 고정한다.
  private async finishFailed(
    runId: string,
    nodeId: string | null,
    reason: ExperimentTerminationReason,
    message: string,
    append: (type: string, payload?: Record<string, unknown>) => { sequence: number },
    emitHook: (event: ExperimentHookEvent, payload: Record<string, unknown>) => Promise<unknown>,
  ): Promise<ExperimentRunRecord> {
    try {
      await emitHook("on_error", { nodeId, reason, error: message });
    } catch (hookError) {
      reason = "hook_error";
      message = `${message}; on_error 훅 실패: ${errorMessage(hookError)}`;
    }
    if (nodeId) {
      const node = this.repository.getNode(nodeId);
      if (node?.status === "queued") this.repository.transitionNode({ nodeId, status: "cancelled", error: message });
      else if (node?.status === "running") this.repository.transitionNode({ nodeId, status: "failed", error: message });
    }
    const current = this.repository.getRun(runId);
    if (!current) throw new Error("실험 실행을 찾을 수 없습니다.");
    reason = await this.narrowFailureReason(reason, current, message);
    append("run.failed", { nodeId, reason, error: message });
    if (["completed", "failed", "cancelled", "budget_exceeded"].includes(current.status)) return current;
    if (reason === "cancelled") return this.repository.transitionRun({ runId, status: "cancelled", terminationReason: reason, error: message });
    if (["time_budget", "token_budget", "cost_budget"].includes(reason)) {
      return this.repository.transitionRun({ runId, status: "budget_exceeded", terminationReason: reason, error: message });
    }
    return this.repository.transitionRun({ runId, status: "failed", terminationReason: reason, error: message });
  }
}
