import type { AgentAccountService } from "../src/server/services/agent-accounts";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import type { SessionManager } from "../src/server/services/session-manager";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { HistoryCache } from "../src/server/services/history-cache";
import { createProjectRouter } from "../src/server/routes/project-routes";
import type { GitWorkspaceService } from "../src/server/services/git-workspaces";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

// 채팅→프로젝트 조인 조회만 실제 값을 반환하고 나머지 쿼리(감사 로그 등)는 no-op으로 응답한다.
function stubDatabase(projectPath: string): AppDatabase {
  return {
    prepare: (sql: string) => {
      if (sql.includes("FROM chats c JOIN projects p")) return { get: () => ({ project_id: 1, project_path: projectPath }) };
      return { get: () => undefined, run: () => ({ changes: 0 }), all: () => [] };
    },
  } as unknown as AppDatabase;
}

describe("채팅 첨부 파일 API", () => {
  it("업로드한 파일을 프로젝트 폴더 안 전용 디렉터리에 저장하고 상대 경로를 반환한다", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-attach-"));
    const app = express();
    app.use((request: any, _response, next) => { request.authUser = { id: 1, username: "tester", role: "admin" }; next(); });
    app.use(createProjectRouter(stubDatabase(projectDir), {} as AppConfig, {} as SessionManager, [] as ProviderAdapter[], {} as AgentAccountService, new HistoryCache()));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const { port } = server.address() as AddressInfo;

    const form = new FormData();
    form.append("file", new Blob(["hello attachment"], { type: "text/plain" }), "note.txt");
    const response = await fetch(`http://127.0.0.1:${port}/chats/41/attachments`, { method: "POST", body: form });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0].name).toBe("note.txt");
    expect(body.uploads[0].path.startsWith(`.web-agent-manager-uploads${path.sep}41${path.sep}`)).toBe(true);
    const savedContent = fs.readFileSync(path.join(projectDir, body.uploads[0].path), "utf8");
    expect(savedContent).toBe("hello attachment");
  });

  it("첨부 업로드 전용 디렉터리가 프로젝트 밖 symlink이면 저장을 거부한다", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-attach-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-outside-"));
    fs.symlinkSync(outsideDir, path.join(projectDir, ".web-agent-manager-uploads"));
    const app = express();
    app.use((request: any, _response, next) => { request.authUser = { id: 1, username: "tester", role: "admin" }; next(); });
    app.use(createProjectRouter(stubDatabase(projectDir), {} as AppConfig, {} as SessionManager, [] as ProviderAdapter[], {} as AgentAccountService, new HistoryCache()));
    app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(400).json({ error: error instanceof Error ? error.message : "오류" });
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const { port } = server.address() as AddressInfo;

    const form = new FormData();
    form.append("file", new Blob(["escape"], { type: "text/plain" }), "note.txt");
    const response = await fetch(`http://127.0.0.1:${port}/chats/41/attachments`, { method: "POST", body: form });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "프로젝트 경로를 벗어났습니다." });
    expect(fs.readdirSync(outsideDir)).toEqual([]);
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("전용 worktree 채팅은 같은 상대 경로로 첨부 파일을 복제한다", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-attach-project-"));
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-attach-worktree-"));
    const gitWorkspaces = { workspacePath: () => worktreeDir } as unknown as GitWorkspaceService;
    const app = express();
    app.use((request: any, _response, next) => { request.authUser = { id: 1, username: "tester", role: "admin" }; next(); });
    app.use(createProjectRouter(stubDatabase(projectDir), {} as AppConfig, {} as SessionManager, [] as ProviderAdapter[], {} as AgentAccountService, new HistoryCache(), undefined, gitWorkspaces));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const { port } = server.address() as AddressInfo;

    const form = new FormData();
    form.append("file", new Blob(["worktree attachment"], { type: "text/plain" }), "note.txt");
    const response = await fetch(`http://127.0.0.1:${port}/chats/41/attachments`, { method: "POST", body: form });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(fs.readFileSync(path.join(projectDir, body.uploads[0].path), "utf8")).toBe("worktree attachment");
    expect(fs.readFileSync(path.join(worktreeDir, body.uploads[0].path), "utf8")).toBe("worktree attachment");
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });
});
