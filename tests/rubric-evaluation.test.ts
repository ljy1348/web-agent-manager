import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import type { AgentRuntime, RuntimeEvent, RuntimePrepareInput, RuntimeResumeInput, RuntimeRunInput, RuntimeSnapshot } from "../src/server/experiments/agent-runtime";
import { buildBlindSubjectPacket, type BlindSubjectPacket } from "../src/server/experiments/blind-subject-packet";
import { RubricEvaluationRunner } from "../src/server/experiments/rubric-evaluation";
import { ExperimentRepository } from "../src/server/services/experiment-repository";
import { buildEvaluatorVariantConfig } from "../src/server/services/experiment-service";
import type { ExperimentEvaluatorConfig, ExperimentVariantConfig } from "../src/shared/experiments";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// 독립 DB에 완료된 run과 rubric 평가를 만든다.
function createEvaluation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-rubric-evaluation-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "result.txt"), "before\n");
  const database = openDatabase({
    rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
    publicUrl: "", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false,
    slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig);
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('평가', ?)").run(root).lastInsertRowid);
  const repository = new ExperimentRepository(database);
  const experiment = repository.createExperiment({ projectId, name: "평가", command: "기능 구현", rubric: { correctness: 1 } });
  const config: ExperimentVariantConfig = {
    schemaVersion: 1,
    runtime: { provider: "claude", accountId: null, model: "subject-model", reasoningEffort: null, sandbox: "workspace-write", maxTurns: null },
    skills: { mode: "none", enabled: [], disabled: [], profile: "native", baseline: "clean", additions: [], comparisonId: null, activation: "native" },
    harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 0, workerCount: 2, secondaryRuntime: null },
    hooks: [], budget: { maxSeconds: 60, maxTokens: null, maxCostUsd: null },
  };
  const variant = repository.createVariant({ experimentId: experiment.id, name: "subject", config });
  const run = repository.createRun({ variantId: variant.id, workingDirectory: root });
  repository.transitionRun({ runId: run.id, status: "preparing" });
  repository.transitionRun({ runId: run.id, status: "running" });
  repository.transitionRun({ runId: run.id, status: "completed" });
  const evaluation = repository.createEvaluation({
    experimentId: experiment.id, method: "rubric", rubric: { correctness: 1 },
    subjects: [{ runId: run.id, blindLabel: "후보-A", presentationOrder: 1 }],
  });
  return { database, repository, evaluation, run, root };
}

// 지정한 이벤트만 내보내는 evaluator Runtime fixture다.
class FakeEvaluatorRuntime implements AgentRuntime {
  constructor(private readonly provider: "codex" | "claude", private readonly events: RuntimeEvent[]) {}

  // 테스트용 고정 CLI provenance를 반환한다.
  async prepare(input: RuntimePrepareInput): Promise<RuntimeSnapshot> {
    return {
      provider: this.provider, cliVersion: `${this.provider}-test`, resolvedModel: input.config.runtime.model,
      toolProfile: {}, permissionProfile: { sandbox: input.config.runtime.sandbox }, skillManifest: [],
      preparedAt: "2026-08-13T00:00:00.000Z",
    };
  }

  // 생성자에서 받은 이벤트를 순서대로 방출한다.
  async *run(_input: RuntimeRunInput, _signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    for (const event of this.events) yield event;
  }

  // rubric fixture에서는 resume을 사용하지 않는다.
  async *resume(_input: RuntimeResumeInput, _signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    throw new Error("resume 미지원");
  }

  // 동기 fixture에는 별도 취소 동작이 필요 없다.
  async cancel(): Promise<void> {}
}

// evaluator 공통 설정과 읽기 전용 Runtime 설정을 만든다.
function evaluatorConfig(label: string, provider: "codex" | "claude") {
  const config: ExperimentEvaluatorConfig = {
    label, provider, accountId: null, model: `${provider}-judge`, reasoningEffort: null, family: provider,
  };
  const runtimeConfig: ExperimentVariantConfig = {
    schemaVersion: 1,
    runtime: { provider, accountId: null, model: config.model, reasoningEffort: null, sandbox: "read-only", maxTurns: 3 },
    skills: { mode: "none", enabled: [], disabled: [], profile: "native", baseline: "clean", additions: [], comparisonId: null, activation: "native" },
    harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 0, workerCount: 2, secondaryRuntime: null },
    hooks: [], budget: { maxSeconds: 300, maxTokens: 100_000, maxCostUsd: 2 },
  };
  return { config, runtimeConfig };
}

