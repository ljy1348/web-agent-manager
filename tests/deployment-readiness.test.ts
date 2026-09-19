import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { expectedDatabaseShape, openDatabase } from "../src/server/core/database";
import { inspectDeploymentReadiness } from "../src/server/services/deployment-readiness";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-deploy-readiness-"));
  roots.push(dataDir);
  const database = openDatabase({ dataDir } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('sample', ?)").run(dataDir).lastInsertRowid);
  return { database, projectId };
}

describe("배포 재시작 preflight", () => {
  it("현재 schema와 유휴 running chat은 안전하며 검사를 위해 DB를 변경하지 않는다", () => {
    const { database, projectId } = fixture();
    database.prepare("INSERT INTO chats(project_id, provider, tmux_name, title, status, busy) VALUES (?, 'codex', 'idle-chat', 'idle', 'running', 0)").run(projectId);
    const before = database.serialize();
    const report = inspectDeploymentReadiness(database, { buildAvailable: true });
    expect(report).toMatchObject({ workloadSafeForRestart: true, backupRequired: false, blockers: [], database: { integrity: "ok", migrationRequired: false }, work: { busyOrTransitioningChats: 0 } });
    expect(report.database.missingTables).toEqual([]);
    expect(report.database.missingColumns).toEqual([]);
    expect(database.serialize().equals(before)).toBe(true);
    expect(Object.keys(expectedDatabaseShape()).length).toBeGreaterThan(30);
    database.close();
  });

  it("busy chat·진행 원장과 미적용 schema를 구분해 재시작을 차단한다", () => {
    const { database, projectId } = fixture();
    const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, tmux_name, title, status, busy) VALUES (?, 'codex', 'busy-chat', 'busy', 'running', 1)").run(projectId).lastInsertRowid);
    database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state) VALUES ('task-1', ?, ?, 'verifying')").run(chatId, projectId);
    database.prepare("INSERT INTO prompt_commands(id, chat_id, task_id, source, idempotency_key, request_fingerprint, content_hash, content_length, state) VALUES ('command-1', ?, 'task-1', 'web', 'key-1', 'fingerprint-1', 'hash-1', 1, 'dispatching')").run(chatId);
    database.prepare("DROP TABLE provider_shadow_turn_scans").run();
    const report = inspectDeploymentReadiness(database, { buildAvailable: false });
    expect(report.workloadSafeForRestart).toBe(false);
    expect(report.backupRequired).toBe(true);
    expect(report.blockers).toEqual(expect.arrayContaining(["production_build_missing", "busyOrTransitioningChats", "verifyingTasks", "inFlightPromptCommands"]));
    expect(report.database).toMatchObject({ integrity: "ok", migrationRequired: true, missingTables: ["provider_shadow_turn_scans"] });
    database.close();
  });

  it("5,000개 채팅에서도 read-only preflight를 1초 안에 계산한다", () => {
    const { database, projectId } = fixture();
    const insert = database.prepare("INSERT INTO chats(project_id, provider, tmux_name, title, status, busy) VALUES (?, 'codex', ?, 'stopped', 'stopped', 0)");
    database.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) insert.run(projectId, `stopped-${index}`);
    })();
    const started = performance.now();
    const report = inspectDeploymentReadiness(database, { buildAvailable: true });
    const elapsedMs = performance.now() - started;
    expect(report.workloadSafeForRestart).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
    database.close();
  });
});
