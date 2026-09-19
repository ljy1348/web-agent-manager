import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { createVerificationRouter } from "../src/server/routes/verification-routes";
import { VerificationService } from "../src/server/services/verification-service";

const roots: string[] = [];
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function populatedTimeline(runCount = 300, stepsPerRun = 8): { database: AppDatabase; dataDir: string; taskId: string; chatId: number } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-verification-performance-"));
  roots.push(dataDir);
  const database = openDatabase({ dataDir } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'performance-admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('performance', ?)").run(dataDir).lastInsertRowid);
  const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title) VALUES (?, 'codex', 'performance-chat', 'running', 'performance')").run(projectId).lastInsertRowid);
  const taskId = "performance-task";
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, created_by, state) VALUES (?, ?, ?, 1, 'completed')").run(taskId, chatId, projectId);
  const insertRun = database.prepare(`
    INSERT INTO verification_runs(id, task_id, idempotency_key, state, trigger, commit_hash, diff_hash, summary_json)
    VALUES (?, ?, ?, 'passed', ?, ?, ?, ?)
  `);
  const insertStep = database.prepare(`
    INSERT INTO verification_steps(id, run_id, ordinal, kind, cwd, timeout_ms, state, exit_code, duration_ms)
    VALUES (?, ?, ?, 'static', ?, 600000, 'passed', 0, 12)
  `);
  const insertArtifact = database.prepare(`
    INSERT INTO verification_artifacts(id, run_id, step_id, path, sha256, mime_type, size_bytes, redaction_status)
    VALUES (?, ?, ?, ?, ?, 'text/plain', 128, 'safe')
  `);
  database.transaction(() => {
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const runId = `run-${String(runIndex).padStart(4, "0")}`;
      insertRun.run(runId, taskId, `key-${runIndex}`, runIndex ? "reverification" : "manual", "a".repeat(40), "b".repeat(64), JSON.stringify({
        result: "passed", selection: { changedFileCount: 5, selected: [{ ordinal: 1, kind: "static", reason: "unconditional" }], skipped: [] },
      }));
      for (let ordinal = 1; ordinal <= stepsPerRun; ordinal += 1) {
        const stepId = `${runId}-step-${ordinal}`;
        const artifactId = `${runId}-artifact-${ordinal}`;
        insertStep.run(stepId, runId, ordinal, dataDir);
        insertArtifact.run(artifactId, runId, stepId, path.join(dataDir, `${artifactId}.log`), String(ordinal).repeat(64).slice(0, 64));
      }
    }
  })();
  return { database, dataDir, taskId, chatId };
}

async function serve(database: AppDatabase, service: VerificationService): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: any, _response, next) => { request.authUser = { id: 1, username: "performance-admin", role: "admin" }; next(); });
  app.use(createVerificationRouter(database, service));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("verification timeline 성능 QA", () => {
  it("300회·2400단계 원장에서도 배치 조회와 응답 상한을 유지한다", async () => {
    const { database, dataDir, taskId, chatId } = populatedTimeline();
    const service = new VerificationService(database, dataDir, os.homedir());

    const directStarted = performance.now();
    const current = service.currentForChat(chatId);
    const directDurationMs = performance.now() - directStarted;
    expect(current.verifications).toHaveLength(20);
    expect(current.hasMore).toBe(true);
    const latest = current.verifications[0] as any;
    expect(latest.steps).toHaveLength(8);
    expect(latest.artifacts).toHaveLength(8);
    expect(latest.steps[0]).not.toHaveProperty("cwd");
    expect(latest.steps[0]).not.toHaveProperty("command_json");
    expect(latest.artifacts[0]).not.toHaveProperty("path");
    expect(directDurationMs).toBeLessThan(500);

    const base = await serve(database, service);
    await fetch(`${base}/tasks/${taskId}/verifications?limit=100`);
    const durations: number[] = [];
    let payload: any;
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const started = performance.now();
      const response = await fetch(`${base}/tasks/${taskId}/verifications?limit=100`);
      durations.push(performance.now() - started);
      expect(response.status).toBe(200);
      payload = await response.json();
    }
    expect(payload.verifications).toHaveLength(100);
    expect(payload.verifications[0].steps).toHaveLength(8);
    expect(Math.max(...durations)).toBeLessThan(1_500);

    const currentStarted = performance.now();
    const currentResponse = await fetch(`${base}/chats/${chatId}/current-task`);
    const currentDurationMs = performance.now() - currentStarted;
    expect(currentResponse.status).toBe(200);
    await expect(currentResponse.json()).resolves.toMatchObject({ hasMore: true });
    expect(currentDurationMs).toBeLessThan(1_000);
    console.info("[verification-performance]", {
      runsInLedger: 300,
      stepsInLedger: 2_400,
      currentTaskDirectMs: Number(directDurationMs.toFixed(2)),
      timelineHttpMaxMs: Number(Math.max(...durations).toFixed(2)),
      currentTaskHttpMs: Number(currentDurationMs.toFixed(2)),
    });
    database.close();
  });
});
