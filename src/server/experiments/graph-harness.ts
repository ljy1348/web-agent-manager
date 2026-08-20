import type { Provider } from "../../shared/types";
import type { ExperimentProvider, ExperimentTerminationReason, ExperimentVariantConfig } from "../../shared/experiments";
import type { ExperimentRunRecord } from "../services/experiment-repository";
import { ExperimentRepository } from "../services/experiment-repository";
import { classifyFailureReason } from "./failure-classification";
import { ActiveClock, RuntimeBudgetPolicy, type AgentRuntime, type RuntimeEvent, type RuntimeUsageSnapshot } from "./agent-runtime";
import { ExperimentHookBus, HookBlockedError, HookExecutionError, HookValidationError } from "./hook-bus";

// node 하나가 한도 대기를 반복하는 횟수 상한과 재개 지시. single 하네스와 같은 방식이다.
const LIMIT_RESUME_PROMPT = "계속";
const MAX_LIMIT_WAITS = 3;

interface GraphExecution {
  controller: AbortController;
  runtime: AgentRuntime | null;
  runtimeRunId: string | null;
  cancelled: boolean;
  stopReason: ExperimentTerminationReason | null;
  // 한도 대기 구간을 예산·시간 지표에서 빼기 위해 run 전체에서 하나만 쓴다.
  clock: ActiveClock;
}

interface NodeResult {
  nodeId: string;
  finalAnswer: string;
}

export interface GraphHarnessOptions {
  repository: ExperimentRepository;
  primaryRuntime: AgentRuntime;
  secondaryRuntime: AgentRuntime;
  hookBus?: ExperimentHookBus;
  // 실패가 공급자 사용량 한도 때문인지 계정 상태로 확인한다. 주입하지 않으면 분류하지 않는다.
  isProviderLimited?: (provider: ExperimentProvider, accountId: number | null) => Promise<boolean>;
  // 한도가 풀릴 때까지 기다린다. true면 같은 node의 공급자 세션을 이어서 재개한다.
  waitForProviderLimit?: (runId: string, provider: ExperimentProvider, accountId: number | null, signal: AbortSignal) => Promise<boolean>;
}

class GraphStopError extends Error {
  constructor(public readonly reason: ExperimentTerminationReason, message: string) {
    super(message);
    this.name = "GraphStopError";
  }
}

// evaluator JSON을 점수·근거로 엄격히 검증한다.
function parseReview(text: string): { score: number; reason: string } {
  const parsed = JSON.parse(text.trim()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("평가자가 JSON 객체를 반환하지 않았습니다.");
  const value = parsed as Record<string, unknown>;
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) throw new Error("평가 점수는 0~1이어야 합니다.");
  if (typeof value.reason !== "string" || !value.reason.trim()) throw new Error("평가 근거가 필요합니다.");
  return { score: value.score, reason: value.reason.trim() };
}

