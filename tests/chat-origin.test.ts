import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import type { AgentAccountService } from "../src/server/services/agent-accounts";
import type { SessionManager } from "../src/server/services/session-manager";
import { HistoryCache } from "../src/server/services/history-cache";
import { createProjectRouter } from "../src/server/routes/project-routes";
import { AgentBridge } from "../src/server/services/agent-bridge";
import type { ProviderAdapter } from "../src/server/providers/provider";

let closeServer: (() => Promise<void>) | undefined;
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (cleanup.length) cleanup.pop()?.();
});

// 채팅 origin 목록/단건 API만 검증할 최소 서버를 띄운다.
async function startServer(sendPrompt?: SessionManager["sendPrompt"]): Promise<{
  base: string;
  database: AppDatabase;
  dataDir: string;
  projectId: number;
  sent: Array<{ chatId: number; text: string; user: unknown }>;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-chat-origin-"));
  const dataDir = path.join(root, "data");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('샘플', ?)").run(projectPath).lastInsertRowid);
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const sent: Array<{ chatId: number; text: string; user: unknown }> = [];
  const accounts = {
    requireForProvider: (provider: string) => ({ id: 1, provider, label: "기본", config_dir: null }),
  } as unknown as AgentAccountService;
  const sessions = {
    start: () => undefined,
    sendPrompt: sendPrompt ?? (async (chatId: number, text: string, user: unknown) => {
      sent.push({ chatId, text, user });
      return text;
    }),
  } as unknown as SessionManager;

  const app = express();
  app.use(express.json());
  app.use((request: Request & { authUser?: unknown; trustedNetwork?: boolean }, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    request.trustedNetwork = true;
    next();
  });
  app.use(createProjectRouter(database, config, sessions, [
    { id: "codex", displayLabel: "Codex" }, { id: "claude", displayLabel: "Claude" },
  ] as never, accounts, new HistoryCache()));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, database, dataDir, projectId, sent };
}

// 위임 브리지를 실제 스키마 DB 위에서 돌린다.
function createBridge(database: AppDatabase, dataDir: string): {
  bridge: AgentBridge;
  started: number[];
  sent: Array<{ chatId: number; text: string; user: unknown }>;
} {
  const started: number[] = [];
  const sent: Array<{ chatId: number; text: string; user: unknown }> = [];
  const bridge = new AgentBridge({
    database,
    adapters: [
      { id: "codex", displayLabel: "Codex" },
      { id: "claude", displayLabel: "Claude" },
    ] as unknown as ProviderAdapter[],
    historyCache: {} as HistoryCache,
    sessions: {
      start: (chatId: number) => { started.push(chatId); },
      sendPrompt: async (chatId: number, text: string, user: unknown) => { sent.push({ chatId, text, user }); },
    } as unknown as Pick<SessionManager, "start" | "sendPrompt">,
    socketPath: path.join(dataDir, "web-agent-manager-agent.sock"),
  });
  return { bridge, started, sent };
}

