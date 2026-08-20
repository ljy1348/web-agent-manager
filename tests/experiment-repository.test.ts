import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { ExperimentRepository } from "../src/server/services/experiment-repository";
import { parseExperimentDesign, parseExperimentVariantConfig, type ExperimentVariantConfig } from "../src/shared/experiments";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 임시 프로젝트와 실험 원장을 만들어 각 테스트가 독립된 SQLite를 사용하게 한다.
function createHarness(): { database: AppDatabase; repository: ExperimentRepository; projectId: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-experiment-"));
  const config = {
    rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig;
  const database = openDatabase(config);
  const result = database.prepare("INSERT INTO projects(name, path, source) VALUES ('실험 프로젝트', ?, 'manual')")
    .run(path.join(root, "project"));
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, repository: new ExperimentRepository(database), projectId: Number(result.lastInsertRowid) };
}

// 테스트 전반에서 사용할 single Codex 변형 설정을 만든다.
function variantConfig(overrides: Partial<ExperimentVariantConfig> = {}): ExperimentVariantConfig {
  return {
    schemaVersion: 1,
    runtime: { provider: "codex", accountId: null, model: "gpt-test", reasoningEffort: "high", sandbox: "workspace-write", maxTurns: null },
    skills: { mode: "selected", enabled: ["skill://review"], disabled: [], profile: "native", baseline: "installed", additions: [], comparisonId: null, activation: "native" },
    harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 1, workerCount: 2, secondaryRuntime: null },
    hooks: ["artifact_manifest"],
    budget: { maxSeconds: 600, maxTokens: 10_000, maxCostUsd: null },
    ...overrides,
  };
}

// 실험과 첫 변형을 함께 생성해 run 중심 테스트의 준비 코드를 줄인다.
function createVariant(repository: ExperimentRepository, projectId: number) {
  const experiment = repository.createExperiment({
    projectId, name: "스킬 비교", command: "요청한 기능을 구현해",
    design: {
      schemaVersion: 1, hypothesis: "review 스킬이 품질을 높인다", controlledVariables: ["runtime.model"],
      treatmentVariables: ["skills.enabled"], repetitions: 5, randomizeOrder: true,
    },
    rubric: { correctness: 0.7, maintainability: 0.3 },
  });
  const variant = repository.createVariant({ experimentId: experiment.id, name: "Codex High + review", config: variantConfig() });
  return { experiment, variant };
}

describe("실험 변형 설정", () => {
  it("생략 가능한 값을 공정한 기본값으로 채우고 범위를 벗어난 예산은 거부한다", () => {
    const parsed = parseExperimentVariantConfig({ schemaVersion: 1, runtime: { provider: "claude" } });
    expect(parsed).toMatchObject({
      runtime: { provider: "claude", accountId: null, model: null, sandbox: "workspace-write", maxTurns: null },
      skills: { mode: "all", enabled: [], disabled: [], profile: "native", baseline: "installed", additions: [], comparisonId: null },
      harness: { type: "single", maxIterations: 1, maxNoImprovement: 1 },
      budget: { maxSeconds: 1800, maxTokens: null, maxCostUsd: null },
    });
    expect(() => parseExperimentVariantConfig({
      schemaVersion: 1, runtime: { provider: "codex" }, budget: { maxSeconds: 0 },
    })).toThrow("최대 실행 시간");
  });

  it("통제 변수와 평가 변수를 분리해 native 차이도 실험 대상으로 선언하게 한다", () => {
    expect(parseExperimentDesign({
      schemaVersion: 1, hypothesis: "하네스 전체 비교", controlledVariables: ["budget.maxTokens"],
      treatmentVariables: ["runtime.provider", "environment.toolProfile"], repetitions: 5,
    })).toMatchObject({ repetitions: 5, randomizeOrder: true, treatmentVariables: ["runtime.provider", "environment.toolProfile"] });
    expect(() => parseExperimentDesign({
      schemaVersion: 1, controlledVariables: ["runtime.model"], treatmentVariables: ["runtime.model"],
    })).toThrow("함께 둘 수 없습니다");
  });
});

