import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { PromptDeliveryUnknownError } from "../src/server/services/prompt-delivery";
import { IdempotencyConflictError, TaskCommandService } from "../src/server/services/task-command-service";

const temporaryDirectories: string[] = [];

function buildFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-task-command-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-task-project-"));
  temporaryDirectories.push(dataDir, projectPath);
  const config = { dataDir } as AppConfig;
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('project', ?, 'manual')").run(projectPath);
  const projectId = Number((database.prepare("SELECT id FROM projects").get() as { id: number }).id);
  database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'task-command-chat', 'running', 'chat', 0)").run(projectId);
  const chatId = Number((database.prepare("SELECT id FROM chats").get() as { id: number }).id);
  return { config, database, service: new TaskCommandService(database), chatId, user: { id: 1, username: "admin", role: "admin" as const } };
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("일반 프롬프트 명령 원장", () => {
  it("같은 멱등 키 재요청은 한 번만 dispatch하고 기존 receipt를 반환한다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const dispatch = vi.fn(async () => "전달 본문");

    const first = await service.receiveAndDispatch(chatId, "중복되면 안 되는 메시지", user, "command-key-0001", dispatch);
    const replay = await service.receiveAndDispatch(chatId, "중복되면 안 되는 메시지", user, "command-key-0001", dispatch);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(first.command.state).toBe("delivered");
    expect(replay).toMatchObject({ replayed: true, task: { id: first.task.id }, command: { id: first.command.id, state: "delivered" } });
    const events = database.prepare("SELECT sequence, type FROM agent_task_events WHERE task_id = ? ORDER BY sequence").all(first.task.id);
    expect(events).toEqual([
      { sequence: 1, type: "task.created" },
      { sequence: 2, type: "prompt.received" },
      { sequence: 3, type: "prompt.dispatching" },
      { sequence: 4, type: "prompt.delivered" },
    ]);
    expect(service.metrics()).toMatchObject({ summary: { commands_total: 1, idempotent_replays_total: 1 } });
    database.close();
  });

  it("같은 키에 다른 본문을 붙이면 충돌로 거부하고 원문은 DB에 저장하지 않는다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const secret = "원장에 평문으로 남아서는 안 되는 비밀 메시지";
    await service.receiveAndDispatch(chatId, secret, user, "command-key-0002", async () => secret);

    expect(() => service.receive(chatId, "다른 메시지", user, "command-key-0002")).toThrow(IdempotencyConflictError);
    const command = database.prepare("SELECT * FROM prompt_commands").get() as Record<string, unknown>;
    const events = database.prepare("SELECT payload_json FROM agent_task_events").all();
    expect(JSON.stringify({ command, events })).not.toContain(secret);
    expect(command.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(command.content_length).toBe(secret.length);
    database.close();
  });

  it("제출 ACK가 모호하면 자동 실패로 축소하지 않고 확인 필요 상태를 보존한다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const receipt = await service.receiveAndDispatch(chatId, "확인이 필요한 메시지", user, "command-key-0003", async () => {
      throw new PromptDeliveryUnknownError("ACK를 확인하지 못함");
    });

    expect(receipt).toMatchObject({ task: { state: "needs_input" }, command: { state: "delivery_unknown" } });
    expect(database.prepare("SELECT outcome, error FROM prompt_delivery_attempts").get()).toEqual({ outcome: "delivery_unknown", error: "ACK를 확인하지 못함" });
    database.close();
  });

  it("늦게 나타난 JSONL user turn으로 delivery_unknown을 자동 조정한다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const deliveredText = "CLI에 실제로 들어간 변환 메시지";
    const hash = crypto.createHash("sha256").update(deliveredText).digest("hex");
    const receipt = await service.receiveAndDispatch(chatId, "원래 웹 메시지", user, "command-key-0006", async () => {
      throw new PromptDeliveryUnknownError("늦은 ACK", hash);
    });

    const count = service.observeHistoryMessages(chatId, [{
      id: "provider-user-turn-1",
      role: "user",
      content: deliveredText,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    }]);

    expect(count).toBe(1);
    expect(database.prepare("SELECT state, last_error FROM prompt_commands WHERE id = ?").get(receipt.command.id)).toEqual({ state: "reconciled_delivered", last_error: null });
    expect(database.prepare("SELECT evidence_type, outcome FROM prompt_delivery_attempts WHERE command_id = ?").get(receipt.command.id)).toEqual({ evidence_type: "jsonl_user_message", outcome: "delivered" });
    database.close();
  });

  it("작업 중 follow-up은 queued로 구분한다", async () => {
    const { database, service, chatId, user } = buildFixture();
    database.prepare("UPDATE chats SET busy = 1 WHERE id = ?").run(chatId);

    const receipt = await service.receiveAndDispatch(chatId, "후속 입력", user, "command-key-0004", async () => "후속 입력");

    expect(receipt.command.state).toBe("queued");
    expect(database.prepare("SELECT type FROM agent_task_events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1").get(receipt.task.id)).toEqual({ type: "prompt.queued" });
    database.close();
  });

  it("구조화 전달 불명은 명시적 미전달 확인 뒤에만 TUI fallback을 연다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const receipt = await service.receiveAndDispatch(chatId, "한 번만 실행", user, "structured-unknown", async () => {
      throw new PromptDeliveryUnknownError("ACK 유실", "hash");
    });
    database.prepare(`INSERT INTO codex_structured_transports(
      chat_id,cohort,state,thread_id,last_command_id,assigned_at,updated_at
    ) VALUES (?,'qa','delivery_unknown','thread-1',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(chatId, receipt.command.id);
    database.prepare(`INSERT INTO codex_structured_delivery_receipts(
      command_id,chat_id,thread_id,state,error_code,created_at,updated_at
    ) VALUES (?,?,'thread-1','delivery_unknown','timeout',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(receipt.command.id, chatId);

    service.reconcile(receipt.command.id, "failed", "operator-confirmed-not-delivered");

    expect(database.prepare("SELECT state,fallback_reason FROM codex_structured_transports WHERE chat_id=?").get(chatId))
      .toEqual({ state: "fallback_tui", fallback_reason: "manual_not_delivered_reconciliation" });
    expect(database.prepare("SELECT state,error_code FROM codex_structured_delivery_receipts WHERE command_id=?").get(receipt.command.id))
      .toEqual({ state: "failed", error_code: "manually_confirmed_not_delivered" });
    database.close();
  });

  it("늦은 history 증거 뒤 명시적 검토로 구조화 thread를 재개 가능 상태로 만든다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const receipt = await service.receiveAndDispatch(chatId, "기록으로 확인", user, "structured-history", async () => {
      throw new PromptDeliveryUnknownError("ACK 유실", "hash");
    });
    database.prepare(`INSERT INTO codex_structured_transports(
      chat_id,cohort,state,thread_id,last_command_id,assigned_at,updated_at
    ) VALUES (?,'qa','delivery_unknown','thread-2',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(chatId, receipt.command.id);
    database.prepare(`INSERT INTO codex_structured_delivery_receipts(
      command_id,chat_id,thread_id,state,error_code,created_at,updated_at
    ) VALUES (?,?,'thread-2','delivery_unknown','timeout',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(receipt.command.id, chatId);

    expect(service.observeHistoryMessages(chatId, [{
      id: "provider-user-structured", role: "user", content: "기록으로 확인", createdAt: new Date(Date.now() + 1_000).toISOString(),
    }])).toBe(1);
    expect(database.prepare("SELECT state,error_code FROM codex_structured_transports WHERE chat_id=?").get(chatId))
      .toEqual({ state: "error", error_code: "history_confirmed_delivered_requires_session_review" });

    service.reconcile(receipt.command.id, "delivered", "operator-reviewed-session");
    expect(database.prepare("SELECT state,current_turn_id,error_code FROM codex_structured_transports WHERE chat_id=?").get(chatId))
      .toEqual({ state: "stopped", current_turn_id: null, error_code: null });
    database.close();
  });

  it("JSONL started가 dispatch 응답보다 먼저 와도 상태를 delivered로 되돌리지 않는다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const text = "빠르게 기록된 입력";

    const receipt = await service.receiveAndDispatch(chatId, text, user, "command-key-0007", async () => {
      expect(service.observeHistoryMessages(chatId, [{
        id: "fast-provider-turn",
        role: "user",
        content: text,
        createdAt: new Date(Date.now() + 1_000).toISOString(),
      }])).toBe(1);
      return text;
    });

    expect(receipt.command.state).toBe("started");
    expect(database.prepare("SELECT type FROM agent_task_events WHERE task_id = ? ORDER BY sequence").all(receipt.task.id)).toEqual([
      { type: "task.created" },
      { type: "prompt.received" },
      { type: "prompt.dispatching" },
      { type: "prompt.delivered" },
      { type: "prompt.started" },
    ]);
    database.close();
  });

  it("UserPromptSubmit 정규화 hook이 dispatch 중 command를 started로 확정한다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const receipt = await service.receiveAndDispatch(chatId, "hook이 확인한 입력", user, "command-key-0008", async () => {
      expect(service.observeProviderEvent({
        schemaVersion: 1,
        id: "hook-event-1",
        provider: "codex",
        chatId,
        sessionId: "session-1",
        turnId: "turn-1",
        type: "prompt.started",
        source: "hook",
        observedAt: new Date().toISOString(),
        payload: {},
      })).toBe(true);
      return "hook이 확인한 입력";
    });

    expect(receipt.command.state).toBe("started");
    expect(database.prepare("SELECT type, payload_json FROM agent_task_events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1").get(receipt.task.id)).toMatchObject({ type: "prompt.started" });
    database.close();
  });

  it("새 턴 시작은 이전 started task를 완료하고 같은 turn ID의 종료만 현재 task를 닫는다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const first = await service.receiveAndDispatch(chatId, "첫 입력", user, "turn-first", async () => "첫 입력");
    service.observeProviderEvent({ schemaVersion: 1, id: "start-first", provider: "codex", chatId, sessionId: "s", turnId: "t1", type: "prompt.started", source: "hook", observedAt: new Date().toISOString(), payload: {} });
    const second = await service.receiveAndDispatch(chatId, "둘째 입력", user, "turn-second", async () => "둘째 입력");
    service.observeProviderEvent({ schemaVersion: 1, id: "start-second", provider: "codex", chatId, sessionId: "s", turnId: "t2", type: "prompt.started", source: "hook", observedAt: new Date().toISOString(), payload: {} });

    expect(database.prepare("SELECT state,state_reason FROM agent_tasks WHERE id=?").get(first.task.id)).toEqual({ state: "completed", state_reason: "superseded_by_next_prompt" });
    expect(database.prepare("SELECT state FROM agent_tasks WHERE id=?").get(second.task.id)).toEqual({ state: "running" });
    expect(service.observeProviderEvent({ schemaVersion: 1, id: "late-stop-first", provider: "codex", chatId, sessionId: "s", turnId: "t1", type: "turn.completed", source: "hook", observedAt: new Date().toISOString(), payload: {} })).toBe(false);
    expect(database.prepare("SELECT state FROM agent_tasks WHERE id=?").get(second.task.id)).toEqual({ state: "running" });
    expect(service.observeProviderEvent({ schemaVersion: 1, id: "stop-second", provider: "codex", chatId, sessionId: "s", turnId: "t2", type: "turn.completed", source: "hook", observedAt: new Date().toISOString(), payload: {} })).toBe(true);
    expect(database.prepare("SELECT state,state_reason FROM agent_tasks WHERE id=?").get(second.task.id)).toEqual({ state: "completed", state_reason: null });
    database.close();
  });

  it("재시작 시 idle 채팅에 남은 구버전 running task만 완료로 정리한다", async () => {
    const { database, service, chatId, user } = buildFixture();
    const started = await service.receiveAndDispatch(chatId, "이미 끝난 입력", user, "idle-started", async () => "이미 끝난 입력");
    service.observeProviderEvent({ schemaVersion: 1, id: "idle-start", provider: "codex", chatId, sessionId: "s", turnId: "idle-turn", type: "prompt.started", source: "hook", observedAt: new Date().toISOString(), payload: {} });
    const queued = service.receive(chatId, "아직 전달 전 입력", user, "idle-received");
    database.prepare("UPDATE chats SET busy=0 WHERE id=?").run(chatId);

    expect(service.reconcileCompletedTurns()).toBe(1);
    expect(database.prepare("SELECT state,state_reason FROM agent_tasks WHERE id=?").get(started.task.id)).toEqual({ state: "completed", state_reason: "idle_chat_reconciliation" });
    expect(database.prepare("SELECT state FROM agent_tasks WHERE id=?").get(queued.task.id)).toEqual({ state: "created" });
    database.close();
  });

  it("재시작 시 received/dispatching 명령을 재전송하지 않고 delivery_unknown으로 복구한다", () => {
    const { config, database, service, chatId, user } = buildFixture();
    const received = service.receive(chatId, "재시작 경계 메시지", user, "command-key-0005");
    database.close();

    const reopened = openDatabase(config);
    const recovered = new TaskCommandService(reopened).recoverInterruptedCommands();

    expect(recovered).toBe(1);
    expect(reopened.prepare("SELECT state, last_error FROM prompt_commands WHERE id = ?").get(received.command.id)).toEqual({
      state: "delivery_unknown",
      last_error: "server_restarted_before_delivery_confirmation",
    });
    expect(reopened.prepare("SELECT state, state_reason FROM agent_tasks WHERE id = ?").get(received.task.id)).toEqual({
      state: "needs_input",
      state_reason: "server_restart_reconciliation_required",
    });
    reopened.close();
  });
});
