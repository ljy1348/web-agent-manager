import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import {
  CodexStructuredPreDeliveryError,
  CodexStructuredTransportService,
  type CodexStructuredTransportCallbacks,
} from "../src/server/services/codex-structured-transport";
import type { CodexStructuredConnector } from "../src/server/providers/codex-structured-session";
import type { CodexAppServerNotification } from "../src/server/providers/codex-app-server";
import { PromptDeliveryUnknownError } from "../src/server/services/prompt-delivery";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-structured-transport-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  const database = openDatabase({ dataDir, homeDir: root } as AppConfig);
  const projectId = Number(database.prepare("INSERT INTO projects(name,path) VALUES ('p',?)").run(root).lastInsertRowid);
  const chat = (name: string, status = "starting") => Number(database.prepare(`INSERT INTO chats(
    project_id,provider,tmux_name,status,title
  ) VALUES (?,'codex',?,?,?)`).run(projectId, name, status, name).lastInsertRowid);
  return { root, database, projectId, chat, accounts: new AgentAccountService({ dataDir, homeDir: root } as AppConfig, database) };
}

function appServerHarness(options?: { connectError?: Error; turnError?: Error; threadId?: string }) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let notification: ((value: CodexAppServerNotification) => void) | undefined;
  let closed = 0;
  const connector: CodexStructuredConnector = async (input) => {
    notification = input.onNotification;
    if (options?.connectError) throw options.connectError;
    return {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: options?.threadId ?? "thread-1" } };
        if (method === "thread/resume") return { thread: { id: String(params?.threadId) } };
        if (method === "turn/start") {
          if (options?.turnError) throw options.turnError;
          return { turn: { id: "turn-1", status: "inProgress" } };
        }
        if (method === "turn/interrupt") return {};
        return {};
      },
      close: () => { closed += 1; },
    };
  };
  return { connector, calls, notify: (value: CodexAppServerNotification) => notification?.(value), closed: () => closed };
}

function service(input: ReturnType<typeof fixture>, connector: CodexStructuredConnector, options?: { eligible?: boolean; enabled?: boolean; cohort?: string; max?: number }) {
  const events: unknown[] = [];
  const busy: boolean[] = [];
  let historySignals = 0;
  const callbacks: CodexStructuredTransportCallbacks = {
    onStatus: (chatId, status, error) => input.database.prepare("UPDATE chats SET status=?,last_error=? WHERE id=?").run(status, error, chatId),
    onBusy: (_chatId, value) => { busy.push(value); },
    onEvent: (event) => { events.push(event); },
    onHistorySignal: () => { historySignals += 1; },
  };
  const approvals = { awaitCodexAppServerDecision: async () => "decline" as const, closeChatApprovals: () => undefined };
  const transport = new CodexStructuredTransportService(input.database, input.accounts, approvals, undefined, callbacks, {
    enabled: options?.enabled ?? true,
    cohort: options?.cohort ?? "cohort-a",
    maxNewChats: options?.max ?? 1,
    readiness: { snapshot: () => ({ readiness: { candidateEligible: options?.eligible ?? true } }) },
    connector,
    now: () => new Date("2026-09-13T01:02:03.000Z"),
  });
  return { transport, events, busy, historySignals: () => historySignals };
}