describe("실험 실행 원장", () => {
  it("실험·변형과 시도별 불변 설정·환경 스냅샷을 만든다", () => {
    const { database, repository, projectId } = createHarness();
    const { experiment, variant } = createVariant(repository, projectId);
    const first = repository.createRun({
      variantId: variant.id, baselineCommit: "abc123", workingDirectory: "/tmp/run-1",
      environmentSnapshot: { cliVersion: "codex-cli 1.2.3", resolvedModel: "gpt-test-2026-08-01", toolProfile: "default" },
    });
    database.prepare("UPDATE experiment_variants SET config_json = ? WHERE id = ?")
      .run(JSON.stringify(variantConfig({ hooks: ["changed"] })), variant.id);
    const second = repository.createRun({ variantId: variant.id });

    expect(experiment.rubric).toEqual({ correctness: 0.7, maintainability: 0.3 });
    expect(experiment.design).toMatchObject({ repetitions: 5, controlledVariables: ["runtime.model"], treatmentVariables: ["skills.enabled"] });
    expect(first).toMatchObject({ attempt: 1, status: "queued", baselineCommit: "abc123", totalTokens: 0 });
    expect(first.configSnapshot.hooks).toEqual(["artifact_manifest"]);
    expect(first.environmentSnapshot).toMatchObject({ resolvedModel: "gpt-test-2026-08-01", toolProfile: "default" });
    expect(second.attempt).toBe(2);
    expect(second.configSnapshot.hooks).toEqual(["changed"]);
    expect(repository.getRun(first.id)?.configSnapshot.hooks).toEqual(["artifact_manifest"]);
  });

  it("허용 상태만 전이하고 종료된 run은 다시 실행하지 않는다", () => {
    const { repository, projectId } = createHarness();
    const { variant } = createVariant(repository, projectId);
    const run = repository.createRun({ variantId: variant.id });

    expect(() => repository.transitionRun({ runId: run.id, status: "completed" })).toThrow("바꿀 수 없습니다");
    expect(repository.transitionRun({ runId: run.id, status: "preparing" }).startedAt).not.toBeNull();
    expect(repository.transitionRun({ runId: run.id, status: "running" }).status).toBe("running");
    const completed = repository.transitionRun({ runId: run.id, status: "completed" });
    expect(completed).toMatchObject({ status: "completed", terminationReason: "success" });
    expect(completed.finishedAt).not.toBeNull();
    expect(() => repository.transitionRun({ runId: run.id, status: "running" })).toThrow("바꿀 수 없습니다");
  });

  it("서버 재시작 시 이전 프로세스의 비terminal run을 runtime 실패로 종결한다", () => {
    const { repository, projectId } = createHarness();
    const { variant } = createVariant(repository, projectId);
    const queued = repository.createRun({ variantId: variant.id });
    const running = repository.createRun({ variantId: variant.id });
    repository.transitionRun({ runId: running.id, status: "preparing" });
    repository.transitionRun({ runId: running.id, status: "running" });

    expect(repository.failInterruptedRuns()).toBe(2);
    expect(repository.getRun(queued.id)).toMatchObject({ status: "failed", terminationReason: "runtime_error" });
    expect(repository.getRun(running.id)).toMatchObject({ status: "failed", terminationReason: "runtime_error" });
    expect(repository.failInterruptedRuns()).toBe(0);
  });

  it("환경·공급자 실행 ID·usage를 불변 또는 단조 관측값으로 기록한다", () => {
    const { repository, projectId } = createHarness();
    const { variant } = createVariant(repository, projectId);
    const run = repository.createRun({ variantId: variant.id, environmentSnapshot: { baseline: "abc" } });
    repository.transitionRun({ runId: run.id, status: "preparing" });

    expect(repository.mergeRunEnvironmentSnapshot(run.id, { cliVersion: "codex-cli test", skillManifest: [] }).environmentSnapshot)
      .toEqual({ baseline: "abc", cliVersion: "codex-cli test", skillManifest: [] });
    expect(() => repository.mergeRunEnvironmentSnapshot(run.id, { baseline: "changed" })).toThrow("덮어쓸 수 없습니다");
    repository.transitionRun({ runId: run.id, status: "running" });

    expect(repository.recordProviderRunId(run.id, "thread-1").providerRunId).toBe("thread-1");
    expect(repository.recordProviderRunId(run.id, "thread-1").providerRunId).toBe("thread-1");
    expect(() => repository.recordProviderRunId(run.id, "thread-2")).toThrow("다른 값");
    repository.recordRunUsage(run.id, {
      inputTokens: 100, cachedInputTokens: null, cacheCreationInputTokens: 10, cacheReadInputTokens: 20,
      outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 150, totalTokensSource: "derived", costUsd: 0.2,
    });
    const usage = repository.recordRunUsage(run.id, {
      inputTokens: 90, cachedInputTokens: 40, cacheCreationInputTokens: 5, cacheReadInputTokens: 30,
      outputTokens: 30, reasoningOutputTokens: null, totalTokens: 140, totalTokensSource: "reported", costUsd: 0.3,
    });
    expect(usage).toMatchObject({
      inputTokens: 100, cachedInputTokens: 40, cacheCreationInputTokens: 10, cacheReadInputTokens: 30,
      outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 150, totalTokensSource: "reported", costUsd: 0.3,
    });
    expect(() => repository.recordRunUsage(run.id, { totalTokens: -1 })).toThrow("0 이상의 안전한 정수");
  });

  it("에이전트 호출 node의 순서·부모·상태·usage를 run 안에서 보존한다", () => {
    const { repository, projectId } = createHarness();
    const { variant } = createVariant(repository, projectId);
    const run = repository.createRun({ variantId: variant.id });
    repository.transitionRun({ runId: run.id, status: "preparing" });
    const worker = repository.createNode({
      runId: run.id, role: "worker", provider: "codex", model: "gpt-test", payload: { prompt: "구현해" },
    });
    const reviewer = repository.createNode({
      runId: run.id, parentNodeId: worker.id, role: "reviewer", provider: "claude", payload: { target: worker.id },
    });
    expect(worker).toMatchObject({ ordinal: 1, attempt: 1, status: "queued", input: { prompt: "구현해" } });
    expect(reviewer).toMatchObject({ ordinal: 2, parentNodeId: worker.id });
    expect(() => repository.createNode({ runId: run.id, parentNodeId: "missing", role: "invalid" })).toThrow("부모 노드");

    expect(repository.transitionNode({ nodeId: worker.id, status: "running" }).startedAt).not.toBeNull();
    expect(repository.recordNodeUsage(worker.id, {
      inputTokens: 100, cacheCreationInputTokens: 10, cacheReadInputTokens: 20,
      outputTokens: 30, totalTokens: 160, totalTokensSource: "derived", costUsd: 0.25,
    })).toMatchObject({
      inputTokens: 100, cacheCreationInputTokens: 10, cacheReadInputTokens: 20,
      outputTokens: 30, totalTokens: 160, totalTokensSource: "derived", costUsd: 0.25,
    });
    const completed = repository.transitionNode({ nodeId: worker.id, status: "completed", output: { answer: "완료" } });
    expect(completed).toMatchObject({ status: "completed", output: { answer: "완료" } });
    expect(completed.finishedAt).not.toBeNull();
    expect(() => repository.recordNodeUsage(worker.id, { totalTokens: 170 })).toThrow("실행 중인 노드");
    expect(() => repository.transitionNode({ nodeId: worker.id, status: "running" })).toThrow("바꿀 수 없습니다");
  });

  it("이벤트 멱등 키와 연속 순번을 보장하고 큰 본문은 산출물 저장을 요구한다", () => {
    const { repository, projectId } = createHarness();
    const { variant } = createVariant(repository, projectId);
    const run = repository.createRun({ variantId: variant.id });

    const first = repository.appendEvent({ runId: run.id, idempotencyKey: "prepare:1", type: "run.preparing", payload: { phase: 1 } });
    const duplicate = repository.appendEvent({ runId: run.id, idempotencyKey: "prepare:1", type: "ignored", payload: { phase: 2 } });
    const second = repository.appendEvent({ runId: run.id, idempotencyKey: "start:1", type: "run.started" });

    expect(first).toMatchObject({ inserted: true, event: { sequence: 1, type: "run.preparing", payload: { phase: 1 } } });
    expect(duplicate).toMatchObject({ inserted: false, event: { id: first.event.id, type: "run.preparing" } });
    expect(second.event.sequence).toBe(2);
    expect(repository.listEvents(run.id).map((event) => event.sequence)).toEqual([1, 2]);
    expect(() => repository.appendEvent({
      runId: run.id, idempotencyKey: "too-large", type: "runtime.output", payload: { text: "x".repeat(257 * 1024) },
    })).toThrow("256KiB");
  });

  it("체크포인트는 최신 이벤트 경계만 유지하고 다른 run의 노드를 거부한다", () => {
    const { database, repository, projectId } = createHarness();
    const { variant } = createVariant(repository, projectId);
    const firstRun = repository.createRun({ variantId: variant.id });
    const secondRun = repository.createRun({ variantId: variant.id });
    const nodeId = "node-first";
    database.prepare(`
      INSERT INTO experiment_nodes(id, run_id, role, ordinal, status) VALUES (?, ?, 'worker', 1, 'completed')
    `).run(nodeId, firstRun.id);
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      repository.appendEvent({ runId: firstRun.id, idempotencyKey: `event:${sequence}`, type: "node.progress", payload: { sequence } });
    }

    const latest = repository.saveCheckpoint({
      runId: firstRun.id, nodeId, eventSequence: 4, state: { next: "evaluate" }, artifacts: ["artifact-1", "artifact-1"],
    });
    const stale = repository.saveCheckpoint({ runId: firstRun.id, eventSequence: 3, state: { next: "old" } });

    expect(latest).toMatchObject({ eventSequence: 4, nodeId, state: { next: "evaluate" }, artifacts: ["artifact-1"] });
    expect(stale).toMatchObject({ eventSequence: 4, nodeId, state: { next: "evaluate" } });
    expect(() => repository.saveCheckpoint({
      runId: secondRun.id, nodeId, eventSequence: 1, state: {},
    })).toThrow("이 실행에 속하지 않습니다");
    expect(() => repository.saveCheckpoint({
      runId: firstRun.id, eventSequence: 5, state: {},
    })).toThrow("미래 이벤트");
  });

  it("우승 설정을 덮어쓰지 않는 preset 버전 스키마를 제공한다", () => {
    const { database, repository, projectId } = createHarness();
    const { experiment, variant } = createVariant(repository, projectId);
    const run = repository.createRun({ variantId: variant.id });
    database.transaction(() => {
      database.prepare("INSERT INTO agent_presets(id, project_id, name) VALUES ('preset-1', ?, '고품질 리뷰')").run(projectId);
      database.prepare(`
        INSERT INTO agent_preset_versions(
          id, preset_id, version, config_snapshot_json, source_experiment_id, source_variant_id, source_run_id,
          promotion_metrics_json
        ) VALUES ('preset-version-1', 'preset-1', 1, ?, ?, ?, ?, ?)
      `).run(JSON.stringify(run.configSnapshot), experiment.id, variant.id, run.id, JSON.stringify({ successRate: 0.98, costDelta: 0.31 }));
      database.prepare("UPDATE agent_presets SET status = 'active', active_version = 1 WHERE id = 'preset-1'").run();
    })();

    expect(database.prepare("SELECT active_version FROM agent_presets WHERE id = 'preset-1'").get()).toEqual({ active_version: 1 });
    expect(database.prepare("SELECT source_run_id, promotion_metrics_json FROM agent_preset_versions").get()).toEqual({
      source_run_id: run.id,
      promotion_metrics_json: JSON.stringify({ successRate: 0.98, costDelta: 0.31 }),
    });
  });

  it("동일 계열 평가를 금지하지 않고 피험·평가 provenance를 함께 보존한다", () => {
    const { database, repository, projectId } = createHarness();
    const { experiment, variant } = createVariant(repository, projectId);
    const run = repository.createRun({ variantId: variant.id });
    database.prepare(`
      INSERT INTO experiment_evaluations(id, experiment_id, method, rubric_json)
      VALUES ('evaluation-1', ?, 'rubric', '{}')
    `).run(experiment.id);
    database.prepare(`
      INSERT INTO experiment_judgments(
        id, evaluation_id, run_id, evaluator_label, evaluator_kind,
        evaluator_provider, evaluator_model, evaluator_family,
        subject_provider, subject_model, subject_family, same_family,
        blind_label, presentation_order, score, confidence, result_json,
        input_tokens, output_tokens, total_tokens, total_tokens_source, cost_usd
      ) VALUES ('judgment-1', 'evaluation-1', ?, 'Claude judge', 'agent',
        'claude', 'sonnet-test', 'claude', 'claude', 'sonnet-subject', 'claude', 1,
        'result-b', 2, 0.91, 0.8, '{"reason":"요건 충족"}', 100, 20, 120, 'reported', 0.04)
    `).run(run.id);

    expect(repository.listJudgments(run.id)[0]).toMatchObject({
      evaluatorLabel: "Claude judge", evaluatorProvider: "claude", evaluatorModel: "sonnet-test",
      evaluatorFamily: "claude", subjectProvider: "claude", subjectModel: "sonnet-subject", subjectFamily: "claude",
      sameFamily: true, blindLabel: "result-b", presentationOrder: 2, score: 0.91, confidence: 0.8,
      result: { reason: "요건 충족" }, inputTokens: 100, outputTokens: 20, totalTokens: 120,
      totalTokensSource: "reported", costUsd: 0.04,
    });
  });

  it("평가 subject·호출·judgment 멱등성을 분리하고 재시작 고아 평가를 종결한다", () => {
    const { database, repository, projectId } = createHarness();
    const { experiment, variant } = createVariant(repository, projectId);
    const run = repository.createRun({ variantId: variant.id });
    repository.transitionRun({ runId: run.id, status: "preparing" });
    repository.transitionRun({ runId: run.id, status: "running" });
    repository.transitionRun({ runId: run.id, status: "completed" });
    const evaluation = repository.createEvaluation({
      experimentId: experiment.id, method: "rubric", rubric: { correctness: 1 },
      subjects: [{ runId: run.id, blindLabel: "후보-X", presentationOrder: 1 }],
    });
    const call = repository.createEvaluationCall({
      evaluationId: evaluation.id, idempotencyKey: "call-1", evaluatorLabel: "Codex judge",
      evaluatorProvider: "codex", evaluatorModel: "gpt-test", evaluatorFamily: "codex",
    });
    expect(repository.createEvaluationCall({
      evaluationId: evaluation.id, idempotencyKey: "call-1", evaluatorLabel: "Codex judge",
      evaluatorProvider: "codex", evaluatorModel: "gpt-test", evaluatorFamily: "codex",
    }).id).toBe(call.id);
    repository.transitionEvaluation(evaluation.id, "running");
    repository.transitionEvaluationCall({ callId: call.id, status: "running" });
    const first = repository.createJudgment({
      evaluationId: evaluation.id, callId: call.id, idempotencyKey: "judgment-1", runId: run.id,
      evaluatorLabel: "Codex judge", evaluatorProvider: "codex", evaluatorFamily: "codex",
      subjectProvider: "codex", subjectFamily: "codex", score: 0.8, confidence: 0.9, result: { reason: "충족" },
    });
    const duplicate = repository.createJudgment({
      evaluationId: evaluation.id, callId: call.id, idempotencyKey: "judgment-1", runId: run.id,
      evaluatorLabel: "Codex judge", evaluatorProvider: "codex", evaluatorFamily: "codex",
      subjectProvider: "codex", subjectFamily: "codex", score: 0.1, confidence: 0.1, result: { reason: "변경 시도" },
    });

    expect(evaluation.blindMap).toEqual({ "후보-X": run.id });
    expect(first.id).toBe(duplicate.id);
    expect(duplicate).toMatchObject({ score: 0.8, result: { reason: "충족" }, callId: call.id, sameFamily: true });
    expect(repository.failInterruptedEvaluations()).toBe(1);
    expect(repository.getEvaluation(evaluation.id)).toMatchObject({ status: "failed", error: "서버 재시작으로 평가가 중단됐습니다." });
    expect(repository.getEvaluationCall(call.id)).toMatchObject({ status: "failed" });
  });
});

