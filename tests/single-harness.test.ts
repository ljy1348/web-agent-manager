import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimePrepareInput,
  RuntimeResumeInput,
  RuntimeRunInput,
  RuntimeSnapshot,
} from "../src/server/experiments/agent-runtime";
import { ExperimentHookBus } from "../src/server/experiments/hook-bus";
import { SingleHarness } from "../src/server/experiments/single-harness";
import { ExperimentRepository } from "../src/server/services/experiment-repository";
import type { ExperimentVariantConfig } from "../src/shared/experiments";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 테스트마다 독립된 SQLite 실험과 single run을 만든다.
function createRun(overrides: Partial<ExperimentVariantConfig> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-single-harness-"));
  const database = openDatabase({
    rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig);
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('실험', ?)").run(root).lastInsertRowid);
  const repository = new ExperimentRepository(database);
  const config: ExperimentVariantConfig = {
    schemaVersion: 1,
    runtime: { provider: "codex", accountId: null, model: "gpt-test", reasoningEffort: "high", sandbox: "workspace-write", maxTurns: null },
    skills: { mode: "all", enabled: [], disabled: [], profile: "native", baseline: "installed", additions: [], comparisonId: null, activation: "native" },
    harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 1, workerCount: 2, secondaryRuntime: null },
    hooks: [], budget: { maxSeconds: 60, maxTokens: 1_000, maxCostUsd: 5 },
    ...overrides,
  };
  const experiment = repository.createExperiment({ projectId, name: "single", command: "원래 명령" });
  const variant = repository.createVariant({ experimentId: experiment.id, name: "기본", config });
  const run = repository.createRun({ variantId: variant.id, workingDirectory: root });
  return { database, repository, run };
}

// 지정 이벤트를 순서대로 내보내며 전달된 prompt와 취소 호출을 관측한다.
class FakeRuntime implements AgentRuntime {
  inputs: RuntimeRunInput[] = [];
  cancelCalls = 0;
  onResume?: (input: RuntimeResumeInput) => void;

  constructor(private readonly events: (signal: AbortSignal) => AsyncIterable<RuntimeEvent>) {}

  // 고정된 가짜 CLI provenance를 반환한다.
  async prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot> {
    return {
      provider: input.config.runtime.provider, cliVersion: "fake-1", resolvedModel: input.config.runtime.model,
      toolProfile: { transport: "fake" }, permissionProfile: { sandbox: input.config.runtime.sandbox },
      skillManifest: [], preparedAt: "2026-08-13T00:00:00.000Z",
    };
  }

  // 테스트가 제공한 이벤트 generator를 실행한다.
  async *run(input: RuntimeRunInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    this.inputs.push(input);
    yield* this.events(signal);
  }

  // 한도 대기 뒤 재개를 관측한다. onResume을 붙이지 않은 테스트에서는 resume 자체를 오류로 본다.
  async *resume(input: RuntimeResumeInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (!this.onResume) throw new Error("resume 미지원");
    this.onResume(input);
    yield* this.events(signal);
  }

  // 취소 호출 횟수를 기록한다.
  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
}

// 고정 시각의 Runtime 이벤트를 간결하게 만든다.
function at<T extends Omit<RuntimeEvent, "occurredAt">>(event: T): T & { occurredAt: string } {
  return { ...event, occurredAt: "2026-08-13T00:00:01.000Z" };
}

