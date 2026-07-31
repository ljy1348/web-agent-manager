import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { createAgentDelegationRouter } from "../src/server/routes/agent-delegation-routes";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporaryRoots: string[] = [];

// 실제 스키마가 적용된 임시 데이터베이스를 만든다.
function createDatabase(): { database: AppDatabase; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-delegation-route-"));
  temporaryRoots.push(root);
  return {
    root,
    database: openDatabase({
      rootDir: root,
      dataDir: root,
      homeDir: root,
      host: "127.0.0.1",
      port: 0,
      publicUrl: "",
      allowedRoots: ["/"],
      sessionTtlHours: 1,
      runtimeEnabled: false,
      slack: {},
      ntfy: { serverUrl: "https://ntfy.sh" },
    }),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("서브 에이전트 관리 API", () => {
  it("프로젝트 위임 상태를 조회하고 새 자식 세션 요청을 브리지에 전달한다", async () => {
    const { database, root } = createDatabase();
    database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'test', 'admin')").run();
    database.prepare("INSERT INTO projects(id, name, path) VALUES (1, 'sample', ?)").run(root);
    database.prepare("INSERT INTO chats(id, project_id, provider, tmux_name, status, title) VALUES (1, 1, 'codex', 'chat-1', 'running', '부모')").run();
    database.prepare("INSERT INTO chats(id, project_id, provider, tmux_name, status, title, busy) VALUES (2, 1, 'claude', 'chat-2', 'running', '자식', 1)").run();
    database.prepare(`
      INSERT INTO delegations(id, idempotency_key, source_chat_id, target_chat_id, prompt, status)
      VALUES ('delegation-1', 'key-1', 1, 2, '검증하세요.', 'sent')
    `).run();
    const execute = vi.fn().mockResolvedValue({ delegation: { id: "delegation-2", target_chat_id: 3, status: "sent" } });
    const app = express();
    app.use(express.json());
    app.use((request: AuthenticatedRequest, _response, next) => {
      request.authUser = { id: 1, username: "admin", role: "admin" };
      next();
    });
    app.use(createAgentDelegationRouter(database, { execute } as never));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const listResponse = await fetch(`${baseUrl}/projects/1/agent-delegations`);
    const list = await listResponse.json() as { delegations: Array<Record<string, unknown>> };
    const createResponse = await fetch(`${baseUrl}/agent-delegations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceChatId: 1, projectId: 1, provider: "claude", prompt: "병렬 작업", createNew: true, idempotencyKey: "ui-key" }),
    });

    expect(listResponse.status).toBe(200);
    expect(list.delegations[0]).toMatchObject({ id: "delegation-1", target_chat_id: 2, target_busy: 1, target_title: "자식" });
    expect(createResponse.status).toBe(201);
    expect(execute).toHaveBeenCalledWith({
      method: "delegation.send",
      params: {
        sourceChatId: 1,
        targetChatId: undefined,
        projectId: 1,
        provider: "claude",
        prompt: "병렬 작업",
        parentDelegationId: undefined,
        idempotencyKey: "ui-key",
        createNew: true,
      },
    });
    expect(database.prepare("SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1").get()).toMatchObject({ action: "agent.delegation_create" });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
});