describe("저장소 fixture와 과제 유형", () => {
  it("공개 저장소 fixture를 argv 명령과 함께 등록하고 게이트 결과로 상태를 고정한다", () => {
    const { repository } = createHarness();
    const fixture = repository.createFixture({
      name: "sample-medium", url: "https://github.com/example/repo",
      pinnedCommit: "A".repeat(40), sizeClass: "medium", language: "python",
      license: "MIT", linesOfCode: 42_000,
      setupCommand: ["pip", "install", "-e", "."], testCommand: ["pytest", "-q"],
    });

    expect(fixture).toMatchObject({
      name: "sample-medium", sizeClass: "medium", status: "draft", mirrorPath: null,
      pinnedCommit: "a".repeat(40), testCommand: ["pytest", "-q"],
    });

    expect(repository.recordFixtureGate(fixture.id, true, { baselineGreen: true }).status).toBe("ready");
    expect(repository.recordFixtureMirror(fixture.id, "/data/mirrors/sample").mirrorPath).toBe("/data/mirrors/sample");
    expect(repository.listFixtures().map((entry) => entry.id)).toEqual([fixture.id]);

    const rejected = repository.recordFixtureGate(fixture.id, false, { reason: "기준선 테스트 실패" });
    expect(rejected).toMatchObject({ status: "rejected", gate: { reason: "기준선 테스트 실패" } });
  });

  it("모호한 commit·shell 문자열·알 수 없는 URL 형식을 거부한다", () => {
    const { repository } = createHarness();
    const base = {
      name: "bad", url: "https://github.com/example/repo", pinnedCommit: "b".repeat(40),
      sizeClass: "small", setupCommand: [], testCommand: [],
    };
    expect(() => repository.createFixture({ ...base, pinnedCommit: "abc1234" })).toThrow("40자 SHA");
    expect(() => repository.createFixture({ ...base, url: "git@github.com:example/repo.git" })).toThrow("https:// 또는 file://");
    expect(() => repository.createFixture({ ...base, testCommand: "pytest -q && rm -rf /" })).toThrow("인자 배열");
    expect(() => repository.createFixture({ ...base, sizeClass: "huge" })).toThrow("fixture 규모");
  });

  it("실험에 과제 유형과 fixture를 연결하고 미지정 실험은 null로 남긴다", () => {
    const { repository, projectId } = createHarness();
    const fixture = repository.createFixture({
      name: "linked", url: "https://github.com/example/repo", pinnedCommit: "c".repeat(40),
      sizeClass: "large", setupCommand: [], testCommand: ["npm", "test"],
    });

    const linked = repository.createExperiment({
      projectId, name: "유지보수", command: "버그를 고쳐라", taskKind: "maintenance", fixtureId: fixture.id,
    });
    expect(linked).toMatchObject({ taskKind: "maintenance", fixtureId: fixture.id });

    const plain = repository.createExperiment({ projectId, name: "미지정", command: "무언가" });
    expect(plain).toMatchObject({ taskKind: null, fixtureId: null });

    expect(() => repository.createExperiment({ projectId, name: "잘못", command: "x", taskKind: "refactor" }))
      .toThrow("과제 유형");
  });
});