describe("SingleHarness", () => {
  it("prompt 변환부터 node·usage·cost·checkpoint 완료까지 원장에 연결한다", async () => {
    const { repository, run } = createRun();
    const runtime = new FakeRuntime(async function* () {
      yield at({ type: "started", providerRunId: "thread-1" });
      yield at({ type: "tool_started", name: "test", payload: {}, toolCallId: "tool-1" });
      yield at({ type: "usage", usage: {
        inputTokens: 100, cachedInputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 15,
        outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 130, totalTokensSource: "reported", costUsd: 0.4,
      } });
      yield at({ type: "completed", result: { answer: "완료" } });
    });
    const hooks = new ExperimentHookBus();
    hooks.register({ id: "prompt", event: "before_run", mode: "transform", handler: () => ({ payload: { prompt: "변환된 명령" } }) });
    const harness = new SingleHarness({ repository, runtimes: { codex: runtime }, hookBus: hooks });

    const completed = await harness.execute(run.id);

    expect(completed).toMatchObject({
      status: "completed", terminationReason: "success", providerRunId: "thread-1",
      inputTokens: 100, cacheCreationInputTokens: 5, cacheReadInputTokens: 15,
      totalTokens: 130, totalTokensSource: "reported", costUsd: 0.4,
    });
    expect(runtime.inputs[0]?.prompt).toBe("변환된 명령");
    expect(completed.environmentSnapshot.runtime).toMatchObject({ cliVersion: "fake-1", toolProfile: { transport: "fake" } });
    const checkpoint = repository.getCheckpoint(run.id)!;
    expect(checkpoint.state).toMatchObject({ harness: "single", status: "completed", result: { answer: "완료" } });
    expect(repository.getNode(checkpoint.nodeId!)!).toMatchObject({
      status: "completed", output: { answer: "완료" }, totalTokens: 130, costUsd: 0.4,
    });
    expect(repository.listEvents(run.id).map((event) => event.type)).toEqual(expect.arrayContaining([
      "runtime.prepared", "node.created", "runtime.started", "runtime.tool_started", "runtime.usage", "node.completed", "run.completed",
    ]));
  });

  it("token budget을 우선 종료 이유로 보존하고 Runtime을 취소한다", async () => {
    const { repository, run } = createRun({ budget: { maxSeconds: 60, maxTokens: 100, maxCostUsd: null } });
    const runtime = new FakeRuntime(async function* (signal) {
      yield at({ type: "usage", usage: {
        inputTokens: 100, cachedInputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null,
        outputTokens: 0, reasoningOutputTokens: null, totalTokens: 100, totalTokensSource: "reported", costUsd: null,
      } });
      if (signal.aborted) yield at({ type: "failed", error: "취소됨", reason: "cancelled" });
    });
    const result = await new SingleHarness({ repository, runtimes: { codex: runtime } }).execute(run.id);
    expect(result).toMatchObject({ status: "budget_exceeded", terminationReason: "token_budget" });
    expect(runtime.cancelCalls).toBeGreaterThan(0);
  });

  it("사용자 취소를 node와 run에 반영하고 중복 실행을 거부한다", async () => {
    const { repository, run } = createRun();
    const runtime = new FakeRuntime(async function* (signal) {
      yield at({ type: "started", providerRunId: "thread-cancel" });
      while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      yield at({ type: "failed", error: "사용자 취소", reason: "cancelled" });
    });
    const harness = new SingleHarness({ repository, runtimes: { codex: runtime } });
    const pending = harness.execute(run.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(harness.execute(run.id)).rejects.toThrow("이미 실행 중");
    expect(await harness.cancel(run.id)).toBe(true);
    expect(await pending).toMatchObject({ status: "cancelled", terminationReason: "cancelled" });
  });

  it("before_run 정책 차단과 공급자 max turn 실패를 구분한다", async () => {
    const blockedRun = createRun();
    const blockedHooks = new ExperimentHookBus();
    blockedHooks.register({ id: "policy", event: "before_run", mode: "block", handler: () => ({ blocked: true, reason: "금지" }) });
    const unused = new FakeRuntime(async function* () { yield at({ type: "completed", result: {} }); });
    expect(await new SingleHarness({ repository: blockedRun.repository, runtimes: { codex: unused }, hookBus: blockedHooks }).execute(blockedRun.run.id))
      .toMatchObject({ status: "failed", terminationReason: "policy_blocked", error: "금지" });

    const maxTurnRun = createRun();
    const maxTurn = new FakeRuntime(async function* () {
      yield at({ type: "failed", error: "turn 한도", reason: "max_turns" });
    });
    expect(await new SingleHarness({ repository: maxTurnRun.repository, runtimes: { codex: maxTurn } }).execute(maxTurnRun.run.id))
      .toMatchObject({ status: "failed", terminationReason: "max_turns", error: "turn 한도" });
  });

  it("계정이 실제로 한도에 걸렸을 때만 실행 오류를 provider_limit으로 좁힌다", async () => {
    const limited = createRun();
    const failing = new FakeRuntime(async function* () {
      yield at({ type: "failed", error: "CLI가 종료 코드 1로 끝났습니다." });
    });
    expect(await new SingleHarness({
      repository: limited.repository, runtimes: { codex: failing },
      isProviderLimited: async () => true,
    }).execute(limited.run.id)).toMatchObject({ status: "failed", terminationReason: "provider_limit" });

    // 한도가 아니면 원래 이유를 유지한다.
    const healthy = createRun();
    const failingAgain = new FakeRuntime(async function* () {
      yield at({ type: "failed", error: "CLI가 종료 코드 1로 끝났습니다." });
    });
    expect(await new SingleHarness({
      repository: healthy.repository, runtimes: { codex: failingAgain },
      isProviderLimited: async () => false,
    }).execute(healthy.run.id)).toMatchObject({ status: "failed", terminationReason: "runtime_error" });

    // 한도 조회가 실패해도 run 종결을 막지 않는다.
    const unknown = createRun();
    const failingThird = new FakeRuntime(async function* () {
      yield at({ type: "failed", error: "CLI가 종료 코드 1로 끝났습니다." });
    });
    expect(await new SingleHarness({
      repository: unknown.repository, runtimes: { codex: failingThird },
      isProviderLimited: async () => { throw new Error("usage_status 조회 실패"); },
    }).execute(unknown.run.id)).toMatchObject({ status: "failed", terminationReason: "runtime_error" });
  });

  it("한도 실패를 대기 후 같은 세션으로 재개하고 대기 시간을 실작업 시간에서 뺀다", async () => {
    const target = createRun();
    let attempt = 0;
    const resumed: RuntimeResumeInput[] = [];
    const flaky = new FakeRuntime(async function* () {
      attempt += 1;
      yield at({ type: "started", providerRunId: "thread-limit" });
      if (attempt === 1) {
        yield at({ type: "failed", error: "CLI가 종료 코드 1로 끝났습니다." });
        return;
      }
      yield at({ type: "message", role: "assistant", text: "이어서 완료" });
      yield at({ type: "completed", result: { ok: true } });
    });
    flaky.onResume = (input) => resumed.push(input);

    const result = await new SingleHarness({
      repository: target.repository, runtimes: { codex: flaky },
      isProviderLimited: async () => true,
      waitForProviderLimit: async () => true,
    }).execute(target.run.id);

    expect(result).toMatchObject({ status: "completed", terminationReason: "success" });
    // 두 번째 시도는 새 실행이 아니라 저장된 공급자 세션 재개여야 한다.
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ providerRunId: "thread-limit", prompt: "계속" });
    expect(result.waitCount).toBe(1);
    expect(result.waitedSeconds).toBeGreaterThanOrEqual(0);
    // 대기·재개 사실이 원장에 남아 비교 시 토큰 오염을 판단할 수 있어야 한다.
    const types = target.repository.listEvents(target.run.id, 0, 200).map((event) => event.type);
    expect(types).toContain("run.waiting");
    expect(types).toContain("run.resumed");
  });

  it("대기 정책이 없거나 회복되지 않으면 provider_limit으로 끝낸다", async () => {
    const noPolicy = createRun();
    const failing = new FakeRuntime(async function* () {
      yield at({ type: "started", providerRunId: "thread-a" });
      yield at({ type: "failed", error: "종료 코드 1" });
    });
    expect(await new SingleHarness({
      repository: noPolicy.repository, runtimes: { codex: failing },
      isProviderLimited: async () => true,
    }).execute(noPolicy.run.id)).toMatchObject({ status: "failed", terminationReason: "provider_limit", waitCount: 0 });

    const notRecovered = createRun();
    const failingAgain = new FakeRuntime(async function* () {
      yield at({ type: "started", providerRunId: "thread-b" });
      yield at({ type: "failed", error: "종료 코드 1" });
    });
    const result = await new SingleHarness({
      repository: notRecovered.repository, runtimes: { codex: failingAgain },
      isProviderLimited: async () => true,
      waitForProviderLimit: async () => false,
    }).execute(notRecovered.run.id);
    expect(result).toMatchObject({ status: "failed", terminationReason: "provider_limit", waitCount: 1 });
  });

  it("정책 차단·취소는 한도 조회 없이 원래 이유를 유지한다", async () => {
    const cancelledRun = createRun();
    let limitChecks = 0;
    const slow = new FakeRuntime(async function* (signal) {
      yield at({ type: "started", providerRunId: "thread-x" });
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    });
    const harness = new SingleHarness({
      repository: cancelledRun.repository, runtimes: { codex: slow },
      isProviderLimited: async () => { limitChecks += 1; return true; },
    });
    const pending = harness.execute(cancelledRun.run.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.cancel(cancelledRun.run.id);
    expect(await pending).toMatchObject({ terminationReason: "cancelled" });
    expect(limitChecks).toBe(0);
  });
});

describe("명시 호출 활성화", () => {
  it("처리군 프롬프트 앞에만 슬래시 명령을 붙인다", async () => {
    const target = createRun();
    const runtime = new FakeRuntime(async function* () {
      yield at({ type: "message", role: "assistant", text: "완료" });
      yield at({ type: "completed", result: {} });
    });
    await new SingleHarness({
      repository: target.repository, runtimes: { codex: runtime }, promptPrefix: "/caveman",
    }).execute(target.run.id);
    expect(runtime.inputs[0]?.prompt).toBe("/caveman\n\n원래 명령");

    // 접두가 없으면 공유 과제 문구가 그대로 간다.
    const control = createRun();
    const plain = new FakeRuntime(async function* () {
      yield at({ type: "message", role: "assistant", text: "완료" });
      yield at({ type: "completed", result: {} });
    });
    await new SingleHarness({ repository: control.repository, runtimes: { codex: plain } }).execute(control.run.id);
    expect(plain.inputs[0]?.prompt).toBe("원래 명령");
  });
});
