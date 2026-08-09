import { once } from "node:events";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import type { AppDatabase } from "../src/server/core/database";
import { createFileRouter } from "../src/server/routes/file-routes";
import { createGitRouter } from "../src/server/routes/git-routes";
import { createInstructionRouter } from "../src/server/routes/instruction-routes";
import { createProjectRouter } from "../src/server/routes/project-routes";
import { createAgentIntegrationRouter } from "../src/server/routes/agent-integration-routes";
import { createAgentDelegationRouter } from "../src/server/routes/agent-delegation-routes";
import { RealtimeHub } from "../src/server/services/realtime";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

// 테스트용 Express 서버를 띄우고 요청 URL을 반환한다.
async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

// 지정 역할을 가진 인증 사용자로 라우터를 호출할 앱을 만든다.
function appForRole(role: "admin" | "user"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.authUser = { id: role === "admin" ? 1 : 2, username: role, role };
    next();
  });
  return app;
}

describe("RBAC 가드", () => {
  it("일반 사용자의 관리자 전용 HTTP 변경 작업을 거부한다", async () => {
    const app = appForRole("user");
    app.use(createProjectRouter({} as AppDatabase, { allowedRoots: [] } as never, {} as never, [], {} as never, {} as never));
    app.use(createInstructionRouter({} as AppDatabase));
    app.use(createGitRouter({} as AppDatabase));
    app.use(createFileRouter({} as AppDatabase));
    app.use(createAgentIntegrationRouter({} as AppDatabase, {} as never));
    app.use(createAgentDelegationRouter({} as AppDatabase, {} as never));
    const baseUrl = await serve(app);

    const requests = [
      fetch(`${baseUrl}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1`, { method: "DELETE" }),
      fetch(`${baseUrl}/session-backups/backup-1/restore`, { method: "POST" }),
      fetch(`${baseUrl}/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/chats/1/model`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/chats/1/attachments`, { method: "POST" }),
      fetch(`${baseUrl}/chats/1/start`, { method: "POST" }),
      fetch(`${baseUrl}/chats/1/stop`, { method: "POST" }),
      fetch(`${baseUrl}/chats/1/interrupt`, { method: "POST" }),
      fetch(`${baseUrl}/chats/1/mode-cycle`, { method: "POST" }),
      fetch(`${baseUrl}/chats/1/backup`, { method: "POST" }),
      fetch(`${baseUrl}/chats/1`, { method: "DELETE" }),
      fetch(`${baseUrl}/instructions`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/instructions/unify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/git/branch`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/git/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/git/push`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/github/issue`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/github/pr`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/github/pr/2/review`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/github/run/3/rerun`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/projects/1/files/upload`, { method: "POST" }),
      fetch(`${baseUrl}/projects/1/files/download?path=README.md`),
      fetch(`${baseUrl}/projects/1/files/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(`${baseUrl}/agent-integrations/codex/install`, { method: "POST" }),
      fetch(`${baseUrl}/agent-integrations`),
      fetch(`${baseUrl}/projects/1/agent-delegations`),
      fetch(`${baseUrl}/agent-delegations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ];
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual(Array(responses.length).fill(403));
  });

  it("일반 사용자의 채팅 프롬프트 전송은 허용한다", async () => {
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    const app = appForRole("user");
    app.use(createProjectRouter({} as AppDatabase, {} as never, { sendPrompt } as never, [], {} as never, {} as never));
    const baseUrl = await serve(app);

    const response = await fetch(`${baseUrl}/chats/7/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "안녕" }),
    });

    expect(response.status).toBe(202);
    expect(sendPrompt).toHaveBeenCalledWith(7, "안녕", { id: 2, username: "user", role: "user" });
  });

  it("일반 사용자의 WebSocket 터미널 구독·raw 입력·리사이즈를 거부한다", async () => {
    const server = http.createServer();
    const inputHandler = vi.fn();
    const subscribeHandler = vi.fn();
    const resizeHandler = vi.fn();
    const database = {
      prepare: () => ({ get: () => ({ id: 2, username: "user", role: "user" }) }),
    } as unknown as AppDatabase;
    const hub = new RealtimeHub(server as Server, database);
    hub.setTerminalHandlers(inputHandler, subscribeHandler, undefined, resizeHandler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const { port } = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie: "web_agent_manager_session=test", origin: `http://127.0.0.1:${port}` },
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe_terminal", chatId: 1 }));
    const [subscribeError] = await once(socket, "message");
    socket.send(JSON.stringify({ type: "terminal_input", chatId: 1, data: "q" }));
    const [inputError] = await once(socket, "message");
    socket.send(JSON.stringify({ type: "terminal_resize", chatId: 1, rows: 58 }));
    const [resizeError] = await once(socket, "message");
    socket.close();

    expect(JSON.parse(subscribeError.toString()).payload.message).toBe("관리자만 터미널을 구독할 수 있습니다.");
    expect(JSON.parse(inputError.toString()).payload.message).toBe("관리자만 터미널에 입력할 수 있습니다.");
    expect(JSON.parse(resizeError.toString()).payload.message).toBe("관리자만 터미널을 조작할 수 있습니다.");
    expect(subscribeHandler).not.toHaveBeenCalled();
    expect(inputHandler).not.toHaveBeenCalled();
    expect(resizeHandler).not.toHaveBeenCalled();
  });
});
