import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { openDatabase } from "../src/server/core/database";
import { createGitRouter } from "../src/server/routes/git-routes";
import { GitDataCache } from "../src/server/services/git-cache";
import { GitHunkReviewService } from "../src/server/services/git-hunk-review";
import type { GithubAutoMergeService } from "../src/server/services/github-auto-merge";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function harness(trusted = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-pr-auto-route-"));
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
  const database = openDatabase({ rootDir: root, homeDir: root, dataDir, allowedRoots: [root] } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'project', ?)").run(root);
  database.prepare("INSERT INTO chats(id, project_id, provider, tmux_name, title) VALUES (11, 1, 'codex', 'chat-11', 'chat')").run();
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state) VALUES ('task-11', 11, 1, 'running')").run();
  const snapshot = { number: 7, state: "OPEN", isDraft: false, headRefOid: "a".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", autoMergeEnabled: true, checkSummary: { number: 7, headSha: "a".repeat(40), state: "pending", totalCount: 2, passedCount: 1, pendingCount: 1, failedCount: 0, unavailableCount: 0 } } as any;
  const service = { set: vi.fn().mockResolvedValue(snapshot), read: vi.fn().mockResolvedValue(snapshot) };
  const app = express(); app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => { request.authUser = { id: 1, username: "admin", role: "admin" }; request.trustedNetwork = trusted; next(); });
  app.use("/api", createGitRouter(database, undefined, new GitDataCache(), new GitHunkReviewService(), service as unknown as GithubAutoMergeService));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(Number((error as any)?.statusCode) || 400).json({ error: error instanceof Error ? error.message : "오류" }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, service, root, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("조건부 자동 merge API", () => {
  it("head pin과 설정만 service에 넘기고 감사·task event에는 요약만 남긴다", async () => {
    const value = await harness();
    const response = await fetch(`${value.base}/api/projects/1/github/pr/7/auto-merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, expectedHeadSha: "a".repeat(40), method: "squash", deleteBranch: true, confirm: true, chatId: 11, extraCommand: "--admin" }) });
    expect(response.status).toBe(200);
    expect(value.service.set).toHaveBeenCalledWith(value.root, 7, { enabled: true, expectedHeadSha: "a".repeat(40), method: "squash", deleteBranch: true });
    const audit = value.database.prepare("SELECT action, details FROM audit_logs ORDER BY id DESC LIMIT 1").get() as { action: string; details: string };
    expect(audit.action).toBe("github.pr.auto_merge_enable"); expect(audit.details).not.toContain("extraCommand");
    const event = value.database.prepare("SELECT type, payload_json FROM agent_task_events WHERE task_id = 'task-11'").get() as { type: string; payload_json: string };
    expect(event.type).toBe("github.pr_auto_merge_enabled");
    expect(JSON.parse(event.payload_json)).toEqual({ number: 7, headSha: "a".repeat(40), checkState: "pending", totalChecks: 2 });
  });

  it("신뢰하지 않은 접속은 service 호출 전에 거부한다", async () => {
    const value = await harness(false);
    const response = await fetch(`${value.base}/api/projects/1/github/pr/7/auto-merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, expectedHeadSha: "a".repeat(40), confirm: true }) });
    expect(response.status).toBe(403); expect(value.service.set).not.toHaveBeenCalled();
  });
});
