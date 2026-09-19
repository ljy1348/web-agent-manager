import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { CodexStructuredTransportService } from "../src/server/services/codex-structured-transport";
import type { CodexStructuredConnector } from "../src/server/providers/codex-structured-session";
import type { CodexAppServerNotification } from "../src/server/providers/codex-app-server";
import { SessionManager } from "../src/server/services/session-manager";
import { TaskCommandService } from "../src/server/services/task-command-service";
import { createProjectRouter } from "../src/server/routes/project-routes";
import { HistoryCache } from "../src/server/services/history-cache";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { setChatBusy } from "../src/server/core/chat-busy";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Codex structured transport HTTP integration", () => {
  it("느린 연결/ACK에서도 신규 채팅만 소유하고 동일 command를 한 번만 전달한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-structured-http-"));
    const dataDir = path.join(root, "data"); const projectPath = path.join(root, "project");
    fs.mkdirSync(dataDir); fs.mkdirSync(projectPath);
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = { rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0,
      publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false,
      taskLedgerEnabled: true, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } } as AppConfig;
    const database = openDatabase(config); cleanup.push(() => { database.close(); });
    database.prepare("INSERT INTO users(id,username,password_hash,role) VALUES (1,'admin','x','admin')").run();
    const projectId = Number(database.prepare("INSERT INTO projects(name,path) VALUES ('project',?)").run(projectPath).lastInsertRowid);
    const accounts = new AgentAccountService(config, database);
    const rpc: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let notify: ((notification: CodexAppServerNotification) => void) | undefined;
    const connector: CodexStructuredConnector = async (options) => {
      notify = options.onNotification;
      await wait(350);
      return { request: async (method, params) => {
        rpc.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-http" } };
        if (method === "turn/start") { await wait(350); return { turn: { id: "turn-http", status: "inProgress" } }; }
        return {};
      }, close: () => undefined };
    };
    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    const realtime = {
      broadcast: (type: string, payload: unknown) => broadcasts.push({ type, payload }),
      terminal: () => undefined,
      setTerminalHandlers: () => undefined,
    };
    const approvals = {
      setTerminalDecisionHandler: () => undefined,
      setTerminalLiveCheckHandler: () => undefined,
      awaitCodexAppServerDecision: async () => "decline" as const,
      closeChatApprovals: () => undefined,
    };
    const tasks = new TaskCommandService(database);
    let historySignals = 0;
    const structured = new CodexStructuredTransportService(database, accounts, approvals, undefined, {
      onStatus: (chatId, status, error) => {
        database.prepare("UPDATE chats SET status=?,last_error=? WHERE id=?").run(status, error, chatId);
        realtime.broadcast("chat_status", { chatId, status, error });
      },
      onBusy: (chatId, busy) => setChatBusy(database, realtime as never, chatId, busy),
      onEvent: (event) => tasks.observeProviderEvent(event),
      onHistorySignal: () => { historySignals += 1; },
    }, { enabled: true, cohort: "http-cohort", maxNewChats: 1, readiness: { snapshot: () => ({ readiness: { candidateEligible: true } }) }, connector });
    const adapter = { id: "codex", displayLabel: "Codex" } as ProviderAdapter;
    const sessions = new SessionManager(database, [adapter], realtime as never, approvals as never, { notify: async () => undefined }, accounts, undefined, undefined, structured);
    cleanup.push(() => sessions.close());

    const app = express(); app.use(express.json());
    app.use((request: Request & { authUser?: unknown }, _response, next) => { request.authUser = { id: 1, username: "admin", role: "admin" }; next(); });
    app.use(createProjectRouter(database, config, sessions, [adapter], accounts, new HistoryCache(), undefined, undefined, tasks));
    app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => response.status(400).json({ error: error instanceof Error ? error.message : String(error) }));
    const server = http.createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const createStarted = performance.now();
    const createdResponse = await fetch(`${base}/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, provider: "codex" }) });
    const created = await createdResponse.json();
    expect(createdResponse.status).toBe(201);
    expect(performance.now() - createStarted).toBeLessThan(500);
    expect(created.chat).toMatchObject({ interactive_transport: "app_server", transport_state: "connecting", transport_cohort: "http-cohort" });

    const send = () => fetch(`${base}/chats/${created.chat.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "structured-http-command" }, body: JSON.stringify({ text: "한 번만 실행" }),
    });
    const sendStarted = performance.now(); const first = await send(); const firstBody = await first.json();
    expect(first.status).toBe(202); expect(performance.now() - sendStarted).toBeLessThan(1_500);
    expect(firstBody).toMatchObject({ replayed: false, command: { state: "delivered" } });
    const replay = await send(); expect(await replay.json()).toMatchObject({ replayed: true, command: { id: firstBody.command.id } });
    expect(rpc.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(rpc.find((call) => call.method === "turn/start")?.params).toMatchObject({ clientUserMessageId: firstBody.command.id });
    expect(database.prepare("SELECT adapter,evidence_type,outcome FROM prompt_delivery_attempts").get()).toEqual({ adapter: "codex_app_server", evidence_type: "provider_turn_ack", outcome: "delivered" });
    expect(database.prepare("SELECT state,turn_id FROM codex_structured_delivery_receipts").get()).toEqual({ state: "accepted", turn_id: "turn-http" });

    notify?.({ method: "item/agentMessage/delta", params: { threadId: "thread-http", turnId: "turn-http", delta: "민감한 응답" } });
    notify?.({ method: "turn/completed", params: { threadId: "thread-http", turn: { id: "turn-http", status: "completed" } } });
    expect(database.prepare("SELECT busy FROM chats WHERE id=?").get(created.chat.id)).toEqual({ busy: 0 });
    expect(historySignals).toBeGreaterThan(0);
    expect(JSON.stringify(database.prepare("SELECT * FROM codex_structured_delivery_receipts").all())).not.toContain("민감한 응답");
  });
});
