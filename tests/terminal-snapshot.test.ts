import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { createProjectRouter } from "../src/server/routes/project-routes";
import type { AgentAccountService } from "../src/server/services/agent-accounts";
import { HistoryCache } from "../src/server/services/history-cache";
import type { SessionManager, TerminalDiagnosticSnapshot } from "../src/server/services/session-manager";

let closeServer: (() => Promise<void>) | undefined;
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (cleanup.length) cleanup.pop()?.();
});

async function startServer(): Promise<{
  baseUrl: string;
  rootDir: string;
  dataDir: string;
  captureTerminalDiagnostic: ReturnType<typeof vi.fn>;
}> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-terminal-snapshot-"));
  const dataDir = path.join(rootDir, "data");
  const projectPath = path.join(rootDir, "project");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  const config: AppConfig = {
    rootDir, dataDir, homeDir: rootDir, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1:0", allowedRoots: [rootDir], sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('스냅샷', ?)").run(projectPath).lastInsertRowid);
  database.prepare(`
    INSERT INTO chats(id, project_id, provider, tmux_name, status, title, busy)
    VALUES (1, ?, 'codex', 'wam-snapshot-chat-1', 'running', '상태 조사', 1)
  `).run(projectId);

  const capturedAt = "2026-09-01T12:34:56.789Z";
  const diagnostic: TerminalDiagnosticSnapshot = {
    schemaVersion: 1,
    capturedAt,
    serverPid: 12345,
    chat: {
      id: 1, projectId, provider: "codex", title: "상태 조사", status: "running", busy: true,
      lastError: null, tmuxName: "wam-snapshot-chat-1", providerSessionId: "provider-session", historyFile: "/private/session.jsonl",
    },
    terminal: { attached: true, rows: 48, copyMode: false },
    classification: {
      isBusy: false,
      isReady: false,
      promptDraft: null,
      approval: { requestType: "terminal_approval", summary: "권한 요청" },
      permissionMode: "default",
    },
    pendingApprovals: [{ id: "approval-1", requestType: "terminal_approval", status: "pending", createdAt: capturedAt }],
    screen: "실제 터미널 원문\n권한을 허용하시겠습니까?",
  };
  const captureTerminalDiagnostic = vi.fn(() => diagnostic);
  const sessions = { captureTerminalDiagnostic } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use((request: Request & { authUser?: unknown }, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    next();
  });
  app.use(createProjectRouter(database, config, sessions, [], {} as AgentAccountService, new HistoryCache()));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  cleanup.push(() => { database.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, rootDir, dataDir, captureTerminalDiagnostic };
}

describe("터미널 스냅샷 API", () => {
  it("관리자 요청으로 원문 JSON을 비공개 0600 파일에 저장하고 첨부 다운로드한다", async () => {
    const { baseUrl, rootDir, captureTerminalDiagnostic } = await startServer();

    const createResponse = await fetch(`${baseUrl}/chats/1/terminal-snapshots`, { method: "POST" });
    const created = await createResponse.json() as {
      snapshot: { filename: string; storedPath: string; capturedAt: string; downloadUrl: string; classification: Record<string, unknown> };
    };

    expect(createResponse.status).toBe(201);
    expect(captureTerminalDiagnostic).toHaveBeenCalledWith(1);
    expect(created.snapshot).toMatchObject({
      capturedAt: "2026-09-01T12:34:56.789Z",
      classification: { isBusy: false, isReady: false, approvalRequestType: "terminal_approval", permissionMode: "default" },
    });
    expect(created.snapshot.filename).toMatch(/^chat-1-20260901123456789-[0-9a-f]{8}\.json$/);
    expect(created.snapshot).not.toHaveProperty("screen");

    const storedFile = path.join(rootDir, created.snapshot.storedPath);
    const saved = JSON.parse(fs.readFileSync(storedFile, "utf8")) as TerminalDiagnosticSnapshot;
    expect(saved.screen).toContain("실제 터미널 원문");
    expect(saved.classification.approval?.requestType).toBe("terminal_approval");
    expect(fs.statSync(storedFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(storedFile)).mode & 0o777).toBe(0o700);

    const downloadResponse = await fetch(`${baseUrl}${created.snapshot.downloadUrl}`);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-disposition")).toContain(created.snapshot.filename);
    expect((await downloadResponse.json()).screen).toBe(saved.screen);
  });

  it("다른 채팅 번호가 붙은 파일명과 없는 파일은 다운로드하지 않는다", async () => {
    const { baseUrl } = await startServer();
    const wrongChat = await fetch(`${baseUrl}/chats/1/terminal-snapshots/chat-2-20260901123456789-abcdef12.json`);
    const missing = await fetch(`${baseUrl}/chats/1/terminal-snapshots/chat-1-20260901123456789-abcdef12.json`);

    expect(wrongChat.status).toBe(404);
    expect(missing.status).toBe(404);
  });
});
