import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import type { AgentRuntime, RuntimeEvent, RuntimePrepareInput, RuntimeResumeInput, RuntimeRunInput, RuntimeSnapshot } from "../src/server/experiments/agent-runtime";
import { GraphHarness } from "../src/server/experiments/graph-harness";
import { ExperimentRepository } from "../src/server/services/experiment-repository";
import type { ExperimentHarnessType, ExperimentVariantConfig } from "../src/shared/experiments";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

// 테스트별 완료 전 queued 그래프 run과 독립 DB를 만든다.
function createRun(type: ExperimentHarnessType, harness: Partial<ExperimentVariantConfig["harness"]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-graph-harness-"));
  const database = openDatabase({
    rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
    publicUrl: "", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false,
    slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig);
  cleanups.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('그래프', ?)").run(root).lastInsertRowid);
  const repository = new ExperimentRepository(database);
  const config: ExperimentVariantConfig = {
    schemaVersion: 1,
    runtime: { provider: "codex", accountId: null, model: "primary", reasoningEffort: "high", sandbox: "workspace-write", maxTurns: null },
    skills: { mode: "none", enabled: [], disabled: [], profile: "native", baseline: "clean", additions: [], comparisonId: null, activation: "native" },
    harness: {
      type, maxIterations: 3, minimumScore: 0.8, maxNoImprovement: 1, workerCount: 2,
      secondaryRuntime: { provider: "claude", accountId: null, model: "secondary", reasoningEffort: "high" },
      ...harness,
    },
    hooks: [], budget: { maxSeconds: 60, maxTokens: 10_000, maxCostUsd: null },
  };
  const experiment = repository.createExperiment({ projectId, name: "그래프", command: "기능을 구현해" });
  const variant = repository.createVariant({ experimentId: experiment.id, name: type, config });
  return { repository, run: repository.createRun({ variantId: variant.id, workingDirectory: root }) };
}

// 호출 순서마다 지정한 assistant 답변과 usage·완료 이벤트를 반환한다.
class QueueRuntime implements AgentRuntime {
  calls: RuntimeRunInput[] = [];

  constructor(private readonly provider: "codex" | "claude", private readonly answers: string[]) {}

  // 고정된 테스트 Runtime snapshot을 만든다.
  async prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot> {
    return { provider: this.provider, cliVersion: "test", resolvedModel: input.config.runtime.model, toolProfile: {}, permissionProfile: {}, skillManifest: [], preparedAt: "2026-08-13T00:00:00Z" };
  }

  // 큐의 다음 답변과 호출별 10 token usage를 방출한다.
  async *run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    this.calls.push(input);
    const answer = this.answers.shift();
    if (!answer) throw new Error("준비된 답변이 없습니다.");
    const occurredAt = "2026-08-13T00:00:01Z";
    yield { type: "message", role: "assistant", text: answer, occurredAt };
    yield { type: "usage", usage: { inputTokens: 6, cachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 10, totalTokensSource: "reported", costUsd: null }, occurredAt };
    yield { type: "completed", result: {}, occurredAt };
  }

  // 한도 대기 뒤 재개를 관측한다. onResume을 붙이지 않은 fixture에서는 resume 자체를 오류로 본다.
  onResume?: (input: RuntimeResumeInput) => void;

  async *resume(input: RuntimeResumeInput, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (!this.onResume) throw new Error("resume 미지원");
    this.onResume(input);
    void signal;
    yield* this.run(input as RuntimeRunInput);
  }

  // 동기 fixture 취소는 별도 동작이 필요 없다.
  async cancel(): Promise<void> {}
}