describe("Codex limited structured transport", () => {
  it("flag·cohort·quota·shadow gate가 모두 맞는 신규 채팅 하나만 원자 배정한다", () => {
    const input = fixture(); const fake = appServerHarness();
    const first = input.chat("first"); const second = input.chat("second");
    const ready = service(input, fake.connector, { max: 1 });
    expect(ready.transport.claimOrOwn(first)).toBe(true);
    expect(ready.transport.claimOrOwn(second)).toBe(false);
    expect(ready.transport.state(first)).toEqual({ transport: "app_server", state: "assigned", cohort: "cohort-a" });
    const off = service(input, fake.connector, { enabled: false, cohort: "off" });
    expect(off.transport.claimOrOwn(input.chat("off"))).toBe(false);
    const notReady = service(input, fake.connector, { eligible: false, cohort: "not-ready" });
    expect(notReady.transport.claimOrOwn(input.chat("not-ready"))).toBe(false);
    input.database.close();
  });

  it("thread와 command/turn ACK를 연결하고 본문 없이 terminal event까지 보존한다", async () => {
    const input = fixture(); const fake = appServerHarness(); const chatId = input.chat("candidate");
    const current = service(input, fake.connector);
    expect(current.transport.claimOrOwn(chatId)).toBe(true);
    const startedAt = performance.now();
    await current.transport.start(chatId);
    await expect(current.transport.send(chatId, "command-123", "private prompt")).resolves.toBe("private prompt");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(fake.calls).toEqual([
      { method: "thread/start", params: expect.objectContaining({ cwd: input.root, approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: false }) },
      { method: "turn/start", params: { threadId: "thread-1", clientUserMessageId: "command-123", input: [{ type: "text", text: "private prompt", text_elements: [] }] } },
    ]);
    expect(input.database.prepare("SELECT provider_session_id,status FROM chats WHERE id=?").get(chatId)).toEqual({ provider_session_id: "thread-1", status: "running" });
    expect(input.database.prepare(`SELECT command_id,thread_id,turn_id,state,accepted_at,error_code
      FROM codex_structured_delivery_receipts WHERE command_id='command-123'`).get()).toEqual({ command_id: "command-123", thread_id: "thread-1", turn_id: "turn-1", state: "accepted", accepted_at: "2026-09-13T01:02:03.000Z", error_code: null });
    fake.notify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "private answer" } });
    fake.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    expect(input.database.prepare("SELECT state,terminal_at FROM codex_structured_delivery_receipts WHERE command_id='command-123'").get()).toEqual({ state: "completed", terminal_at: "2026-09-13T01:02:03.000Z" });
    expect(current.historySignals()).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(input.database.prepare("SELECT * FROM codex_structured_transports").all()) + JSON.stringify(input.database.prepare("SELECT * FROM codex_structured_delivery_receipts").all())).not.toContain("private");
    expect(current.busy).toContain(true); expect(current.busy).toContain(false);
    input.database.close();
  });

  it("pinned profile의 read-only sandbox·승인·모델을 app-server thread에도 적용한다", async () => {
    const input = fixture(); const fake = appServerHarness(); const chatId = input.chat("profile-candidate");
    input.database.prepare("UPDATE chats SET preset_config_json=?,model=? WHERE id=?").run(JSON.stringify({
      taskKind: "analysis", runtime: { model: "profile-model" },
      permissions: { sandbox: "read-only", approvalMode: "never", additionalWritePaths: [] },
    }), "legacy-model", chatId);
    const current = service(input, fake.connector);
    expect(current.transport.claimOrOwn(chatId)).toBe(true);
    await current.transport.start(chatId);
    expect(fake.calls[0]).toEqual({ method: "thread/start", params: expect.objectContaining({
      cwd: input.root, model: "profile-model", approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
    }) });
    input.database.close();
  });

  it("app-server가 안전하게 적용하지 못하는 profile 옵션은 전달 전에 TUI fallback한다", async () => {
    const input = fixture(); const fake = appServerHarness(); const chatId = input.chat("unsupported-profile");
    input.database.prepare("UPDATE chats SET preset_config_json=? WHERE id=?").run(JSON.stringify({
      taskKind: "implementation", runtime: { reasoningEffort: "high" },
      permissions: { sandbox: "workspace-write", approvalMode: "on-request", additionalWritePaths: [] },
    }), chatId);
    const current = service(input, fake.connector);
    expect(current.transport.claimOrOwn(chatId)).toBe(true);
    await expect(current.transport.start(chatId)).rejects.toBeInstanceOf(CodexStructuredPreDeliveryError);
    expect(current.transport.state(chatId)).toMatchObject({ transport: "tui", state: "fallback_tui" });
    expect(fake.calls).toEqual([]);
    input.database.close();
  });

  it("thread 연결 실패까지만 TUI fallback 상태로 바꾸고 turn 요청 뒤 오류는 재전송 금지한다", async () => {
    const before = fixture(); const connectFailure = appServerHarness({ connectError: new Error("closed") }); const chatId = before.chat("before");
    const safe = service(before, connectFailure.connector); expect(safe.transport.claimOrOwn(chatId)).toBe(true);
    await expect(safe.transport.start(chatId)).rejects.toBeInstanceOf(CodexStructuredPreDeliveryError);
    expect(safe.transport.state(chatId)).toEqual({ transport: "tui", state: "fallback_tui", cohort: "cohort-a" });
    expect(before.database.prepare("SELECT COUNT(*) AS count FROM codex_structured_delivery_receipts").get()).toEqual({ count: 0 });
    before.database.close();

    const after = fixture(); const turnFailure = appServerHarness({ turnError: new Error("response lost") }); const afterChat = after.chat("after");
    const unsafe = service(after, turnFailure.connector); expect(unsafe.transport.claimOrOwn(afterChat)).toBe(true); await unsafe.transport.start(afterChat);
    await expect(unsafe.transport.send(afterChat, "command-lost", "do once")).rejects.toBeInstanceOf(PromptDeliveryUnknownError);
    expect(unsafe.transport.state(afterChat)).toMatchObject({ transport: "app_server", state: "delivery_unknown" });
    expect(after.database.prepare("SELECT state,error_code FROM codex_structured_delivery_receipts WHERE command_id='command-lost'").get()).toEqual({ state: "delivery_unknown", error_code: "app_server_error" });
    await expect(unsafe.transport.send(afterChat, "command-lost", "do once")).rejects.toThrow("자동 재시도");
    expect(turnFailure.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    after.database.close();
  });

  it("재시작 전 dispatching receipt를 delivery_unknown으로 복구하고 다시 보내지 않는다", () => {
    const input = fixture(); const fake = appServerHarness(); const chatId = input.chat("restart");
    input.database.prepare(`INSERT INTO codex_structured_transports(chat_id,cohort,state,assigned_at,updated_at)
      VALUES (?,'cohort-a','connecting',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(chatId);
    input.database.prepare(`INSERT INTO codex_structured_delivery_receipts(command_id,chat_id,state,created_at,updated_at)
      VALUES ('command-restart',?,'dispatching',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(chatId);
    const current = service(input, fake.connector);
    expect(current.transport.recoverInterruptedDeliveries()).toBe(1);
    expect(input.database.prepare("SELECT state,error_code FROM codex_structured_delivery_receipts").get()).toEqual({ state: "delivery_unknown", error_code: "server_restart_before_turn_ack" });
    expect(fake.calls).toEqual([]);
    input.database.close();
  });

  it("ACK 뒤 재시작도 완료로 추정하지 않고 확인 필요 상태로 잠근다", () => {
    const input = fixture(); const fake = appServerHarness(); const chatId = input.chat("restart-after-ack", "running");
    input.database.prepare(`INSERT INTO codex_structured_transports(
      chat_id,cohort,state,thread_id,current_turn_id,assigned_at,updated_at
    ) VALUES (?,'cohort-a','turn_accepted','thread-1','turn-1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(chatId);
    input.database.prepare(`INSERT INTO codex_structured_delivery_receipts(
      command_id,chat_id,thread_id,turn_id,state,created_at,updated_at
    ) VALUES ('command-accepted',?,'thread-1','turn-1','accepted',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(chatId);
    const current = service(input, fake.connector);

    expect(current.transport.recoverInterruptedDeliveries()).toBe(1);
    expect(current.transport.state(chatId)).toMatchObject({ transport: "app_server", state: "error" });
    expect(input.database.prepare("SELECT state,error_code FROM codex_structured_delivery_receipts").get())
      .toEqual({ state: "accepted", error_code: null });
    expect(input.database.prepare("SELECT status,busy FROM chats WHERE id=?").get(chatId)).toEqual({ status: "error", busy: 0 });
    expect(fake.calls).toEqual([]);
    expect(() => current.transport.stop(chatId)).not.toThrow();
    expect(current.transport.state(chatId).state).toBe("error");
    input.database.close();
  });
});
