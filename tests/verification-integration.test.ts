import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { createVerificationRouter } from "../src/server/routes/verification-routes";
import { TaskCommandService } from "../src/server/services/task-command-service";
import { VerificationService } from "../src/server/services/verification-service";

const roots: string[] = [];
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function createFixture(): { database: AppDatabase; dataDir: string; projectPath: string; taskId: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-verification-e2e-data-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-verification-e2e-project-"));
  roots.push(dataDir, projectPath);
  fs.mkdirSync(path.join(projectPath, "src"));
  fs.writeFileSync(path.join(projectPath, "src", "main.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectPath });
  execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: projectPath });
  execFileSync("git", ["config", "user.name", "QA"], { cwd: projectPath });
  execFileSync("git", ["add", "."], { cwd: projectPath });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: projectPath });
  fs.writeFileSync(path.join(projectPath, "src", "main.ts"), "export const value = 2;\n");

  const database = openDatabase({ dataDir } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'qa-admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('qa-project', ?)").run(projectPath).lastInsertRowid);
  database.prepare("INSERT INTO agent_presets(id, project_id, name, status, active_version) VALUES ('qa-profile', ?, 'qa-profile', 'active', 1)").run(projectId);
  const snapshot = {
    schemaVersion: 1,
    runtime: { provider: "codex" },
    verification: { steps: [
      { kind: "static", argv: [process.execPath, "-e", "console.log('static API_TOKEN=qa-secret')"], required: true },
      { kind: "focused_test", argv: [process.execPath, "-e", "console.log('focused ok')"], required: true, includePaths: ["src/**"] },
      { kind: "ui", argv: [process.execPath, "-e", "process.exit(9)"], required: true, includePaths: ["web/**"] },
    ] },
  };
  database.prepare("INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json) VALUES ('qa-profile-v1', 'qa-profile', 1, ?)").run(JSON.stringify(snapshot));
  const chatId = Number(database.prepare(`
    INSERT INTO chats(project_id, provider, tmux_name, status, title, preset_version_id, preset_config_json)
    VALUES (?, 'codex', 'qa-chat', 'running', 'qa-chat', 'qa-profile-v1', ?)
  `).run(projectId, JSON.stringify(snapshot)).lastInsertRowid);
  const task = new TaskCommandService(database).receive(chatId, "verify the change", { id: 1, username: "qa-admin", role: "admin" }, "qa-command");
  database.prepare("UPDATE agent_tasks SET state = 'running' WHERE id = ?").run(task.task.id);
  return { database, dataDir, projectPath, taskId: task.task.id };
}