// node 출력·다음 prompt에 저장할 텍스트를 원장 상한 안으로 제한한다.
function boundedText(value: string, maximum = 80_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[이후 ${value.length - maximum}자 절단]`;
}

// 복수 Runtime 호출을 그래프 node로 실행하는 orchestrator-worker와 evaluator-optimizer 하네스다.
export class GraphHarness {
  private readonly repository: ExperimentRepository;
  private readonly primaryRuntime: AgentRuntime;
  private readonly secondaryRuntime: AgentRuntime;
  private readonly hookBus: ExperimentHookBus;
  private readonly isProviderLimited?: (provider: ExperimentProvider, accountId: number | null) => Promise<boolean>;
  private readonly waitForProviderLimit?: (runId: string, provider: ExperimentProvider, accountId: number | null, signal: AbortSignal) => Promise<boolean>;
  private readonly active = new Map<string, GraphExecution>();

  constructor(options: GraphHarnessOptions) {
    this.repository = options.repository;
    this.primaryRuntime = options.primaryRuntime;
    this.secondaryRuntime = options.secondaryRuntime;
    this.hookBus = options.hookBus ?? new ExperimentHookBus();
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

  // queued 그래프 run을 선택한 하네스 방식으로 실행하고 terminal 상태를 반환한다.
  async execute(runId: string): Promise<ExperimentRunRecord> {
    if (this.active.has(runId)) throw new Error("이미 실행 중인 그래프 run입니다.");
    const initial = this.repository.getRun(runId);
    if (!initial || initial.status !== "queued" || !initial.workingDirectory) throw new Error("queued 상태와 격리 작업공간이 있는 run이 필요합니다.");
    if (initial.configSnapshot.harness.type === "single") throw new Error("GraphHarness는 single 변형을 실행하지 않습니다.");
    const execution: GraphExecution = { controller: new AbortController(), runtime: null, runtimeRunId: null, cancelled: false, stopReason: null, clock: new ActiveClock() };
    this.active.set(runId, execution);
    let ordinal = 0;
    const append = (type: string, payload: Record<string, unknown> = {}) => {
      ordinal += 1;
      return this.repository.appendEvent({ runId, idempotencyKey: `graph:${ordinal}:${type}`, type, payload }).event;
    };
    const emitHook = async (event: Parameters<ExperimentHookBus["emit"]>[0]["event"], nodeId: string | null, payload: Record<string, unknown>) => {
      const emission = await this.hookBus.emit({ event, runId, nodeId, payload });
      append(`hook.${event}`, { payload: emission.payload, warnings: emission.warnings, executions: emission.executions });
      return emission.payload;
    };
    const budget = new RuntimeBudgetPolicy(initial.configSnapshot.budget, execution.clock);
    const timeout = setTimeout(() => {
      execution.stopReason ??= "time_budget";
      execution.controller.abort();
      if (execution.runtime && execution.runtimeRunId) void execution.runtime.cancel(execution.runtimeRunId);
    }, budget.remainingActiveMs());
    timeout.unref();
    try {
      this.repository.transitionRun({ runId, status: "preparing" });
      const experiment = this.repository.getExperiment(initial.experimentId);
      if (!experiment) throw new Error("실험을 찾을 수 없습니다.");
      const before = await emitHook("before_run", null, { prompt: experiment.command, config: initial.configSnapshot });
      const task = typeof before.prompt === "string" && before.prompt.trim() ? before.prompt : experiment.command;
      this.repository.transitionRun({ runId, status: "running" });
      append("run.started", { harness: initial.configSnapshot.harness.type });
      const finalNode = initial.configSnapshot.harness.type === "orchestrator_worker"
        ? await this.executeOrchestratorWorker(initial, task, execution, append, emitHook, budget)
        : await this.executeEvaluatorOptimizer(initial, task, execution, append, emitHook, budget);
      const checkpointEvent = append("run.completed", { nodeId: finalNode.nodeId });
      this.repository.saveCheckpoint({
        runId, nodeId: finalNode.nodeId, eventSequence: checkpointEvent.sequence,
        state: { harness: initial.configSnapshot.harness.type, status: "completed", finalAnswer: finalNode.finalAnswer },
      });
      await emitHook("on_checkpoint", finalNode.nodeId, { eventSequence: checkpointEvent.sequence });
      await emitHook("after_run", finalNode.nodeId, { finalAnswer: finalNode.finalAnswer });
      return this.repository.transitionRun({ runId, status: "completed", terminationReason: "success" });
    } catch (error) {
      const current = this.repository.getRun(runId)!;
      const raw = execution.cancelled ? "cancelled" : execution.stopReason ?? (error instanceof GraphStopError ? error.reason : this.hookReason(error));
      const message = error instanceof Error ? error.message : String(error);
      const reason = await this.narrowFailureReason(raw, current, message);
      append("run.failed", { reason, error: message });
      try { await emitHook("on_error", null, { reason, error: message }); } catch { /* 원래 종료 이유를 보존한다. */ }
      if (["completed", "failed", "cancelled", "budget_exceeded"].includes(current.status)) return current;
      if (reason === "cancelled") return this.repository.transitionRun({ runId, status: "cancelled", terminationReason: reason, error: message });
      if (["time_budget", "token_budget", "cost_budget"].includes(reason)) {
        return this.repository.transitionRun({ runId, status: "budget_exceeded", terminationReason: reason, error: message });
      }
      return this.repository.transitionRun({ runId, status: "failed", terminationReason: reason, error: message });
    } finally {
      clearTimeout(timeout);
      this.active.delete(runId);
    }
  }

  // 현재 그래프 node Runtime을 중단한다.
  async cancel(runId: string): Promise<boolean> {
    const execution = this.active.get(runId);
    if (!execution) return false;
    execution.cancelled = true;
    execution.stopReason = "cancelled";
    execution.controller.abort();
    if (execution.runtime && execution.runtimeRunId) await execution.runtime.cancel(execution.runtimeRunId);
    return true;
  }

  // 계획→순차 worker→통합 흐름을 node 부모 관계로 기록한다.
  private async executeOrchestratorWorker(
    run: ExperimentRunRecord, task: string, execution: GraphExecution,
    append: (type: string, payload?: Record<string, unknown>) => { sequence: number },
    emitHook: (event: Parameters<ExperimentHookBus["emit"]>[0]["event"], nodeId: string | null, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    budget: RuntimeBudgetPolicy,
  ): Promise<NodeResult> {
    const plan = await this.runNode(run, "orchestrator", `다음 작업을 ${run.configSnapshot.harness.workerCount}개 역할로 분해해 실행 계획만 작성하세요. 파일은 수정하지 마세요.\n\n${task}`, this.primaryRuntime, this.withSandbox(run.configSnapshot, "read-only", false), null, execution, append, emitHook, budget);
    const workers: NodeResult[] = [];
    for (let index = 0; index < run.configSnapshot.harness.workerCount; index += 1) {
      workers.push(await this.runNode(
        run, `worker-${index + 1}`,
        `공통 작업과 조정자 계획을 바탕으로 ${index + 1}/${run.configSnapshot.harness.workerCount} 역할을 수행하세요. 같은 작업공간을 순차 공유하므로 기존 변경을 보존하고 구현·테스트 결과를 보고하세요.\n\n작업:\n${task}\n\n계획:\n${plan.finalAnswer}`,
        this.secondaryRuntime, this.withSandbox(run.configSnapshot, "workspace-write", true), plan.nodeId,
        execution, append, emitHook, budget,
      ));
    }
    return this.runNode(
      run, "synthesizer",
      `작업자 결과를 검토하고 작업공간의 변경을 통합·보완·검증해 최종 결과를 보고하세요.\n\n원래 작업:\n${task}\n\n작업자 보고:\n${workers.map((worker, index) => `#${index + 1} ${worker.finalAnswer}`).join("\n\n")}`,
      this.primaryRuntime, this.withSandbox(run.configSnapshot, "workspace-write", false), workers.at(-1)?.nodeId ?? plan.nodeId,
      execution, append, emitHook, budget,
    );
  }

  // 초안→평가→개선을 점수·무개선·반복 상한까지 반복한다.
  private async executeEvaluatorOptimizer(
    run: ExperimentRunRecord, task: string, execution: GraphExecution,
    append: (type: string, payload?: Record<string, unknown>) => { sequence: number },
    emitHook: (event: Parameters<ExperimentHookBus["emit"]>[0]["event"], nodeId: string | null, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    budget: RuntimeBudgetPolicy,
  ): Promise<NodeResult> {
    let candidate = await this.runNode(run, "draft", task, this.primaryRuntime, this.withSandbox(run.configSnapshot, "workspace-write", false), null, execution, append, emitHook, budget);
    let bestScore = -1;
    let noImprovement = 0;
    const minimum = run.configSnapshot.harness.minimumScore ?? 0.8;
    for (let iteration = 1; iteration <= run.configSnapshot.harness.maxIterations; iteration += 1) {
      await emitHook("before_evaluate", candidate.nodeId, { iteration, candidate: candidate.finalAnswer });
      const reviewNode = await this.runNode(
        run, `evaluator-${iteration}`,
        `작업공간과 아래 작업 보고를 평가하세요. 설명이나 코드펜스 없이 {"score":0~1,"reason":"근거"} JSON 하나만 반환하세요.\n\n작업:\n${task}\n\n보고:\n${candidate.finalAnswer}`,
        this.secondaryRuntime, this.withSandbox(run.configSnapshot, "read-only", true), candidate.nodeId,
        execution, append, emitHook, budget,
      );
      const review = parseReview(reviewNode.finalAnswer);
      await emitHook("after_evaluate", reviewNode.nodeId, { iteration, ...review });
      append("loop.evaluated", { iteration, score: review.score, minimum });
      if (review.score >= minimum) return candidate;
      if (review.score > bestScore) { bestScore = review.score; noImprovement = 0; } else noImprovement += 1;
      if (noImprovement > run.configSnapshot.harness.maxNoImprovement) throw new GraphStopError("no_improvement", "평가 점수가 더 이상 개선되지 않았습니다.");
      if (iteration === run.configSnapshot.harness.maxIterations) throw new GraphStopError("max_iterations", "최대 개선 반복 횟수에 도달했습니다.");
      candidate = await this.runNode(
        run, `optimizer-${iteration}`,
        `평가 근거를 반영해 작업공간의 결과를 개선하고 검증하세요.\n\n원래 작업:\n${task}\n\n평가 점수: ${review.score}\n평가 근거: ${review.reason}`,
        this.primaryRuntime, this.withSandbox(run.configSnapshot, "workspace-write", false), reviewNode.nodeId,
        execution, append, emitHook, budget,
      );
    }
    return candidate;
  }

  // Runtime 한 번을 node·event·usage·훅 경계에 투영한다.
  private async runNode(
    run: ExperimentRunRecord, role: string, prompt: string, runtime: AgentRuntime, config: ExperimentVariantConfig,
    parentNodeId: string | null, execution: GraphExecution,
    append: (type: string, payload?: Record<string, unknown>) => { sequence: number },
    emitHook: (event: Parameters<ExperimentHookBus["emit"]>[0]["event"], nodeId: string | null, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    budget: RuntimeBudgetPolicy,
  ): Promise<NodeResult> {
    if (execution.cancelled) throw new GraphStopError("cancelled", "사용자가 그래프 실행을 취소했습니다.");
    const node = this.repository.createNode({ runId: run.id, parentNodeId, role, provider: config.runtime.provider, model: config.runtime.model, payload: { prompt: boundedText(prompt) } });
    try {
      const hookPayload = await emitHook("before_node", node.id, { role, prompt });
      const selectedPrompt = typeof hookPayload.prompt === "string" ? hookPayload.prompt : prompt;
      const runtimeRunId = `${run.id}:${node.ordinal}:${role}`;
      execution.runtime = runtime;
      execution.runtimeRunId = runtimeRunId;
      const input = { runId: runtimeRunId, workingDirectory: run.workingDirectory!, prompt: selectedPrompt, config };
      const snapshot = await runtime.prepare(input);
      this.repository.transitionNode({ nodeId: node.id, status: "running" });
      append("node.started", { nodeId: node.id, role, snapshot });
      let completed = false;
      let finalAnswer = "";
      let failure: Extract<RuntimeEvent, { type: "failed" }> | null = null;
      let providerRunId: string | null = null;
      for (let attempt = 0; ; attempt += 1) {
        completed = false;
        failure = null;
        const stream: AsyncIterable<RuntimeEvent> = attempt === 0 || !providerRunId
          ? runtime.run({ ...input, snapshot }, execution.controller.signal)
          : runtime.resume({ ...input, snapshot, prompt: LIMIT_RESUME_PROMPT, providerRunId, checkpoint: {} }, execution.controller.signal);
        for await (const event of stream) {
        append(`runtime.${event.type}`, JSON.parse(JSON.stringify({ nodeId: node.id, ...event })) as Record<string, unknown>);
        if (event.type === "started" && event.providerRunId) providerRunId = event.providerRunId;
        if (event.type === "message" && event.role === "assistant") finalAnswer = event.text;
        else if (event.type === "usage") {
          this.repository.recordNodeUsage(node.id, event.usage);
          const aggregate = this.repository.refreshRunUsageFromNodes(run.id);
          const violation = budget.check({
            inputTokens: aggregate.inputTokens, cachedInputTokens: aggregate.cachedInputTokens,
            cacheCreationInputTokens: aggregate.cacheCreationInputTokens, cacheReadInputTokens: aggregate.cacheReadInputTokens,
            outputTokens: aggregate.outputTokens, reasoningOutputTokens: aggregate.reasoningOutputTokens,
            totalTokens: aggregate.totalTokens, totalTokensSource: aggregate.totalTokensSource, costUsd: aggregate.costUsd,
          } satisfies RuntimeUsageSnapshot);
          if (violation) {
            execution.stopReason ??= violation.reason;
            execution.controller.abort();
            await runtime.cancel(runtimeRunId);
            throw new GraphStopError(violation.reason, `그래프 ${violation.dimension} 예산을 초과했습니다.`);
          }
        } else if (event.type === "completed") completed = true;
        else if (event.type === "failed") failure = event;
        }
        if (execution.stopReason || completed || !failure) break;
        const failureReason = await this.narrowFailureReason(failure.reason ?? "runtime_error", this.repository.getRun(run.id), failure.error);
        // 한도는 실패가 아니라 대기로 처리한다. 이어붙일 세션이 없거나 정책이 없으면 그대로 끝낸다.
        if (failureReason !== "provider_limit" || !this.waitForProviderLimit || attempt >= MAX_LIMIT_WAITS || !providerRunId) {
          failure = { ...failure, reason: failureReason };
          break;
        }
        const waitedFrom = Date.now();
        execution.clock.pause(waitedFrom);
        append("node.waiting", { nodeId: node.id, role, reason: failureReason, attempt });
        const recovered = await this.waitForProviderLimit(
          run.id, config.runtime.provider, config.runtime.accountId, execution.controller.signal,
        ).catch(() => false);
        const waitedUntil = Date.now();
        execution.clock.resume(waitedUntil);
        this.repository.recordWait(run.id, (waitedUntil - waitedFrom) / 1_000);
        if (execution.controller.signal.aborted || !recovered) {
          append("node.wait_abandoned", { nodeId: node.id, role, recovered });
          failure = { ...failure, reason: failureReason };
          break;
        }
        append("node.resumed", { nodeId: node.id, role, waitedSeconds: (waitedUntil - waitedFrom) / 1_000, attempt });
      }
      execution.runtime = null;
      execution.runtimeRunId = null;
      if (execution.stopReason) throw new GraphStopError(execution.stopReason, execution.stopReason === "cancelled" ? "사용자가 그래프 실행을 취소했습니다." : `그래프가 ${execution.stopReason}로 중단됐습니다.`);
      if (failure) throw new GraphStopError(failure.reason ?? "runtime_error", failure.error);
      if (!completed || !finalAnswer.trim()) throw new GraphStopError("runtime_error", `${role} Runtime이 최종 답변과 완료 이벤트를 반환하지 않았습니다.`);
      const answer = boundedText(finalAnswer);
      this.repository.transitionNode({ nodeId: node.id, status: "completed", output: { finalAnswer: answer } });
      this.repository.refreshRunUsageFromNodes(run.id);
      await emitHook("after_node", node.id, { role, finalAnswer: answer });
      append("node.completed", { nodeId: node.id, role });
      return { nodeId: node.id, finalAnswer: answer };
    } catch (error) {
      const current = this.repository.getNode(node.id);
      if (current && ["queued", "running"].includes(current.status)) {
        this.repository.transitionNode({
          nodeId: node.id,
          status: execution.cancelled || execution.stopReason === "cancelled" ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      execution.runtime = null;
      execution.runtimeRunId = null;
    }
  }

  // primary/secondary 역할에 강제 sandbox와 runtime provenance를 적용한 설정 복사본을 만든다.
  private withSandbox(config: ExperimentVariantConfig, sandbox: "read-only" | "workspace-write", secondary: boolean): ExperimentVariantConfig {
    const selected = secondary && config.harness.secondaryRuntime ? config.harness.secondaryRuntime : config.runtime;
    return {
      ...config,
      runtime: {
        provider: selected.provider, accountId: selected.accountId, model: selected.model,
        reasoningEffort: selected.reasoningEffort, sandbox, maxTurns: config.runtime.maxTurns,
      },
    };
  }

  // 훅 오류를 run 종료 이유로 구분한다.
  private hookReason(error: unknown): ExperimentTerminationReason {
    if (error instanceof HookBlockedError || error instanceof HookValidationError) return "policy_blocked";
    if (error instanceof HookExecutionError) return "hook_error";
    return "runtime_error";
  }
}
