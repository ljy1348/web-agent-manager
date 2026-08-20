import { describe, expect, it } from "vitest";
import { ActiveClock, RuntimeBudgetPolicy, type RuntimeUsageSnapshot } from "../src/server/experiments/agent-runtime";
import {
  ExperimentHookBus,
  HookBlockedError,
  HookExecutionError,
  HookValidationError,
} from "../src/server/experiments/hook-bus";

// 예산 테스트에서 토큰·비용 관측값을 간결하게 만든다.
function usage(totalTokens: number | null, costUsd: number | null): RuntimeUsageSnapshot {
  return {
    inputTokens: totalTokens, cachedInputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null,
    outputTokens: null, reasoningOutputTokens: null, totalTokens, totalTokensSource: totalTokens === null ? null : "reported", costUsd,
  };
}

describe("실험 런타임 하드 예산", () => {
  it("시간·토큰·비용 한도를 구조화 종료 이유로 판정한다", () => {
    const policy = new RuntimeBudgetPolicy({ maxSeconds: 60, maxTokens: 1_000, maxCostUsd: 2 }, 1_000);
    expect(policy.check(usage(999, 1.9), 60_000)).toBeNull();
    expect(policy.check(usage(1_000, 1.9), 60_000)).toMatchObject({ dimension: "tokens", reason: "token_budget", observed: 1_000 });
    expect(policy.check(usage(999, 2), 60_000)).toMatchObject({ dimension: "cost", reason: "cost_budget", observed: 2 });
    expect(policy.check(usage(999, 1.9), 61_000)).toMatchObject({ dimension: "time", reason: "time_budget", observed: 60 });
  });

  it("공급자가 보고하지 않은 토큰·비용을 0이나 초과로 추정하지 않는다", () => {
    const policy = new RuntimeBudgetPolicy({ maxSeconds: 60, maxTokens: 1, maxCostUsd: 0 }, 1_000);
    expect(policy.observe(null, 2_000)).toEqual({ elapsedSeconds: 1, totalTokens: null, costUsd: null });
    expect(policy.check(usage(null, null), 2_000)).toBeNull();
  });

  it("한도 대기 구간은 시간 예산에서 제외해 대기 중 time_budget으로 끝나지 않는다", () => {
    const clock = new ActiveClock(0);
    const policy = new RuntimeBudgetPolicy({ maxSeconds: 60, maxTokens: null, maxCostUsd: null }, clock);

    // 10초 작업한 뒤 한도로 1시간 대기하고 재개한다.
    clock.pause(10_000);
    expect(policy.check(usage(null, null), 1_810_000)).toBeNull();
    expect(policy.observe(null, 1_810_000).elapsedSeconds).toBe(10);
    clock.resume(3_610_000);

    // 재개 직후에도 실작업 시간은 10초뿐이라 남은 예산이 그대로다.
    expect(policy.observe(null, 3_610_000).elapsedSeconds).toBe(10);
    expect(policy.remainingActiveMs(3_610_000)).toBe(50_000);
    expect(policy.check(usage(null, null), 3_610_000)).toBeNull();

    // 대기를 뺀 실작업 시간이 상한에 닿을 때만 종료된다.
    expect(policy.check(usage(null, null), 3_660_000)).toMatchObject({ reason: "time_budget", observed: 60 });
  });
});

describe("실작업 시계", () => {
  it("대기 시간을 누적하고 실작업 시간에서 뺀다", () => {
    const clock = new ActiveClock(0);

    clock.pause(5_000);
    clock.pause(6_000); // 이미 멈춘 상태의 재호출은 대기를 이중 계산하지 않는다.
    expect(clock.waitedSeconds(9_000)).toBe(4);
    expect(clock.activeSeconds(9_000)).toBe(5);

    clock.resume(15_000);
    expect(clock.waitedSeconds(15_000)).toBe(10);
    expect(clock.activeSeconds(20_000)).toBe(10);

    clock.resume(30_000); // 멈춘 적 없는 재개는 아무 효과가 없다.
    expect(clock.waitedSeconds(30_000)).toBe(10);
  });
});

