import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { createTaskBoardRouter } from "../src/server/routes/task-board-routes";
import { TaskBoardService } from "../src/server/services/task-board";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("작업 보드 HTTP API", () => {
  it("계획 저장→추천→명시 적용을 실제 Express에서 수행하고 감사에는 근거 원문을 복제하지 않는다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-task-board-http-")); roots.push(root);
    const config = loadConfig(); config.dataDir = root;
    const database = openDatabase(config);
    database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('HTTP 보드', '/workspace/http-board')").run().lastInsertRowid);
    const accountId = Number((database.prepare("SELECT id FROM agent_accounts WHERE provider = 'codex'").get() as { id: number }).id);
    const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title) VALUES (?, 'codex', ?, 'http_board', 'stopped', 'HTTP 채팅')").run(projectId, accountId).lastInsertRowid);
    database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, created_by, state) VALUES ('http-task', ?, ?, 1, 'needs_input')").run(chatId, projectId);
    const board = new TaskBoardService(database);
    const app = express(); app.use(express.json());
    app.use((request: AuthenticatedRequest, _response, next) => { request.authUser = { id: 1, username: "admin", role: "admin", access_scope: "standard" }; next(); });
    app.use("/api", createTaskBoardRouter(database, board));
    app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error.statusCode || 400).json({ error: error.message }));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      const initial = await (await fetch(`${base}/task-board`)).json() as any;
      expect(initial.columns.needs_input[0].goal).toBeNull();
      const plan = await fetch(`${base}/tasks/http-task/plan`, { method: "PATCH", headers: { "content-type": "application/json", "Idempotency-Key": "plan-http-1" }, body: JSON.stringify({ goal: "HTTP 목표", acceptanceCriteria: ["API 통과"], priority: 80 }) });
      expect(plan.status).toBe(200);
      expect((await plan.json() as any).columns.needs_input[0]).toMatchObject({ goal: "HTTP 목표", acceptanceCriteria: ["API 통과"], priority: 80 });
      const recommended = await fetch(`${base}/tasks/http-task/routing/recommend`, { method: "POST", headers: { "Idempotency-Key": "route-http-1" } });
      expect(recommended.status).toBe(201);
      const recommendation = (await recommended.json() as any).recommendation;
      expect(recommendation.candidates[0]).toMatchObject({ provider: expect.any(String), accountId: expect.any(Number), reasons: expect.any(Array) });
      expect(database.prepare("SELECT selected_provider FROM agent_tasks WHERE id = 'http-task'").get()).toEqual({ selected_provider: null });
      const selected = recommendation.candidates.find((candidate: any) => candidate.provider === "codex") || recommendation.candidates[0];
      const applied = await fetch(`${base}/tasks/http-task/routing/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recommendationId: recommendation.id, provider: selected.provider, accountId: selected.accountId }) });
      expect(applied.status).toBe(200);
      expect(await applied.json()).toMatchObject({ applied: true, queueState: expect.stringMatching(/queued|admitted/) });
      expect(database.prepare("SELECT selected_provider, selected_account_id FROM agent_tasks WHERE id = 'http-task'").get()).toEqual({ selected_provider: selected.provider, selected_account_id: selected.accountId });
      const audit = JSON.stringify(database.prepare("SELECT action, details FROM audit_logs WHERE action LIKE 'task.%' ORDER BY id").all());
      expect(audit).toContain("task.plan_update"); expect(audit).toContain("task.routing_recommend"); expect(audit).toContain("task.routing_apply");
      expect(audit).not.toContain("remainingPercent"); expect(audit).not.toContain("capability");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
    }
  });
});
