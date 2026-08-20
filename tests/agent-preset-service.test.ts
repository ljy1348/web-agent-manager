import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { AgentPresetService } from "../src/server/services/agent-preset-service";
import { ExperimentRepository } from "../src/server/services/experiment-repository";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

// 승격 테스트용 사용자·프로젝트·완료 run을 만든다.
function createCompletedRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-preset-service-"));
  roots.push(root);
  const database = openDatabase({ rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0, publicUrl: "", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('프리셋', ?)").run(root).lastInsertRowid);
  const repository = new ExperimentRepository(database);
  const experiment = repository.createExperiment({ projectId, name: "승격", command: "구현" });
  const variant = repository.createVariant({ experimentId: experiment.id, name: "우승", config: { schemaVersion: 1, runtime: { provider: "codex" }, harness: { type: "single" } } });
  const run = repository.createRun({ variantId: variant.id });
  repository.transitionRun({ runId: run.id, status: "preparing" });
  repository.transitionRun({ runId: run.id, status: "running" });
  repository.transitionRun({ runId: run.id, status: "completed" });
  return { database, repository, projectId, run };
}

describe("AgentPresetService", () => {
  it("완료 run snapshot을 accepted 판정과 새 활성 버전으로 누적한다", () => {
    const { database, projectId, run } = createCompletedRun();
    const service = new AgentPresetService(database);

    const first = service.promote({ runId: run.id, userId: 1, name: "Codex High", note: "품질 우선" });
    const second = service.promote({ runId: run.id, userId: 1, name: "Codex High", note: "재검증" });

    expect(first).toMatchObject({ name: "Codex High", status: "active", activeVersion: 1 });
    expect(second).toMatchObject({ activeVersion: 2 });
    expect(second.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(second.versions[0]).toMatchObject({ sourceRunId: run.id, promotionMetrics: { sampleSize: 1, successRate: 1 }, compatibility: { status: "warning" } });
    expect(second.versions[0]?.configSnapshot).toEqual(run.configSnapshot);
    expect(database.prepare("SELECT verdict, note FROM experiment_human_verdicts").all()).toEqual(expect.arrayContaining([
      { verdict: "accepted", note: "품질 우선" }, { verdict: "accepted", note: "재검증" },
    ]));
    expect(service.list(projectId)).toHaveLength(1);
    database.close();
  });

  it("미완료 run 승격을 거부한다", () => {
    const { database, repository, run } = createCompletedRun();
    const queued = repository.createRun({ variantId: run.variantId });
    expect(() => new AgentPresetService(database).promote({ runId: queued.id, userId: 1, name: "거부" })).toThrow("완료 run");
    database.close();
  });

  it("비활성 새 버전은 기존 활성 버전을 유지한다", () => {
    const { database, run } = createCompletedRun();
    const service = new AgentPresetService(database);
    service.promote({ runId: run.id, userId: 1, name: "유지", note: "활성", activate: true });

    const preset = service.promote({ runId: run.id, userId: 1, name: "유지", note: "후보", activate: false });

    expect(preset).toMatchObject({ status: "active", activeVersion: 1 });
    expect(preset.versions.map((version) => version.version)).toEqual([2, 1]);
    database.close();
  });
});