describe("GraphHarness", () => {
  it("orchestrator 계획·두 worker·통합을 부모 관계와 합산 usage로 기록한다", async () => {
    const { repository, run } = createRun("orchestrator_worker");
    const primary = new QueueRuntime("codex", ["1. API 2. 테스트", "통합과 검증 완료"]);
    const secondary = new QueueRuntime("claude", ["API 구현 완료", "테스트 구현 완료"]);

    const result = await new GraphHarness({ repository, primaryRuntime: primary, secondaryRuntime: secondary }).execute(run.id);
    const nodes = repository.listNodes(run.id);

    expect(result).toMatchObject({ status: "completed", terminationReason: "success", totalTokens: 40, totalTokensSource: "reported", costUsd: null });
    expect(nodes.map((node) => node.role)).toEqual(["orchestrator", "worker-1", "worker-2", "synthesizer"]);
    expect(nodes[1]?.parentNodeId).toBe(nodes[0]?.id);
    expect(nodes[3]?.parentNodeId).toBe(nodes[2]?.id);
    expect(repository.getCheckpoint(run.id)?.state).toMatchObject({ harness: "orchestrator_worker", status: "completed" });
  });

  it("낮은 평가 뒤 optimizer를 호출하고 최소 점수에 도달하면 완료한다", async () => {
    const { repository, run } = createRun("evaluator_optimizer");
    const primary = new QueueRuntime("codex", ["초안 완료", "평가 반영 개선 완료"]);
    const secondary = new QueueRuntime("claude", [
      '{"score":0.5,"reason":"테스트 부족"}',
      '{"score":0.9,"reason":"요건 충족"}',
    ]);

    const result = await new GraphHarness({ repository, primaryRuntime: primary, secondaryRuntime: secondary }).execute(run.id);

    expect(result).toMatchObject({ status: "completed", totalTokens: 40 });
    expect(repository.listNodes(run.id).map((node) => node.role)).toEqual(["draft", "evaluator-1", "optimizer-1", "evaluator-2"]);
    expect(repository.listEvents(run.id).filter((event) => event.type === "loop.evaluated").map((event) => event.payload.score)).toEqual([0.5, 0.9]);
  });

  it("Runtime 예외가 난 현재 node를 failed로 종결한다", async () => {
    const { repository, run } = createRun("orchestrator_worker");
    const primary = new QueueRuntime("codex", ["작업 계획"]);
    const secondary = new QueueRuntime("claude", ["첫 작업 완료"]);

    const result = await new GraphHarness({ repository, primaryRuntime: primary, secondaryRuntime: secondary }).execute(run.id);
    const nodes = repository.listNodes(run.id);

    expect(result).toMatchObject({ status: "failed", terminationReason: "runtime_error" });
    expect(nodes.map((node) => node.status)).toEqual(["completed", "completed", "failed"]);
    expect(nodes.at(-1)?.error).toContain("준비된 답변이 없습니다");
  });
});

describe("GraphHarness 한도 대기", () => {
  it("node가 한도로 실패하면 기다렸다 같은 세션으로 재개한다", async () => {
    const { repository, run } = createRun("orchestrator_worker", { workerCount: 1 });
    const resumed: RuntimeResumeInput[] = [];
    let attempt = 0;
    // 첫 호출만 한도로 실패시키고, 재개하면 정상 답변을 낸다.
    class LimitedRuntime extends QueueRuntime {
      async *run(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
        attempt += 1;
        if (attempt === 1) {
          yield { type: "started", providerRunId: "thread-graph", occurredAt: "2026-08-13T00:00:00Z" };
          yield { type: "failed", error: "종료 코드 1", occurredAt: "2026-08-13T00:00:01Z" };
          return;
        }
        yield* super.run(input);
      }
    }
    const primary = new LimitedRuntime("codex", ["계획", "통합"]);
    primary.onResume = (input) => resumed.push(input);
    const secondary = new QueueRuntime("claude", ["worker 결과"]);

    const result = await new GraphHarness({
      repository, primaryRuntime: primary, secondaryRuntime: secondary,
      isProviderLimited: async () => true,
      waitForProviderLimit: async () => true,
    }).execute(run.id);

    expect(result.status).toBe("completed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ providerRunId: "thread-graph", prompt: "계속" });
    expect(result.waitCount).toBe(1);
    const types = repository.listEvents(run.id, 0, 300).map((event) => event.type);
    expect(types).toContain("node.waiting");
    expect(types).toContain("node.resumed");
  });

  it("회복되지 않으면 provider_limit으로 끝낸다", async () => {
    const { repository, run } = createRun("orchestrator_worker", { workerCount: 1 });
    class AlwaysLimited extends QueueRuntime {
      async *run(): AsyncIterable<RuntimeEvent> {
        yield { type: "started", providerRunId: "thread-x", occurredAt: "2026-08-13T00:00:00Z" };
        yield { type: "failed", error: "종료 코드 1", occurredAt: "2026-08-13T00:00:01Z" };
      }
    }
    const result = await new GraphHarness({
      repository, primaryRuntime: new AlwaysLimited("codex", []), secondaryRuntime: new QueueRuntime("claude", []),
      isProviderLimited: async () => true,
      waitForProviderLimit: async () => false,
    }).execute(run.id);

    expect(result).toMatchObject({ status: "failed", terminationReason: "provider_limit", waitCount: 1 });
  });
});
