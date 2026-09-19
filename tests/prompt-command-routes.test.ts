import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAccountService } from "../src/server/services/agent-accounts";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { createProjectRouter } from "../src/server/routes/project-routes";
import { HistoryCache } from "../src/server/services/history-cache";
import { PromptDeliveryUnknownError } from "../src/server/services/prompt-delivery";
import type { SessionManager } from "../src/server/services/session-manager";

let closeServer: (() => Promise<void>) | undefined;
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
  while (cleanup.length) cleanup.pop()?.();
});

async function startServer(sendPrompt: ReturnType<typeof vi.fn>, deliveryContext = () => ({ adapter: "tui", evidenceType: "tui_submission_confirmation", supportsQueue: true })): Promise<{ base: string; database: AppDatabase; chatId: number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-prompt-command-route-"));
  const dataDir = path.join(root, "data");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  const config = {
    rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1,
    runtimeEnabled: false, taskLedgerEnabled: true, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig;
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('project', ?)").run(projectPath).lastInsertRowid);
  database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'prompt-route-chat', 'running', 'chat', 0)").run(projectId);
  const chatId = Number((database.prepare("SELECT id FROM chats").get() as { id: number }).id);
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const sessions = { sendPrompt, deliveryContext } as unknown as SessionManager;
  const app = express();
  app.use(express.json());
  app.use((request: Request & { authUser?: unknown }, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    next();
  });
  app.use(createProjectRouter(database, config, sessions, [], {} as AgentAccountService, new HistoryCache()));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : 400;
    response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, database, chatId };
}

describe("프롬프트 명령 HTTP 계약", () => {
  it("같은 Idempotency-Key 재요청은 같은 command를 반환하고 SessionManager를 한 번만 호출한다", async () => {
    const sendPrompt = vi.fn(async (..._args: unknown[]) => "메시지");
    const { base, chatId } = await startServer(sendPrompt);
    const request = () => fetch(`${base}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "http-command-key-1" },
      body: JSON.stringify({ text: "메시지" }),
    });

    const first = await request();
    const firstBody = await first.json();
    const replay = await request();
    const replayBody = await replay.json();

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(firstBody).toMatchObject({ accepted: true, replayed: false, command: { state: "delivered" } });
    expect(replayBody).toMatchObject({ accepted: true, replayed: true, command: { id: firstBody.command.id } });
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0][3]).toEqual({ trackedDelivery: true, commandId: firstBody.command.id });
  });

  it("같은 키의 다른 본문은 409이며 원래 명령을 재실행하지 않는다", async () => {
    const sendPrompt = vi.fn(async (chatId: number, text: string) => text);
    const { base, chatId } = await startServer(sendPrompt);
    const headers = { "content-type": "application/json", "Idempotency-Key": "http-command-key-2" };
    await fetch(`${base}/chats/${chatId}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "첫 메시지" }) });

    const collision = await fetch(`${base}/chats/${chatId}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "다른 메시지" }) });

    expect(collision.status).toBe(409);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("delivery_unknown을 202로 반환하고 조회·수동 reconcile·지표에 같은 상태를 노출한다", async () => {
    const sendPrompt = vi.fn(async () => { throw new PromptDeliveryUnknownError("제출 증거 없음"); });
    const { base, chatId } = await startServer(sendPrompt);
    const sent = await fetch(`${base}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "http-command-key-3" },
      body: JSON.stringify({ text: "불확실 메시지" }),
    });
    const receipt = await sent.json();

    expect(sent.status).toBe(202);
    expect(receipt).toMatchObject({ task: { state: "needs_input" }, command: { state: "delivery_unknown" } });
    const task = await (await fetch(`${base}/tasks/${receipt.task.id}`)).json();
    expect(task.commands[0].state).toBe("delivery_unknown");
    const metrics = await (await fetch(`${base}/admin/task-ledger-metrics`)).json();
    expect(metrics.summary).toMatchObject({ commands_total: 1, delivery_unknown_current: 1, agent_tasks_active: 1 });

    const reconciled = await fetch(`${base}/prompt-commands/${receipt.command.id}/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "reconcile-command-key-3" },
      body: JSON.stringify({ resolution: "delivered" }),
    });
    expect(await reconciled.json()).toMatchObject({ task: { state: "running" }, command: { state: "reconciled_delivered" } });
  });

  it("app-server ACK를 TUI 확인으로 위장하지 않고 delivery attempt에 기록한다", async () => {
    const sendPrompt = vi.fn(async (_chatId: number, text: string) => text);
    const { base, database, chatId } = await startServer(sendPrompt, () => ({ adapter: "codex_app_server", evidenceType: "provider_turn_ack", supportsQueue: false }));
    const sent = await fetch(`${base}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "http-command-key-app-server" },
      body: JSON.stringify({ text: "구조화 메시지" }),
    });
    const body = await sent.json();
    expect(sent.status).toBe(202);
    expect(body.command.state).toBe("delivered");
    expect(database.prepare("SELECT adapter,evidence_type,outcome FROM prompt_delivery_attempts").get()).toEqual({
      adapter: "codex_app_server", evidence_type: "provider_turn_ack", outcome: "delivered",
    });
  });
});
