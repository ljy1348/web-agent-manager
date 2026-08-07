import type { AgentAccountService } from "../src/server/services/agent-accounts";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import type { SessionManager } from "../src/server/services/session-manager";
import { HistoryCache } from "../src/server/services/history-cache";
import { createProjectRouter } from "../src/server/routes/project-routes";

let closeServer: (() => Promise<void>) | undefined;
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (cleanup.length) cleanup.pop()?.();
});

// 프로젝트 삭제 API를 검증할 관리자 세션의 임시 서버를 띄운다.
async function startServer(): Promise<{ base: string; database: AppDatabase; projectPath: string; homeDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-project-delete-"));
  const dataDir = path.join(root, "data");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    rootDir: root,
    homeDir: root,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:0",
    allowedRoots: [root],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const app = express();
  app.use(express.json());
  app.use((request: Request & { authUser?: unknown; trustedNetwork?: boolean }, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    request.trustedNetwork = request.headers["x-test-external"] !== "1";
    next();
  });
  app.use(createProjectRouter(database, config, {} as SessionManager, [], {} as AgentAccountService, new HistoryCache()));
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, database, projectPath, homeDir: root };
}

describe("프로젝트 삭제 API", () => {
  it("GET /projects는 web-agent-manager 설치 계정의 홈 디렉터리를 defaultPath로 내려준다", async () => {
    const { base, homeDir } = await startServer();
    const data = await (await fetch(`${base}/projects`)).json();
    expect(data.defaultPath).toBe(homeDir);
  });

  it("DELETE는 실제로 지우지 않고 active=0으로만 표시해 목록에서 숨긴다", async () => {
    const { base, database, projectPath } = await startServer();
    const created = await (await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    })).json();
    const projectId = created.project.id;

    const beforeDelete = await (await fetch(`${base}/projects`)).json();
    expect(beforeDelete.projects.map((item: { id: number }) => item.id)).toContain(projectId);

    const deleteResponse = await fetch(`${base}/projects/${projectId}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);

    const afterDelete = await (await fetch(`${base}/projects`)).json();
    expect(afterDelete.projects.map((item: { id: number }) => item.id)).not.toContain(projectId);

    const row = database.prepare("SELECT active FROM projects WHERE id = ?").get(projectId) as { active: number };
    expect(row.active).toBe(0);
  });

  it("이미 삭제된(active=0) 프로젝트를 다시 삭제하면 오류를 반환한다", async () => {
    const { base, projectPath } = await startServer();
    const created = await (await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    })).json();
    const projectId = created.project.id;
    await fetch(`${base}/projects/${projectId}`, { method: "DELETE" });

    const secondDelete = await fetch(`${base}/projects/${projectId}`, { method: "DELETE" });
    expect(secondDelete.status).toBe(400);
  });

  it("같은 경로로 재등록하면 소프트 삭제된 프로젝트가 다시 목록에 나타난다", async () => {
    const { base, projectPath } = await startServer();
    const created = await (await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    })).json();
    const projectId = created.project.id;
    await fetch(`${base}/projects/${projectId}`, { method: "DELETE" });

    await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });

    const afterReadd = await (await fetch(`${base}/projects`)).json();
    expect(afterReadd.projects.map((item: { id: number }) => item.id)).toContain(projectId);
  });

  it("외부 네트워크에서는 프로젝트 삭제를 거부한다", async () => {
    const { base, database } = await startServer();
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('삭제 제한', '/tmp/deny')").run().lastInsertRowid);

    const response = await fetch(`${base}/projects/${projectId}`, { method: "DELETE", headers: { "x-test-external": "1" } });

    expect(response.status).toBe(403);
    expect((database.prepare("SELECT active FROM projects WHERE id = ?").get(projectId) as { active: number }).active).toBe(1);
  });
});