// 테스트 evaluator가 공통으로 사용할 최소 블라인드 패킷을 만든다.
function candidate(): BlindSubjectPacket {
  return {
    blindLabel: "후보-A", taskCommand: "기능 구현", finalAnswer: "완료", trackedDiff: null,
    diffCoverage: "tracked-and-untracked", leakageRedactions: 0, truncations: [],
  };
}

describe("RubricEvaluationRunner", () => {
  it("Claude evaluator는 미지원 maxTurns를 비우고 Codex evaluator만 3으로 제한한다", () => {
    const claude = evaluatorConfig("Claude judge", "claude").config;
    const codex = evaluatorConfig("Codex judge", "codex").config;

    expect(buildEvaluatorVariantConfig(claude, 2).runtime.maxTurns).toBeNull();
    expect(buildEvaluatorVariantConfig(codex, 1).runtime.maxTurns).toBe(3);
  });

  it("Codex·Claude judgment와 호출별 usage·동일 계열 provenance를 독립 저장한다", async () => {
    const { database, repository, evaluation, run, root } = createEvaluation();
    const codex = evaluatorConfig("Codex judge", "codex");
    const claude = evaluatorConfig("Claude judge", "claude");
    const codexCall = repository.createEvaluationCall({
      evaluationId: evaluation.id, idempotencyKey: "codex", evaluatorLabel: codex.config.label,
      evaluatorProvider: "codex", evaluatorModel: codex.config.model, evaluatorFamily: codex.config.family,
    });
    const claudeCall = repository.createEvaluationCall({
      evaluationId: evaluation.id, idempotencyKey: "claude", evaluatorLabel: claude.config.label,
      evaluatorProvider: "claude", evaluatorModel: claude.config.model, evaluatorFamily: claude.config.family,
    });
    const now = "2026-08-13T00:00:01.000Z";
    const success = (score: number): RuntimeEvent[] => [
      { type: "message", role: "assistant", text: JSON.stringify({ score, confidence: 0.8, verdict: "pass", reason: "충족", criteria: { correctness: score } }), occurredAt: now },
      { type: "usage", usage: { inputTokens: 10, cachedInputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: 5, reasoningOutputTokens: null, totalTokens: 15, totalTokensSource: "reported", costUsd: 0.01 }, occurredAt: now },
      { type: "completed", result: {}, occurredAt: now },
    ];
    const result = await new RubricEvaluationRunner(repository).execute({
      evaluationId: evaluation.id, runId: run.id, workingDirectory: root, task: "기능 구현", candidate: candidate(),
      subjectProvider: "claude", subjectModel: "subject-model", subjectFamily: "claude",
      evaluators: [
        { callId: codexCall.id, ...codex, runtime: new FakeEvaluatorRuntime("codex", success(0.8)) },
        { callId: claudeCall.id, ...claude, runtime: new FakeEvaluatorRuntime("claude", success(0.9)) },
      ],
    });

    expect(result.status).toBe("completed");
    expect(repository.listEvaluationCalls(evaluation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ evaluatorLabel: "Codex judge", status: "completed", totalTokens: 15, costUsd: 0.01 }),
      expect.objectContaining({ evaluatorLabel: "Claude judge", status: "completed", totalTokens: 15, costUsd: 0.01 }),
    ]));
    expect(repository.listJudgments(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ evaluatorLabel: "Codex judge", sameFamily: false, score: 0.8 }),
      expect.objectContaining({ evaluatorLabel: "Claude judge", sameFamily: true, score: 0.9 }),
    ]));
    database.close();
  });

  it("한 evaluator의 비JSON 응답만 실패시키고 성공 judgment를 partial로 보존한다", async () => {
    const { database, repository, evaluation, run, root } = createEvaluation();
    const codex = evaluatorConfig("정상", "codex");
    const claude = evaluatorConfig("실패", "claude");
    const calls = [codex, claude].map((entry) => repository.createEvaluationCall({
      evaluationId: evaluation.id, idempotencyKey: entry.config.label, evaluatorLabel: entry.config.label,
      evaluatorProvider: entry.config.provider, evaluatorModel: entry.config.model, evaluatorFamily: entry.config.family,
    }));
    const now = "2026-08-13T00:00:01.000Z";
    const result = await new RubricEvaluationRunner(repository).execute({
      evaluationId: evaluation.id, runId: run.id, workingDirectory: root, task: "기능 구현", candidate: candidate(),
      subjectProvider: "claude", subjectModel: null, subjectFamily: "claude",
      evaluators: [
        { callId: calls[0]!.id, ...codex, runtime: new FakeEvaluatorRuntime("codex", [
          { type: "message", role: "assistant", text: '{"score":0.7,"confidence":0.7,"verdict":"pass","reason":"좋음","criteria":{"correctness":0.7}}', occurredAt: now },
          { type: "completed", result: {}, occurredAt: now },
        ]) },
        { callId: calls[1]!.id, ...claude, runtime: new FakeEvaluatorRuntime("claude", [
          { type: "message", role: "assistant", text: "JSON 아님", occurredAt: now },
          { type: "completed", result: {}, occurredAt: now },
        ]) },
      ],
    });

    expect(result).toMatchObject({ status: "partial" });
    expect(result.error).toContain("JSON 객체만");
    expect(repository.listJudgments(run.id)).toHaveLength(1);
    expect(repository.listEvaluationCalls(evaluation.id).map((call) => call.status).sort()).toEqual(["completed", "failed"]);
    database.close();
  });

  it("evaluator usage가 WAM 토큰 예산에 닿으면 호출과 평가를 실패로 종결한다", async () => {
    const { database, repository, evaluation, run, root } = createEvaluation();
    const codex = evaluatorConfig("예산 심사", "codex");
    codex.runtimeConfig.budget.maxTokens = 10;
    const call = repository.createEvaluationCall({
      evaluationId: evaluation.id, idempotencyKey: "budget", evaluatorLabel: codex.config.label,
      evaluatorProvider: "codex", evaluatorModel: codex.config.model, evaluatorFamily: codex.config.family,
    });
    const now = "2026-08-13T00:00:01.000Z";
    const result = await new RubricEvaluationRunner(repository).execute({
      evaluationId: evaluation.id, runId: run.id, workingDirectory: root, task: "기능 구현", candidate: candidate(),
      subjectProvider: "claude", subjectModel: null, subjectFamily: "claude",
      evaluators: [{ callId: call.id, ...codex, runtime: new FakeEvaluatorRuntime("codex", [
        { type: "usage", usage: { inputTokens: 10, cachedInputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: 0, reasoningOutputTokens: null, totalTokens: 10, totalTokensSource: "reported", costUsd: null }, occurredAt: now },
        { type: "completed", result: {}, occurredAt: now },
      ]) }],
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(result.error).toContain("tokens 예산");
    expect(repository.getEvaluationCall(call.id)).toMatchObject({ status: "failed", totalTokens: 10 });
    database.close();
  });
});

describe("블라인드 피험 패킷", () => {
  it("최종 답변과 tracked·untracked diff의 공급자·세션 지문을 마스킹한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-blind-packet-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "result.txt"), "before\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "result.txt"], { cwd: root });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "base", "--quiet"], { cwd: root });
    fs.writeFileSync(path.join(root, "result.txt"), "Generated by Claude opus session_id=abc\n");
    fs.writeFileSync(path.join(root, "new-test.txt"), "Codex session_id=new\nline 2\n");

    const packet = await buildBlindSubjectPacket({
      blindLabel: "후보-A", taskCommand: "구현", finalAnswer: "Codex GPT-5가 완료", workingDirectory: root,
    });

    expect(JSON.stringify(packet)).not.toMatch(/Claude|Codex|GPT-5|session_id/i);
    expect(packet.leakageRedactions).toBeGreaterThanOrEqual(4);
    expect(packet.diffCoverage).toBe("tracked-and-untracked");
    expect(packet.trackedDiff).toContain("new-test.txt");
    expect(packet.trackedDiff).toContain("line 2");
  });
});
