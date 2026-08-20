import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { createExperimentRouter } from "../src/server/routes/experiment-routes";
import type { ExperimentService } from "../src/server/services/experiment-service";
import { ExperimentCapacityError } from "../src/server/services/experiment-service";
import { ExperimentRepository } from "../src/server/services/experiment-repository";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// 실제 실험 스키마와 관리자 인증이 연결된 임시 HTTP 앱을 만든다.
async function createApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-experiment-route-"));
  roots.push(root);
  const database = openDatabase({
    rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
    publicUrl: "", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false,
    slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'test', 'admin')").run();
  database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', ?)").run(root);
  const repository = new ExperimentRepository(database);
  const startVariant = vi.fn();
  const cancel = vi.fn();
  const detail = vi.fn();
  const startEvaluation = vi.fn();
  const evaluationDetail = vi.fn();
  const cancelEvaluation = vi.fn();
  const listSkillCandidates = vi.fn().mockReturnValue([
    { id: "lab:review", name: "review", source: "project_lab", scope: "lab", includedByDefault: false },
  ]);
  const assertSkillIsolationVariant = vi.fn();
  const service = {
    repository, startVariant, cancel, detail, startEvaluation, evaluationDetail, cancelEvaluation,
    listSkillCandidates, assertSkillIsolationVariant,
  } as unknown as ExperimentService;
  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    next();
  });
  app.use(createExperimentRouter(database, service));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    database, repository, startVariant, cancel, detail, startEvaluation, evaluationDetail, cancelEvaluation,
    listSkillCandidates, assertSkillIsolationVariant, server, baseUrl,
  };
}