describe("위임 채팅 origin", () => {
  it("기존 채팅은 origin이 user이고 누락 컬럼은 기본값 user로 채워진다", async () => {
    const { database, projectId } = await startServer();
    database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title) VALUES (?, 'codex', 'chat-legacy', 'running', '기존')").run(projectId);
    const row = database.prepare("SELECT origin FROM chats WHERE tmux_name = 'chat-legacy'").get() as { origin: string };
    expect(row.origin).toBe("user");
    expect(database.prepare("PRAGMA table_info(chats)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "origin" }),
    ]));
  });

  it("위임으로 만든 채팅은 /chats 목록에 없고 단건 조회·전송은 된다", async () => {
    const { base, database, projectId, sent } = await startServer();
    const userChatId = Number(database.prepare(
      "INSERT INTO chats(project_id, provider, tmux_name, status, title, origin) VALUES (?, 'codex', 'chat-user', 'running', '사용자', 'user')",
    ).run(projectId).lastInsertRowid);
    const delegatedId = Number(database.prepare(
      "INSERT INTO chats(project_id, provider, tmux_name, status, title, origin) VALUES (?, 'claude', 'chat-delegated', 'running', '자식', 'delegation')",
    ).run(projectId).lastInsertRowid);

    const list = await (await fetch(`${base}/chats?projectId=${projectId}`)).json() as { chats: Array<{ id: number }> };
    const all = await (await fetch(`${base}/chats`)).json() as { chats: Array<{ id: number }> };
    const single = await fetch(`${base}/chats/${delegatedId}`);
    const messages = await fetch(`${base}/chats/${delegatedId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "직접 이어서 작업하세요." }),
    });

    expect(list.chats.map((chat) => chat.id)).toEqual([userChatId]);
    expect(all.chats.map((chat) => chat.id)).toEqual([userChatId]);
    expect(single.status).toBe(200);
    expect((await single.json()).chat).toMatchObject({ id: delegatedId, origin: "delegation" });
    expect(messages.status).toBe(202);
    expect(sent).toEqual([expect.objectContaining({ chatId: delegatedId, text: "직접 이어서 작업하세요.", user: expect.objectContaining({ id: 1 }) })]);
  });

  it("createTargetChat으로 만든 채팅만 delegation이고 기존 targetChatId는 목록에 남는다", async () => {
    const { base, database, dataDir, projectId } = await startServer();
    database.prepare(
      "INSERT INTO chats(id, project_id, provider, tmux_name, status, title) VALUES (1, ?, 'codex', 'chat-1', 'running', '부모')",
    ).run(projectId);
    database.prepare(
      "INSERT INTO chats(id, project_id, provider, tmux_name, status, title) VALUES (2, ?, 'claude', 'chat-2', 'running', '기존')",
    ).run(projectId);
    const { bridge } = createBridge(database, dataDir);

    const created = await bridge.execute({
      method: "delegation.send",
      params: {
        sourceChatId: 1,
        projectId,
        provider: "claude",
        prompt: "새 자식에서 검증하세요.",
        idempotencyKey: "new-child",
        createNew: true,
      },
    }) as { delegation: { target_chat_id: number } };
    const reused = await bridge.execute({
      method: "delegation.send",
      params: {
        sourceChatId: 1,
        targetChatId: 2,
        prompt: "기존 채팅에서 이어서 하세요.",
        idempotencyKey: "reuse-existing",
      },
    }) as { delegation: { target_chat_id: number } };

    const createdOrigin = database.prepare("SELECT origin FROM chats WHERE id = ?").get(created.delegation.target_chat_id) as { origin: string };
    const reusedOrigin = database.prepare("SELECT origin FROM chats WHERE id = ?").get(2) as { origin: string };
    const list = await (await fetch(`${base}/chats?projectId=${projectId}`)).json() as { chats: Array<{ id: number }> };

    expect(created.delegation.target_chat_id).not.toBe(2);
    expect(createdOrigin.origin).toBe("delegation");
    expect(reused.delegation.target_chat_id).toBe(2);
    expect(reusedOrigin.origin).toBe("user");
    expect(list.chats.map((chat) => chat.id).sort()).toEqual([1, 2]);
    expect(list.chats.map((chat) => chat.id)).not.toContain(created.delegation.target_chat_id);
  });

  it("user로 승격된 위임 채팅은 목록에 다시 나오고 자동 입력 채팅은 숨겨진 채 남는다", async () => {
    const { base, database, projectId } = await startServer();
    const userChatId = Number(database.prepare(
      "INSERT INTO chats(project_id, provider, tmux_name, status, title, origin) VALUES (?, 'codex', 'chat-user', 'running', '사용자', 'user')",
    ).run(projectId).lastInsertRowid);
    const promotedId = Number(database.prepare(
      "INSERT INTO chats(project_id, provider, tmux_name, status, title, origin) VALUES (?, 'claude', 'chat-promoted', 'running', '승격', 'delegation')",
    ).run(projectId).lastInsertRowid);
    const autoId = Number(database.prepare(
      "INSERT INTO chats(project_id, provider, tmux_name, status, title, origin) VALUES (?, 'claude', 'chat-auto', 'running', '자동', 'delegation')",
    ).run(projectId).lastInsertRowid);

    database.prepare("UPDATE chats SET origin = 'user' WHERE id = ?").run(promotedId);
    const list = await (await fetch(`${base}/chats?projectId=${projectId}`)).json() as { chats: Array<{ id: number }> };

    expect(list.chats.map((chat) => chat.id).sort()).toEqual([userChatId, promotedId].sort());
    expect(list.chats.map((chat) => chat.id)).not.toContain(autoId);
  });
});

describe("전체 프로젝트 실행 중 채팅 목록(#100)", () => {
  it("scope=active는 프로젝트와 상관없이 실행 중·작업 중·리밋 대기 사용자 채팅만 프로젝트 이름과 함께 준다", async () => {
    const { base, database, projectId } = await startServer();
    const otherProjectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('다른 프로젝트', '/tmp/wam-other-project')").run().lastInsertRowid);
    const inactiveProjectId = Number(database.prepare("INSERT INTO projects(name, path, active) VALUES ('정리한 프로젝트', '/tmp/wam-inactive-project', 0)").run().lastInsertRowid);
    const insert = database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, origin) VALUES (?, 'claude', ?, ?, ?, ?, ?)");
    const add = (project: number, status: string, title: string, busy = 0, origin = "user") => Number(insert.run(project, `wam-active-${title}`, status, title, busy, origin).lastInsertRowid);
    const running = add(projectId, "running", "실행 중");
    const otherBusy = add(otherProjectId, "running", "다른 프로젝트 작업 중", 1);
    const waiting = add(otherProjectId, "stopped", "리밋 대기");
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider) VALUES (?, 'claude')").run(waiting);
    add(projectId, "stopped", "종료");
    add(projectId, "running", "위임 자식", 0, "delegation");
    add(inactiveProjectId, "running", "정리한 프로젝트 채팅");

    const response = await fetch(`${base}/chats?scope=active`);
    const data = await response.json() as { chats: Array<{ id: number; project_name: string; rate_limit_waiting: number }> };

    expect(data.chats.map((chat) => chat.id).sort((a, b) => a - b)).toEqual([running, otherBusy, waiting].sort((a, b) => a - b));
    expect(data.chats.find((chat) => chat.id === otherBusy)?.project_name).toBe("다른 프로젝트");
    expect(data.chats.find((chat) => chat.id === running)?.project_name).toBe("샘플");
    expect(data.chats.find((chat) => chat.id === waiting)?.rate_limit_waiting).toBe(1);
  });
});