async function serve(database: AppDatabase, service: VerificationService): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => { request.authUser = { id: 1, username: "qa-admin", role: "admin" }; next(); });
  app.use(createVerificationRouter(database, service));
  app.use((error: any, _request: any, response: any, _next: any) => response.status(error?.statusCode || 400).json({ error: error?.message || String(error) }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("verification gate 실제 통합 QA", () => {
  it("Git diff 선택부터 실제 process, artifact, HTTP 재검증과 변경 거부까지 연결한다", async () => {
    const { database, dataDir, projectPath, taskId } = createFixture();
    const service = new VerificationService(database, dataDir, os.homedir());
    const base = await serve(database, service);

    const firstResponse = await fetch(`${base}/tasks/${taskId}/verifications`, { method: "POST", headers: { "Idempotency-Key": "qa-first" } });
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json() as any).verification;
    expect(first.run).toMatchObject({ state: "passed", trigger: "manual", profile_version_id: "qa-profile-v1" });
    expect(first.steps.map((step: any) => [step.ordinal, step.kind, step.state])).toEqual([[1, "static", "passed"], [2, "focused_test", "passed"]]);
    expect(JSON.parse(first.run.summary_json).selection.skipped).toEqual([{ ordinal: 3, kind: "ui", reason: "no_changed_path_matched" }]);
    expect(database.prepare("SELECT state FROM agent_tasks WHERE id = ?").get(taskId)).toEqual({ state: "completed" });

    const artifactResponse = await fetch(`${base}/verification-artifacts/${first.artifacts[0].id}`);
    expect(artifactResponse.status).toBe(200);
    const artifact = await artifactResponse.text();
    expect(artifact).toContain("API_TOKEN=[REDACTED]");
    expect(artifact).not.toContain("qa-secret");

    const rerunResponse = await fetch(`${base}/verifications/${first.run.id}/rerun`, { method: "POST", headers: { "Idempotency-Key": "qa-rerun" } });
    expect(rerunResponse.status).toBe(202);
    const rerun = (await rerunResponse.json() as any).verification;
    expect(rerun.run).toMatchObject({ state: "passed", trigger: "reverification", source_run_id: first.run.id });
    expect(rerun.run.id).not.toBe(first.run.id);

    const replayResponse = await fetch(`${base}/verifications/${first.run.id}/rerun`, { method: "POST", headers: { "Idempotency-Key": "qa-rerun" } });
    expect((await replayResponse.json() as any).verification.run.id).toBe(rerun.run.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM verification_runs WHERE task_id = ?").get(taskId)).toEqual({ count: 2 });

    fs.writeFileSync(path.join(projectPath, "src", "main.ts"), "export const value = 3;\n");
    const changedResponse = await fetch(`${base}/verifications/${first.run.id}/rerun`, { method: "POST", headers: { "Idempotency-Key": "qa-rerun-after-change" } });
    expect(changedResponse.status).toBe(409);
    await expect(changedResponse.json()).resolves.toEqual({ error: "동일 commit과 diff에서만 다시 검증할 수 있습니다." });
    expect(database.prepare("SELECT COUNT(*) AS count FROM verification_runs WHERE task_id = ?").get(taskId)).toEqual({ count: 2 });

    const timeline = await fetch(`${base}/tasks/${taskId}/verifications`);
    expect((await timeline.json() as any).verifications).toHaveLength(2);
    database.close();
  });

  it("실제 Git·SQLite·HTTP·process 흐름에서 mock GitHub check를 같은 완료 gate와 UI 조회 API에 연결한다", async () => {
    const { database, dataDir, projectPath, taskId } = createFixture();
    execFileSync("git", ["add", "."], { cwd: projectPath });
    execFileSync("git", ["commit", "-m", "verified change"], { cwd: projectPath });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectPath, encoding: "utf8" }).trim();
    const githubReads: Array<{ cwd: string; number: number }> = [];
    const service = new VerificationService(database, dataDir, os.homedir(), undefined, undefined, 30, async (cwd, number) => {
      githubReads.push({ cwd, number });
      return { number, headSha, state: "passed", totalCount: 3, passedCount: 3, failedCount: 0, pendingCount: 0, unavailableCount: 0 };
    });
    const base = await serve(database, service);

    const response = await fetch(`${base}/tasks/${taskId}/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "qa-pr-gate" },
      body: JSON.stringify({ pullRequestNumber: 55 }),
    });
    expect(response.status).toBe(202);
    const verification = (await response.json() as any).verification;
    expect(verification.run).toMatchObject({ state: "passed", commit_hash: headSha, pull_request_number: 55, pull_request_head_sha: headSha });
    expect(verification.steps.map((step: any) => [step.kind, step.state])).toEqual([["static", "passed"]]);
    expect(JSON.parse(verification.run.summary_json)).toMatchObject({
      local: { state: "passed" },
      pullRequest: { number: 55, state: "passed", totalCount: 3, passedCount: 3 },
    });
    expect(githubReads).toEqual([{ cwd: projectPath, number: 55 }]);

    const chatId = (database.prepare("SELECT chat_id FROM agent_tasks WHERE id = ?").get(taskId) as { chat_id: number }).chat_id;
    const currentResponse = await fetch(`${base}/chats/${chatId}/current-task`);
    expect(currentResponse.status).toBe(200);
    const current = await currentResponse.json() as any;
    expect(current.task).toMatchObject({ id: taskId, state: "completed", profile_name: "qa-profile", profile_version: 1 });
    expect(current.verifications[0].run).toMatchObject({ id: verification.run.id, pull_request_number: 55 });
    database.close();
  });
});