describe("Agent Lab API", () => {
  it("실험·Variant를 만들고 프로젝트 조건 매트릭스로 조회한다", async () => {
    const app = await createApp();
    const experimentResponse = await fetch(`${app.baseUrl}/projects/1/experiments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "스킬 비교", command: "기능을 구현해",
        design: { schemaVersion: 1, controlledVariables: ["runtime.model"], treatmentVariables: ["skills.mode"], repetitions: 3 },
        rubric: { correctness: 1 },
      }),
    });
    const experiment = (await experimentResponse.json() as { experiment: { id: string } }).experiment;
    const variantResponse = await fetch(`${app.baseUrl}/experiments/${experiment.id}/variants`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex + all", config: {
          schemaVersion: 1, runtime: { provider: "codex", model: "gpt-test", sandbox: "workspace-write" },
          skills: { mode: "all" }, harness: { type: "single" }, budget: { maxSeconds: 60 },
        },
      }),
    });
    const listResponse = await fetch(`${app.baseUrl}/projects/1/experiments`);
    const list = await listResponse.json() as { experiments: Array<{ variants: unknown[] }> };

    expect(experimentResponse.status).toBe(201);
    expect(variantResponse.status).toBe(201);
    expect(listResponse.status).toBe(200);
    expect(list.experiments[0]?.variants).toHaveLength(1);
    expect(app.database.prepare("SELECT action FROM audit_logs ORDER BY id").all()).toEqual([
      { action: "experiment.create" }, { action: "experiment.variant_create" },
    ]);
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.database.close();
  });

  it("run 시작·상세·취소를 service에 위임하고 감사 로그를 남긴다", async () => {
    const app = await createApp();
    const fakeRun = { id: "run-1", variantId: "variant-1", status: "running" };
    app.startVariant.mockResolvedValue(fakeRun);
    app.detail.mockReturnValue({ run: fakeRun, nodes: [], events: [], checkpoint: null, judgments: [] });
    app.cancel.mockResolvedValue({ ...fakeRun, status: "cancelled" });

    const start = await fetch(`${app.baseUrl}/experiment-variants/variant-1/runs`, { method: "POST" });
    const detail = await fetch(`${app.baseUrl}/experiment-runs/run-1?afterSequence=7`);
    const cancel = await fetch(`${app.baseUrl}/experiment-runs/run-1/cancel`, { method: "POST" });

    expect(start.status).toBe(202);
    expect(detail.status).toBe(200);
    expect(cancel.status).toBe(200);
    expect(app.startVariant).toHaveBeenCalledWith("variant-1");
    expect(app.detail).toHaveBeenCalledWith("run-1", 7);
    expect(app.cancel).toHaveBeenCalledWith("run-1");
    expect(app.database.prepare("SELECT action FROM audit_logs ORDER BY id").all()).toEqual([
      { action: "experiment.run_start" }, { action: "experiment.run_cancel" },
    ]);
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.database.close();
  });

  it("경로 없는 스킬 후보를 반환하고 graph의 SessionStart 주입은 저장 전에 거부한다", async () => {
    const app = await createApp();
    const candidatesResponse = await fetch(`${app.baseUrl}/projects/1/experiment-skills?provider=codex`);
    const candidates = await candidatesResponse.json() as { candidates: Array<Record<string, unknown>> };
    const experiment = app.repository.createExperiment({ projectId: 1, name: "격리", command: "구현" });
    const invalid = await fetch(`${app.baseUrl}/experiments/${experiment.id}/variants`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "잘못된 graph overlay",
        config: {
          schemaVersion: 1,
          runtime: { provider: "claude", model: "claude-test", reasoningEffort: "high", sandbox: "workspace-write" },
          // SessionStart 주입은 Claude 전용 plugin hook이라 공급자별 bundle이 나뉘는 graph에서는 막는다.
          skills: { mode: "all", profile: "isolated_overlay", baseline: "installed", additions: [], comparisonId: "claude-default", activation: "session_start" },
          harness: { type: "orchestrator_worker", secondaryRuntime: { provider: "codex", model: "gpt-test", reasoningEffort: "high" } },
          budget: { maxSeconds: 60 },
        },
      }),
    });

    expect(candidatesResponse.status).toBe(200);
    expect(candidates.candidates).toEqual([expect.objectContaining({ id: "lab:review", includedByDefault: false })]);
    expect(candidates.candidates[0]).not.toHaveProperty("skillFile");
    expect(candidates.candidates[0]).not.toHaveProperty("directory");
    expect(app.listSkillCandidates).toHaveBeenCalledWith(1, "codex", null);
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: string }).error).toContain("single 하네스");

    // 공급자별 bundle을 따로 만드는 native overlay는 graph에서도 저장된다.
    const allowed = await fetch(`${app.baseUrl}/experiments/${experiment.id}/variants`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "graph overlay",
        config: {
          schemaVersion: 1,
          runtime: { provider: "codex", model: "gpt-test", reasoningEffort: "high", sandbox: "workspace-write" },
          skills: { mode: "all", profile: "isolated_overlay", baseline: "installed", additions: [], comparisonId: "codex-default", activation: "native" },
          harness: { type: "orchestrator_worker", secondaryRuntime: { provider: "claude", model: "claude-test", reasoningEffort: "high" } },
          budget: { maxSeconds: 60 },
        },
      }),
    });
    expect(allowed.status).toBe(201);
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.database.close();
  });

  it("비활성 프로젝트 생성을 거부하고 동시 실행 한도는 429로 구분한다", async () => {
    const app = await createApp();
    app.database.prepare("UPDATE projects SET active = 0 WHERE id = 1").run();
    const inactive = await fetch(`${app.baseUrl}/projects/1/experiments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "거부", command: "실행" }),
    });
    app.startVariant.mockRejectedValue(new ExperimentCapacityError());
    const capacity = await fetch(`${app.baseUrl}/experiment-variants/variant-1/runs`, { method: "POST" });

    expect(inactive.status).toBe(400);
    expect((await inactive.json() as { error: string }).error).toContain("프로젝트를 찾을 수 없습니다");
    expect(capacity.status).toBe(429);
    expect(capacity.headers.get("retry-after")).toBe("2");
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.database.close();
  });

  it("복수 evaluator 시작·상세·취소를 service에 위임하고 감사 로그를 남긴다", async () => {
    const app = await createApp();
    const evaluation = { id: "evaluation-1", status: "running" };
    app.startEvaluation.mockResolvedValue(evaluation);
    app.evaluationDetail.mockReturnValue({ evaluation, calls: [], judgments: [] });
    app.cancelEvaluation.mockResolvedValue({ ...evaluation, status: "partial" });
    const evaluators = [{ label: "Codex judge", provider: "codex" }, { label: "Claude judge", provider: "claude" }];

    const start = await fetch(`${app.baseUrl}/experiment-runs/run-1/evaluations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evaluators }),
    });
    const detail = await fetch(`${app.baseUrl}/experiment-evaluations/evaluation-1`);
    const cancel = await fetch(`${app.baseUrl}/experiment-evaluations/evaluation-1/cancel`, { method: "POST" });

    expect(start.status).toBe(202);
    expect(detail.status).toBe(200);
    expect(cancel.status).toBe(200);
    expect(app.startEvaluation).toHaveBeenCalledWith("run-1", evaluators);
    expect(app.evaluationDetail).toHaveBeenCalledWith("evaluation-1");
    expect(app.cancelEvaluation).toHaveBeenCalledWith("evaluation-1");
    expect(app.database.prepare("SELECT action FROM audit_logs ORDER BY id").all()).toEqual([
      { action: "experiment.evaluation_start" }, { action: "experiment.evaluation_cancel" },
    ]);
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.database.close();
  });

  it("완료 run을 활성 preset으로 승격하고 프로젝트 목록과 감사 로그에 반영한다", async () => {
    const app = await createApp();
    const experiment = app.repository.createExperiment({ projectId: 1, name: "승격", command: "구현" });
    const variant = app.repository.createVariant({
      experimentId: experiment.id, name: "우승",
      config: { schemaVersion: 1, runtime: { provider: "codex" }, harness: { type: "single" } },
    });
    const run = app.repository.createRun({ variantId: variant.id });
    app.repository.transitionRun({ runId: run.id, status: "preparing" });
    app.repository.transitionRun({ runId: run.id, status: "running" });
    app.repository.transitionRun({ runId: run.id, status: "completed" });

    const promote = await fetch(`${app.baseUrl}/experiment-runs/${run.id}/promote`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "프로덕션 우승", note: "사람 최종 선택", activate: true }),
    });
    const list = await fetch(`${app.baseUrl}/projects/1/agent-presets`);
    const promoted = await promote.json() as { preset: { name: string; activeVersion: number } };
    const presets = await list.json() as { presets: Array<{ name: string; activeVersion: number }> };

    expect(promote.status).toBe(201);
    expect(list.status).toBe(200);
    expect(promoted.preset).toMatchObject({ name: "프로덕션 우승", activeVersion: 1 });
    expect(presets.presets).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "프로덕션 우승", activeVersion: 1 }),
    ]));
    expect(app.database.prepare("SELECT action FROM audit_logs ORDER BY id").all()).toEqual([{ action: "experiment.run_promote" }]);
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    app.database.close();
  });
});
