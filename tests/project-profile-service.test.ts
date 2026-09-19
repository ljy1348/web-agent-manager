import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { AgentPresetService } from "../src/server/services/agent-preset-service";

const roots: string[] = [];

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-data-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-project-"));
  roots.push(dataDir, projectPath);
  const database = openDatabase({ dataDir } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('sample', ?)").run(projectPath).lastInsertRowid);
  return { database, projectPath, projectId, service: new AgentPresetService(database) };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("project profile 호환 확장", () => {
  it("프로젝트 지침과 package scripts로 미저장 초안을 만들며 task kind 안전 기본값을 적용한다", () => {
    const { database, projectPath, projectId, service } = fixture();
    fs.writeFileSync(path.join(projectPath, "AGENTS.md"), "instructions");
    fs.writeFileSync(path.join(projectPath, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest", build: "vite build", dev: "vite" } }));

    const draft = service.draft(projectId, "codex", "implementation") as any;

    expect(draft.detected).toEqual({ packageManager: "npm", scripts: ["typecheck", "test", "build", "dev"], instructions: [{ name: "AGENTS.md", present: true }, { name: "CLAUDE.md", present: false }], recommendationId: null });
    expect(draft.configSnapshot).toMatchObject({
      taskKind: "implementation",
      runtime: { provider: "codex" },
      permissions: { sandbox: "workspace-write", approvalMode: "untrusted" },
      verification: { steps: [
        { kind: "static", command: "npm run typecheck", required: true },
        { kind: "full_test", command: "npm run test", required: true },
        { kind: "build", command: "npm run build", required: true },
      ] },
    });
    expect(draft.warnings).toEqual(["CLAUDE.md 없음"]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_presets").get()).toEqual({ count: 0 });
    database.close();
  });

  it("Claude profile에서 AGENTS 지침을 import하지 않은 CLAUDE.md를 경고한다", () => {
    const { database, projectPath, projectId, service } = fixture();
    fs.writeFileSync(path.join(projectPath, "AGENTS.md"), "shared instructions");
    fs.writeFileSync(path.join(projectPath, "CLAUDE.md"), "Claude only instructions");
    expect((service.draft(projectId, "claude", "analysis") as any).warnings).toContain("CLAUDE.md import 불일치");
    fs.writeFileSync(path.join(projectPath, "CLAUDE.md"), "@AGENTS.md\n\nClaude only instructions");
    expect((service.draft(projectId, "claude", "analysis") as any).warnings).not.toContain("CLAUDE.md import 불일치");
    database.close();
  });

  it("등록 프로젝트 추천을 초안의 실행 recipe·추론 강도·보호 작업에 반영하되 저장하지 않는다", () => {
    const { database, projectPath, projectId, service } = fixture();
    database.prepare("UPDATE projects SET name='WSS-Server' WHERE id=?").run(projectId);
    fs.writeFileSync(path.join(projectPath, "gradlew"), "#!/bin/sh\n", { mode: 0o700 });
    const draft = service.draft(projectId, "codex", "implementation") as any;
    expect(draft.detected.recommendationId).toBe("wss-server-spring");
    expect(draft.configSnapshot).toMatchObject({
      runtime: { provider: "codex", reasoningEffort: "high" },
      profileTemplate: { id: "wss-server-spring", source: "registered_project_catalog" },
      verification: { steps: [
        { kind: "full_test", argv: ["./gradlew", "test"] },
        { kind: "contract", argv: ["./gradlew", "apiDocs"], includePaths: expect.arrayContaining(["src/test/**"]) },
      ] },
      protectedActions: expect.arrayContaining(["production_database", "redis", "deploy"]),
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_presets").get()).toEqual({ count: 0 });
    database.close();
  });

  it("수동 draft version을 덮어쓰지 않고 추가하며 검토한 특정 version만 활성화한다", () => {
    const { database, projectId, service } = fixture();
    const v1Config = { schemaVersion: 1, runtime: { provider: "codex", model: "m1" }, taskKind: "analysis" };
    const created = service.createManual({ projectId, userId: 1, name: "분석", taskKind: "analysis", configSnapshot: v1Config });
    expect(created).toMatchObject({ taskKind: "analysis", status: "draft", activeVersion: null });
    const v1 = created.versions[0];

    const updated = service.addManualVersion({ projectId, presetId: created.id, userId: 1, configSnapshot: { schemaVersion: 1, runtime: { provider: "codex", model: "m2" } } });
    expect(updated.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(updated.versions[1].configSnapshot).toEqual(v1Config);

    const activated = service.activate({ projectId, presetId: created.id, versionId: v1.id });
    expect(activated).toMatchObject({ status: "active", activeVersion: 1 });
    expect(activated.versions[0].configSnapshot).toMatchObject({ runtime: { model: "m2" } });
    const replacement = service.createManual({ projectId, userId: 1, name: "분석 대체", taskKind: "analysis", configSnapshot: { runtime: { provider: "codex" } } });
    service.activate({ projectId, presetId: replacement.id, versionId: replacement.versions[0].id });
    expect(database.prepare("SELECT id, status FROM agent_presets WHERE task_kind = 'analysis' ORDER BY name").all()).toEqual([
      { id: created.id, status: "draft" }, { id: replacement.id, status: "active" },
    ]);
    database.close();
  });

  it("다른 프로젝트 version 활성화와 잘못된 provider/task kind 설정을 거부한다", () => {
    const { database, projectId, service } = fixture();
    expect(() => service.createManual({ projectId, userId: 1, name: "bad", taskKind: "unknown", configSnapshot: { runtime: { provider: "codex" } } })).toThrow("작업 종류");
    expect(() => service.createManual({ projectId, userId: 1, name: "bad", taskKind: "analysis", configSnapshot: { runtime: { provider: "other" } } })).toThrow("runtime provider");
    const profile = service.createManual({ projectId, userId: 1, name: "valid", taskKind: "analysis", configSnapshot: { runtime: { provider: "codex" } } });
    const otherPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-profile-other-"));
    roots.push(otherPath);
    const otherId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('other', ?)").run(otherPath).lastInsertRowid);

    expect(() => service.activate({ projectId: otherId, presetId: profile.id, versionId: profile.versions[0].id })).toThrow("version을 찾을 수 없습니다");
    database.close();
  });

  it("task kind보다 넓은 권한은 저장 전에 거부하고 DB에 흔적을 남기지 않는다", () => {
    const { database, projectId, service } = fixture();
    expect(() => service.createManual({
      projectId,
      userId: 1,
      name: "unsafe analysis",
      taskKind: "analysis",
      configSnapshot: {
        taskKind: "analysis",
        runtime: { provider: "codex" },
        permissions: { sandbox: "workspace-write", approvalMode: "on-request" },
      },
    })).toThrow("analysis profile은 read-only");
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_presets").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_preset_versions").get()).toEqual({ count: 0 });

    const valid = service.createManual({
      projectId, userId: 1, name: "valid analysis", taskKind: "analysis",
      configSnapshot: { taskKind: "analysis", runtime: { provider: "codex" }, permissions: { sandbox: "read-only" } },
    });
    database.prepare("UPDATE agent_preset_versions SET config_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify({ taskKind: "analysis", runtime: { provider: "codex" }, permissions: { sandbox: "workspace-write" } }), valid.versions[0].id);
    expect(() => service.activate({ projectId, presetId: valid.id, versionId: valid.versions[0].id })).toThrow("analysis profile은 read-only");
    expect(database.prepare("SELECT status, active_version AS activeVersion FROM agent_presets WHERE id = ?").get(valid.id))
      .toEqual({ status: "draft", activeVersion: null });
    database.close();
  });

  it("기존 실험 preset은 implementation task kind로 그대로 조회된다", () => {
    const { database, projectId, service } = fixture();
    database.prepare("INSERT INTO agent_presets(id, project_id, name) VALUES ('legacy', ?, 'legacy')").run(projectId);
    database.prepare("INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json) VALUES ('legacy-v1', 'legacy', 1, '{}')").run();
    expect(service.list(projectId)[0]).toMatchObject({ id: "legacy", taskKind: "implementation" });
    database.close();
  });

  it("활성 프로젝트 전체의 필수 profile과 현재 지침·검증 준비 상태를 본문 없이 집계한다", () => {
    const { database, projectPath, projectId, service } = fixture();
    fs.writeFileSync(path.join(projectPath, "AGENTS.md"), "private project instructions");
    fs.writeFileSync(path.join(projectPath, "CLAUDE.md"), "@AGENTS.md\n");
    fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(service.readiness()).toMatchObject({ totalProjects: 1, readyProjects: 0, projects: [{ projectId, ready: false, taskKinds: [
      { taskKind: "analysis", issues: ["active_profile_missing"] }, { taskKind: "implementation", issues: ["active_profile_missing"] },
    ], detectedWarnings: [] }] });
    const config = (taskKind: string) => ({ taskKind, runtime: { provider: "codex" }, instructions: { files: ["AGENTS.md"] }, verification: { steps: [{ kind: "full_test", argv: ["npm", "test"] }] }, protectedActions: ["deploy"] });
    for (const taskKind of ["analysis", "implementation"] as const) {
      const profile = service.createManual({ projectId, userId: 1, name: taskKind, taskKind, configSnapshot: config(taskKind) });
      service.activate({ projectId, presetId: profile.id, versionId: profile.versions[0].id });
    }
    const ready = service.readiness() as any;
    expect(ready).toMatchObject({ totalProjects: 1, readyProjects: 1, projects: [{ projectName: "sample", ready: true, detectedScripts: ["test"] }] });
    expect(JSON.stringify(ready)).not.toContain("private project instructions");
    fs.writeFileSync(path.join(projectPath, "CLAUDE.md"), "Claude only");
    expect(service.readiness()).toMatchObject({ readyProjects: 0, projects: [{ detectedWarnings: ["CLAUDE.md import 불일치"] }] });
    database.close();
  });
});