describe("실험 HookBus", () => {
  it("observe 훅에는 재귀 동결된 복사본을 주고 원본 payload를 유지한다", async () => {
    const bus = new ExperimentHookBus();
    bus.register({
      id: "observer", event: "before_run", mode: "observe",
      handler: (context) => {
        expect(Object.isFrozen(context.payload)).toBe(true);
        expect(Object.isFrozen(context.payload.nested)).toBe(true);
        expect(() => { (context.payload.nested as { count: number }).count = 99; }).toThrow(TypeError);
        return { payload: { replaced: true } };
      },
    });
    const result = await bus.emit({ event: "before_run", runId: "run-1", payload: { nested: { count: 1 } } });
    expect(result.payload).toEqual({ nested: { count: 1 } });
    expect(result.executions).toMatchObject([{ hookId: "observer", status: "completed" }]);
  });

  it("transform 훅만 등록 순서대로 payload를 바꾼다", async () => {
    const bus = new ExperimentHookBus();
    bus.register({
      id: "first", event: "before_node", mode: "transform",
      handler: (context) => ({ payload: { ...context.payload, count: 1 } }),
    });
    bus.register({
      id: "second", event: "before_node", mode: "transform",
      handler: (context) => ({ payload: { ...context.payload, count: Number(context.payload.count) + 1 } }),
    });
    expect((await bus.emit({ event: "before_node", runId: "run-1" })).payload).toEqual({ count: 2 });
  });

  it("validate와 block의 정책 거부를 일반 훅 오류와 구분한다", async () => {
    const validation = new ExperimentHookBus();
    validation.register({
      id: "validator", event: "before_tool", mode: "validate",
      handler: () => ({ valid: false, reason: "허용되지 않은 명령" }),
    });
    await expect(validation.emit({ event: "before_tool", runId: "run-1" }))
      .rejects.toEqual(expect.objectContaining<Partial<HookValidationError>>({ name: "HookValidationError", hookId: "validator", message: "허용되지 않은 명령" }));

    const blocking = new ExperimentHookBus();
    blocking.register({
      id: "blocker", event: "before_run", mode: "block",
      handler: () => ({ blocked: true, reason: "외부 쓰기 차단" }),
    });
    await expect(blocking.emit({ event: "before_run", runId: "run-1" }))
      .rejects.toBeInstanceOf(HookBlockedError);
  });

  it("timeout 오류를 fail_run·warn·ignore 정책별로 처리한다", async () => {
    const failBus = new ExperimentHookBus();
    failBus.register({
      id: "fail", event: "after_run", mode: "observe", timeoutMs: 1, failurePolicy: "fail_run",
      handler: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });
    await expect(failBus.emit({ event: "after_run", runId: "run-1" })).rejects.toBeInstanceOf(HookExecutionError);

    const tolerantBus = new ExperimentHookBus();
    tolerantBus.register({
      id: "warn", event: "after_run", mode: "observe", timeoutMs: 1, failurePolicy: "warn",
      handler: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });
    tolerantBus.register({
      id: "ignore", event: "after_run", mode: "observe", timeoutMs: 1, failurePolicy: "ignore",
      handler: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });
    const result = await tolerantBus.emit({ event: "after_run", runId: "run-1" });
    expect(result.warnings).toHaveLength(1);
    expect(result.executions.map((entry) => entry.status)).toEqual(["warned", "ignored"]);
  });

  it("중복 ID와 과도한 timeout을 등록 단계에서 거부한다", () => {
    const bus = new ExperimentHookBus();
    bus.register({ id: "same", event: "before_run", mode: "observe", handler: () => undefined });
    expect(() => bus.register({ id: "same", event: "after_run", mode: "observe", handler: () => undefined })).toThrow("이미 등록된");
    expect(() => new ExperimentHookBus().register({
      id: "slow", event: "after_run", mode: "observe", timeoutMs: 60_001, handler: () => undefined,
    })).toThrow("1~60000ms");
  });
});