describe("실행 계획 큐", () => {
  it("반복 실행을 arm 회전 교차 순서로 펼친다", () => {
    const { repository, projectId } = createHarness();
    const experiment = repository.createExperiment({ projectId, name: "큐", command: "작업" });
    const config = {
      schemaVersion: 1,
      runtime: { provider: "codex", accountId: null, model: "m", reasoningEffort: "high", sandbox: "workspace-write", maxTurns: null },
      skills: { mode: "all", enabled: [], disabled: [], profile: "native", baseline: "installed", additions: [], comparisonId: null, activation: "native" },
      harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 1, workerCount: 2, secondaryRuntime: null },
      hooks: [], budget: { maxSeconds: 60, maxTokens: null, maxCostUsd: null },
    };
    const a = repository.createVariant({ experimentId: experiment.id, name: "A", config });
    const b = repository.createVariant({ experimentId: experiment.id, name: "B", config });
    const c = repository.createVariant({ experimentId: experiment.id, name: "C", config });

    const plan = repository.createRunPlan({ experimentId: experiment.id, stage: "screening", repetitions: 3 });
    const names = new Map([[a.id, "A"], [b.id, "B"], [c.id, "C"]]);
    const order = plan.items.map((item) => names.get(item.variantId));

    // 회전 교차라 같은 arm이 항상 먼저 돌지 않으면서 순서가 재현 가능해야 한다.
    expect(order).toEqual(["A", "B", "C", "B", "C", "A", "C", "A", "B"]);
    expect(plan.items.every((item) => item.status === "queued")).toBe(true);
    expect(plan.items.map((item) => item.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("항목을 순서대로 하나씩 주고 실패해도 큐를 멈추지 않는다", () => {
    const { repository, projectId } = createHarness();
    const experiment = repository.createExperiment({ projectId, name: "큐2", command: "작업" });
    const config = {
      schemaVersion: 1,
      runtime: { provider: "codex", accountId: null, model: "m", reasoningEffort: "high", sandbox: "workspace-write", maxTurns: null },
      skills: { mode: "all", enabled: [], disabled: [], profile: "native", baseline: "installed", additions: [], comparisonId: null, activation: "native" },
      harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 1, workerCount: 2, secondaryRuntime: null },
      hooks: [], budget: { maxSeconds: 60, maxTokens: null, maxCostUsd: null },
    };
    repository.createVariant({ experimentId: experiment.id, name: "A", config });
    repository.createVariant({ experimentId: experiment.id, name: "B", config });
    const plan = repository.createRunPlan({ experimentId: experiment.id, stage: "grid", repetitions: 1 });

    const first = repository.nextQueuedPlanItem(plan.id)!;
    repository.updatePlanItem(first.id, { status: "failed", error: "provider_limit" });
    const second = repository.nextQueuedPlanItem(plan.id)!;
    expect(second.ordinal).toBe(1);
    repository.updatePlanItem(second.id, { status: "completed" });
    expect(repository.nextQueuedPlanItem(plan.id)).toBeNull();

    // 취소한 계획은 남은 항목을 더 주지 않는다.
    const other = repository.createRunPlan({ experimentId: experiment.id, stage: "confirmation", repetitions: 2 });
    repository.setRunPlanStatus(other.id, "cancelled");
    expect(repository.nextQueuedPlanItem(other.id)).toBeNull();

    expect(repository.listRunPlans(experiment.id).map((entry) => entry.stage)).toContain("grid");
    expect(() => repository.createRunPlan({ experimentId: experiment.id, stage: "screening", repetitions: 0 })).toThrow("1~100");
  });
});

describe("실행 계획의 기준 commit 고정", () => {
  it("계획에 기준 commit을 저장해 실행 도중 커밋이 쌓여도 같은 조건을 유지한다", () => {
    const { repository, projectId } = createHarness();
    const experiment = repository.createExperiment({ projectId, name: "고정", command: "작업" });
    const config = {
      schemaVersion: 1,
      runtime: { provider: "codex", accountId: null, model: "m", reasoningEffort: "high", sandbox: "workspace-write", maxTurns: null },
      skills: { mode: "all", enabled: [], disabled: [], profile: "native", baseline: "installed", additions: [], comparisonId: null, activation: "native" },
      harness: { type: "single", maxIterations: 1, minimumScore: null, maxNoImprovement: 1, workerCount: 2, secondaryRuntime: null },
      hooks: [], budget: { maxSeconds: 60, maxTokens: null, maxCostUsd: null },
    };
    repository.createVariant({ experimentId: experiment.id, name: "A", config });

    const pinned = repository.createRunPlan({
      experimentId: experiment.id, stage: "confirmation", repetitions: 2, baselineCommit: "a".repeat(40),
    });
    expect(pinned.baselineCommit).toBe("a".repeat(40));
    expect(repository.getRunPlan(pinned.id)!.baselineCommit).toBe("a".repeat(40));

    // 고정하지 않은 계획은 null로 남아 기존처럼 실행 시점 HEAD를 쓴다.
    const floating = repository.createRunPlan({ experimentId: experiment.id, stage: "screening", repetitions: 1 });
    expect(floating.baselineCommit).toBeNull();
  });
});
