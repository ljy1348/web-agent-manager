import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import type { AuthUser } from "../../shared/types";
import type { AgentTaskState, PromptCommandReceipt, PromptCommandState } from "../../shared/task-ledger";
import { PromptDeliveryUnknownError } from "./prompt-delivery";
import type { NormalizedAgentEvent } from "../../shared/provider-runtime";

interface PromptCommandRow {
  id: string;
  task_id: string;
  chat_id: number;
  source: string;
  idempotency_key: string;
  request_fingerprint: string;
  content_hash: string;
  delivery_content_hash: string | null;
  state: PromptCommandState;
  received_at: string;
  updated_at: string;
}

interface AgentTaskRow {
  id: string;
  state: AgentTaskState;
}

export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("같은 Idempotency-Key가 다른 메시지 요청에 이미 사용되었습니다.");
    this.name = "IdempotencyConflictError";
  }
}

function requestFingerprint(chatId: number, text: string, userId: number | null): string {
  return crypto.createHash("sha256").update(`${chatId}\u0000${userId ?? "system"}\u0000${text}`).digest("hex");
}

function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 일반 채팅 입력의 영속 접수·멱등 dispatch·append-only 상태 이벤트를 소유한다. 메시지 원문은
// 공급자 JSONL 정본 원칙을 지키기 위해 저장하지 않고 해시와 길이만 기록한다.
export class TaskCommandService {
  constructor(private readonly database: AppDatabase) {}

  private appendEvent(taskId: string, idempotencyKey: string, type: string, payload: Record<string, unknown> = {}): void {
    const sequence = (this.database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM agent_task_events WHERE task_id = ?",
    ).get(taskId) as { value: number }).value;
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_task_events(id, task_id, sequence, idempotency_key, type, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), taskId, sequence, idempotencyKey, type, JSON.stringify(payload));
  }

  private receipt(command: PromptCommandRow, replayed: boolean): PromptCommandReceipt {
    const task = this.database.prepare("SELECT id, state FROM agent_tasks WHERE id = ?").get(command.task_id) as AgentTaskRow;
    return {
      accepted: true,
      replayed,
      task: { id: task.id, state: task.state },
      command: {
        id: command.id,
        state: command.state,
        receivedAt: command.received_at,
        updatedAt: command.updated_at,
      },
    };
  }

  private getCommand(id: string): PromptCommandRow {
    return this.database.prepare("SELECT * FROM prompt_commands WHERE id = ?").get(id) as PromptCommandRow;
  }

  // 한 채팅은 공급자 턴을 직렬로 실행한다. 새 prompt가 실제 started가 됐다면 그보다 이전에
  // started였던 task는 더 이상 현재 턴일 수 없으므로 완료로 닫는다. 웹 follow-up이 queued에만
  // 머문 동안에는 호출되지 않아 아직 답변 중인 task를 성급하게 닫지 않는다.
  private completeSupersededTasks(chatId: number, currentTaskId: string, currentReceivedAt: string): number {
    const rows = this.database.prepare(`
      SELECT DISTINCT t.id FROM agent_tasks t
      JOIN prompt_commands p ON p.task_id = t.id
      WHERE t.chat_id = ? AND t.id <> ? AND t.state = 'running' AND p.state = 'started'
        AND p.received_at <= ?
    `).all(chatId, currentTaskId, currentReceivedAt) as Array<{ id: string }>;
    let completed = 0;
    for (const row of rows) {
      const changed = this.database.prepare(`UPDATE agent_tasks SET state='completed', state_reason='superseded_by_next_prompt',
        finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='running'`).run(row.id).changes;
      if (!changed) continue;
      this.appendEvent(row.id, `task:${row.id}:superseded:${currentTaskId}`, "task.completed", {
        reason: "superseded_by_next_prompt", nextTaskId: currentTaskId,
      });
      completed += 1;
    }
    return completed;
  }

  // 구버전에서 turn end를 task 원장에 반영하지 않아 쌓인 running 카드를 재시작 시 정리한다.
  // started 증거가 있고 chat 자체는 idle인 task만 닫으므로 queued/확인 필요/검증 중 작업은 건드리지 않는다.
  reconcileCompletedTurns(): number {
    const rows = this.database.prepare(`
      SELECT DISTINCT t.id FROM agent_tasks t
      JOIN chats c ON c.id=t.chat_id
      JOIN prompt_commands p ON p.task_id=t.id
      WHERE t.state='running' AND p.state='started' AND c.busy=0
    `).all() as Array<{ id: string }>;
    if (!rows.length) return 0;
    return this.database.transaction(() => {
      let completed = 0;
      for (const row of rows) {
        const changed = this.database.prepare(`UPDATE agent_tasks SET state='completed', state_reason='idle_chat_reconciliation',
          finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='running'`).run(row.id).changes;
        if (!changed) continue;
        this.appendEvent(row.id, `task:${row.id}:idle-reconciliation`, "task.completed", { reason: "idle_chat_reconciliation" });
        completed += 1;
      }
      return completed;
    })();
  }

  receive(chatId: number, text: string, user: AuthUser | null, idempotencyKey: string, source = "web"): PromptCommandReceipt {
    const fingerprint = requestFingerprint(chatId, text, user?.id ?? null);
    return this.database.transaction(() => {
      const existing = this.database.prepare(
        "SELECT * FROM prompt_commands WHERE source = ? AND idempotency_key = ?",
      ).get(source, idempotencyKey) as PromptCommandRow | undefined;
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw new IdempotencyConflictError();
        this.database.prepare(`
          UPDATE prompt_commands SET replay_count = replay_count + 1, last_replayed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(existing.id);
        return this.receipt(this.getCommand(existing.id), true);
      }
      const chat = this.database.prepare("SELECT project_id, preset_version_id FROM chats WHERE id = ?").get(chatId) as { project_id: number; preset_version_id: string | null } | undefined;
      if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
      const taskId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      this.database.prepare(`
        INSERT INTO agent_tasks(id, chat_id, project_id, profile_version_id, created_by, state)
        VALUES (?, ?, ?, ?, ?, 'created')
      `).run(taskId, chatId, chat.project_id, chat.preset_version_id, user?.id ?? null);
      this.database.prepare(`
        INSERT INTO prompt_commands(
          id, task_id, chat_id, source, idempotency_key, request_fingerprint, content_hash, content_length, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received')
      `).run(commandId, taskId, chatId, source, idempotencyKey, fingerprint, contentHash(text), text.length);
      this.appendEvent(taskId, `task:${taskId}:created`, "task.created", { chatId, source });
      this.appendEvent(taskId, `command:${commandId}:received`, "prompt.received", { commandId, contentLength: text.length });
      return this.receipt(this.getCommand(commandId), false);
    })();
  }

  async receiveAndDispatch(
    chatId: number,
    text: string,
    user: AuthUser | null,
    idempotencyKey: string,
    dispatch: (commandId: string) => Promise<string>,
    deliveryContext: () => { adapter: string; evidenceType: string; supportsQueue: boolean } = () => ({
      adapter: "tui", evidenceType: "tui_submission_confirmation", supportsQueue: true,
    }),
  ): Promise<PromptCommandReceipt> {
    const received = this.receive(chatId, text, user, idempotencyKey);
    if (received.replayed) return received;
    const commandId = received.command.id;
    const taskId = received.task.id;
    const baseline = this.database.prepare("SELECT busy, status FROM chats WHERE id = ?").get(chatId) as { busy: number; status: string };
    const attemptId = crypto.randomUUID();
    const initialDelivery = deliveryContext();
    const claimed = this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE prompt_commands SET state = 'dispatching', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'received'
      `).run(commandId).changes;
      if (!changed) return false;
      this.database.prepare(`
        INSERT INTO prompt_delivery_attempts(id, command_id, attempt, adapter, outcome, baseline_json, started_at)
        VALUES (?, ?, 1, ?, 'attempting', ?, CURRENT_TIMESTAMP)
      `).run(attemptId, commandId, initialDelivery.adapter, JSON.stringify({ chatBusy: Boolean(baseline.busy), chatStatus: baseline.status }));
      this.appendEvent(taskId, `command:${commandId}:dispatching`, "prompt.dispatching", { commandId, adapter: initialDelivery.adapter });
      return true;
    })();
    if (!claimed) return this.receipt(this.getCommand(commandId), true);

    try {
      const deliveredText = await dispatch(commandId);
      const finalDelivery = deliveryContext();
      const finalState: PromptCommandState = baseline.busy && finalDelivery.supportsQueue ? "queued" : "delivered";
      this.database.transaction(() => {
        this.database.prepare(`
          UPDATE prompt_delivery_attempts SET adapter = ?, outcome = ?, evidence_type = ?, finished_at = CURRENT_TIMESTAMP
          WHERE id = ? AND outcome = 'attempting'
        `).run(finalDelivery.adapter, finalState, finalDelivery.evidenceType, attemptId);
        this.database.prepare("UPDATE prompt_commands SET delivery_content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(contentHash(deliveredText), commandId);
        const stateChanged = this.database.prepare(`
          UPDATE prompt_commands SET state = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND state = 'dispatching'
        `).run(finalState, commandId).changes > 0;
        this.database.prepare("UPDATE agent_tasks SET state = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(taskId);
        if (stateChanged) {
          this.appendEvent(taskId, `command:${commandId}:delivered`, "prompt.delivered", { commandId, evidenceType: finalDelivery.evidenceType });
          if (finalState === "queued") this.appendEvent(taskId, `command:${commandId}:queued`, "prompt.queued", { commandId });
        }
      })();
    } catch (error) {
      const unknown = error instanceof PromptDeliveryUnknownError;
      const commandState: PromptCommandState = unknown ? "delivery_unknown" : "rejected";
      const taskState: AgentTaskState = unknown ? "needs_input" : "failed";
      // 훅/JSONL 관찰이 dispatch promise보다 먼저 도착해 started까지 진전했다면, 늦은 TUI 결과로
      // 확정 상태를 delivery_unknown/rejected로 되돌리지 않는다.
      const current = this.getCommand(commandId);
      if (current.state === "started" || current.state === "reconciled_delivered") return this.receipt(current, false);
      this.database.transaction(() => {
        if (unknown && error.deliveryContentHash) {
          this.database.prepare("UPDATE prompt_commands SET delivery_content_hash = ? WHERE id = ?")
            .run(error.deliveryContentHash, commandId);
        }
        this.database.prepare(`
          UPDATE prompt_delivery_attempts SET outcome = ?, error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(commandState, errorMessage(error), attemptId);
        this.database.prepare("UPDATE prompt_commands SET state = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(commandState, errorMessage(error), commandId);
        this.database.prepare("UPDATE agent_tasks SET state = ?, state_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(taskState, unknown ? "delivery_confirmation_required" : "dispatch_rejected", taskId);
        this.appendEvent(taskId, `command:${commandId}:${commandState}`, `prompt.${commandState}`, {
          commandId,
          reason: unknown ? "delivery_confirmation_required" : "dispatch_rejected",
        });
      })();
      if (!unknown) throw error;
    }
    return this.receipt(this.getCommand(commandId), false);
  }

  // 평문 outbox가 없는 동안 재시작 뒤 미완료 dispatch를 재전송하지 않는다. 이미 키 입력이 수행됐을 수
  // 있으므로 모두 명시적인 확인 필요 상태로 보존한다.
  recoverInterruptedCommands(): number {
    const rows = this.database.prepare(`
      SELECT id, task_id FROM prompt_commands WHERE state IN ('received', 'dispatching')
    `).all() as Array<{ id: string; task_id: string }>;
    if (!rows.length) return 0;
    this.database.transaction(() => {
      for (const row of rows) {
        this.database.prepare(`
          UPDATE prompt_commands SET state = 'delivery_unknown', last_error = 'server_restarted_before_delivery_confirmation', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(row.id);
        this.database.prepare(`
          UPDATE prompt_delivery_attempts SET outcome = 'delivery_unknown', error = 'server_restarted_before_delivery_confirmation', finished_at = CURRENT_TIMESTAMP
          WHERE command_id = ? AND outcome = 'attempting'
        `).run(row.id);
        this.database.prepare("UPDATE agent_tasks SET state = 'needs_input', state_reason = 'server_restart_reconciliation_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(row.task_id);
        this.appendEvent(row.task_id, `command:${row.id}:restart-recovery`, "prompt.delivery_unknown", {
          commandId: row.id,
          reason: "server_restart_reconciliation_required",
        });
      }
    })();
    return rows.length;
  }

  getTask(taskId: string, afterSequence = 0): Record<string, unknown> {
    const task = this.database.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!task) throw new Error("작업을 찾을 수 없습니다.");
    const commands = this.database.prepare(`
      SELECT id, task_id, chat_id, source, state, content_hash, delivery_content_hash, content_length, replay_count,
        last_error, received_at, updated_at
      FROM prompt_commands WHERE task_id = ? ORDER BY received_at, id
    `).all(taskId);
    const events = this.database.prepare(`
      SELECT id, sequence, type, payload_json, created_at
      FROM agent_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence
    `).all(taskId, Math.max(0, Math.trunc(afterSequence)));
    return { task, commands, events };
  }

  reconcile(commandId: string, resolution: "delivered" | "failed", idempotencyKey: string): PromptCommandReceipt {
    return this.database.transaction(() => {
      const command = this.getCommand(commandId);
      if (!command) throw new Error("프롬프트 명령을 찾을 수 없습니다.");
      const eventKey = `command:${commandId}:reconcile:${idempotencyKey}`;
      const prior = this.database.prepare(
        "SELECT 1 FROM agent_task_events WHERE task_id = ? AND idempotency_key = ?",
      ).get(command.task_id, eventKey);
      if (prior) return this.receipt(command, true);
      const structuredReceipt = this.database.prepare(
        "SELECT chat_id FROM codex_structured_delivery_receipts WHERE command_id = ?",
      ).get(commandId) as { chat_id: number } | undefined;
      const structuredTransport = structuredReceipt ? this.database.prepare(
        "SELECT state, error_code FROM codex_structured_transports WHERE chat_id = ?",
      ).get(structuredReceipt.chat_id) as { state: string; error_code: string | null } | undefined : undefined;
      if (command.state !== "delivery_unknown") {
        // ACK 뒤 재시작 또는 늦은 history 증거로 전달은 이미 확정됐지만 event channel만 잃은 경우,
        // 같은 관리 API의 delivered 확인으로 중복 발송 없이 thread를 명시적 재개 가능 상태로 만든다.
        if (resolution !== "delivered" || structuredTransport?.state !== "error") {
          throw new Error("전달 확인 필요 상태인 명령만 조정할 수 있습니다.");
        }
        this.database.prepare(`UPDATE codex_structured_transports SET
          state='stopped', current_turn_id=NULL, error_code=NULL, updated_at=CURRENT_TIMESTAMP WHERE chat_id=?`)
          .run(structuredReceipt!.chat_id);
        this.appendEvent(command.task_id, eventKey, "prompt.structured_session_reviewed", { commandId, resolution });
        return this.receipt(this.getCommand(commandId), false);
      }
      const commandState: PromptCommandState = resolution === "delivered" ? "reconciled_delivered" : "reconciled_failed";
      const taskState: AgentTaskState = resolution === "delivered" ? "running" : "failed";
      this.database.prepare("UPDATE prompt_commands SET state = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(commandState, commandId);
      this.database.prepare("UPDATE agent_tasks SET state = ?, state_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(taskState, `manually_reconciled_${resolution}`, command.task_id);
      if (structuredReceipt) {
        if (resolution === "failed") {
          // 운영자가 공급자 미전달을 명시적으로 확인한 경우에만 안전한 TUI 전환을 허용한다.
          this.database.prepare(`UPDATE codex_structured_delivery_receipts
            SET state='failed', error_code='manually_confirmed_not_delivered', terminal_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
            WHERE command_id=?`).run(commandId);
          this.database.prepare(`UPDATE codex_structured_transports
            SET state='fallback_tui', current_turn_id=NULL, fallback_reason='manual_not_delivered_reconciliation',
              error_code=NULL, updated_at=CURRENT_TIMESTAMP WHERE chat_id=?`).run(structuredReceipt.chat_id);
        } else {
          // 운영자의 전달 확인은 중복 방지를 확정하고, 자동 재접속 대신 명시적 재개가 가능한 stopped로 둔다.
          this.database.prepare(`UPDATE codex_structured_delivery_receipts
            SET state='accepted', error_code='manually_confirmed_delivered', updated_at=CURRENT_TIMESTAMP
            WHERE command_id=?`).run(commandId);
          this.database.prepare(`UPDATE codex_structured_transports
            SET state='stopped', current_turn_id=NULL, error_code=NULL,
              updated_at=CURRENT_TIMESTAMP WHERE chat_id=?`).run(structuredReceipt.chat_id);
        }
      }
      this.appendEvent(command.task_id, eventKey, `prompt.${commandState}`, { commandId, resolution });
      return this.receipt(this.getCommand(commandId), false);
    })();
  }

  metrics(): Record<string, unknown> {
    const byState = this.database.prepare("SELECT state, COUNT(*) AS count FROM prompt_commands GROUP BY state ORDER BY state").all();
    const summary = this.database.prepare(`
      SELECT COUNT(*) AS commands_total,
        COALESCE(SUM(replay_count), 0) AS idempotent_replays_total,
        COALESCE(SUM(CASE WHEN state = 'delivery_unknown' THEN 1 ELSE 0 END), 0) AS delivery_unknown_current,
        COALESCE(SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected_total
      FROM prompt_commands
    `).get();
    const activeTasks = this.database.prepare(`
      SELECT COUNT(*) AS count FROM agent_tasks WHERE state IN ('created', 'running', 'needs_input', 'verifying')
    `).get() as { count: number };
    const busyMismatches = this.database.prepare(`
      SELECT COUNT(*) AS count FROM chats c
      WHERE c.busy != CASE WHEN EXISTS (
        SELECT 1 FROM agent_tasks t WHERE t.chat_id = c.id AND t.state IN ('running', 'verifying')
      ) THEN 1 ELSE 0 END
    `).get() as { count: number };
    return {
      metricNames: [
        "prompt_commands_received_total",
        "prompt_dispatch_attempts_total",
        "prompt_duplicate_dispatch_prevented_total",
        "prompt_delivery_unknown_total",
        "task_state_age_seconds",
        "task_busy_projection_mismatch_current",
      ],
      summary: { ...(summary as object), agent_tasks_active: activeTasks.count, task_busy_projection_mismatch_current: busyMismatches.count },
      commandsByState: byState,
    };
  }

  // 공급자 JSONL에 실제 user turn이 늦게 나타나면 해시·시각을 대조해 불확실 전달을 확정하고,
  // 이미 delivered/queued였던 명령도 started로 진전시킨다. 동일 문구의 과거 턴은 command 접수보다
  // 충분히 이전이면 후보에서 제외한다.
  observeHistoryMessages(chatId: number, messages: Array<{ id: string; role: string; content: string; createdAt: string }>): number {
    const commands = this.database.prepare(`
      SELECT * FROM prompt_commands
      WHERE chat_id = ? AND state IN ('dispatching', 'delivered', 'queued', 'delivery_unknown')
      ORDER BY received_at ASC, id ASC
    `).all(chatId) as PromptCommandRow[];
    if (!commands.length) return 0;
    const userMessages = messages.filter((message) => message.role === "user").map((message) => ({
      ...message,
      hash: contentHash(message.content),
      at: Date.parse(message.createdAt),
    }));
    let reconciled = 0;
    this.database.transaction(() => {
      const usedMessages = new Set<string>();
      for (const command of commands) {
        const receivedAt = Date.parse(command.received_at);
        const match = userMessages.find((message) => !usedMessages.has(message.id)
          && Number.isFinite(message.at)
          && (!Number.isFinite(receivedAt) || message.at >= receivedAt - 10_000)
          && (message.hash === command.content_hash || message.hash === command.delivery_content_hash));
        if (!match) continue;
        usedMessages.add(match.id);
        const state: PromptCommandState = command.state === "delivery_unknown" ? "reconciled_delivered" : "started";
        this.database.prepare("UPDATE prompt_commands SET state = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(state, command.id);
        this.database.prepare(`
          UPDATE prompt_delivery_attempts SET outcome = 'delivered', evidence_type = 'jsonl_user_message', finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
          WHERE command_id = ?
        `).run(command.id);
        this.database.prepare("UPDATE agent_tasks SET state = 'running', state_reason = NULL, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(command.task_id);
        if (command.state === "delivery_unknown") {
          const structuredReceipt = this.database.prepare(
            "SELECT chat_id FROM codex_structured_delivery_receipts WHERE command_id = ?",
          ).get(command.id) as { chat_id: number } | undefined;
          if (structuredReceipt) {
            this.database.prepare(`UPDATE codex_structured_delivery_receipts SET
              state='accepted', error_code='history_confirmed_delivered', updated_at=CURRENT_TIMESTAMP WHERE command_id=?`)
              .run(command.id);
            this.database.prepare(`UPDATE codex_structured_transports SET
              state='error', error_code='history_confirmed_delivered_requires_session_review', updated_at=CURRENT_TIMESTAMP
              WHERE chat_id=?`).run(structuredReceipt.chat_id);
          }
        }
        if (command.state === "dispatching") {
          this.appendEvent(command.task_id, `command:${command.id}:history-delivered:${match.id}`, "prompt.delivered", {
            commandId: command.id,
            evidenceType: "jsonl_user_message",
          });
        }
        this.appendEvent(command.task_id, `command:${command.id}:history:${match.id}`, `prompt.${state}`, {
          commandId: command.id,
          evidenceType: "jsonl_user_message",
          messageId: match.id,
        });
        reconciled += 1;
      }
    })();
    return reconciled;
  }

  // hook의 UserPromptSubmit은 현재 직렬 dispatch의 가장 강한 시작 증거다. turn 종료 훅은 같은
  // provider turn ID로 묶인 최신 started task만 닫아 늦게 도착한 과거 Stop이 새 작업을 끝내지 못하게 한다.
  observeProviderEvent(event: NormalizedAgentEvent): boolean {
    if (event.type !== "prompt.started") {
      if (!["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) return false;
      return this.database.transaction(() => {
        const command = this.database.prepare(`
          SELECT p.*, t.state AS task_state FROM prompt_commands p
          JOIN agent_tasks t ON t.id=p.task_id
          WHERE p.chat_id=? AND p.state='started' AND t.state='running'
            AND (? IS NULL OR EXISTS (
              SELECT 1 FROM agent_task_events e WHERE e.task_id=t.id AND e.type='prompt.started'
                AND json_extract(e.payload_json,'$.providerTurnId')=?
            ))
          ORDER BY p.updated_at DESC, p.rowid DESC LIMIT 1
        `).get(event.chatId, event.turnId, event.turnId) as (PromptCommandRow & { task_state: string }) | undefined;
        if (!command) return false;
        const taskState: AgentTaskState = event.type === "turn.completed" ? "completed" : event.type === "turn.failed" ? "failed" : "cancelled";
        const reason = event.type === "turn.completed" ? null : event.type === "turn.failed" ? "provider_turn_failed" : "provider_turn_interrupted";
        const changed = this.database.prepare(`UPDATE agent_tasks SET state=?, state_reason=?, finished_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='running'`).run(taskState, reason, command.task_id).changes;
        if (!changed) return false;
        this.appendEvent(command.task_id, `command:${command.id}:provider-turn-end:${event.id}`, `task.${taskState}`, {
          commandId: command.id, providerTurnId: event.turnId, providerEventId: event.id, reason,
        });
        return true;
      })();
    }
    return this.database.transaction(() => {
      const command = this.database.prepare(`
        SELECT * FROM prompt_commands
        WHERE chat_id = ? AND state IN ('dispatching', 'delivered', 'queued', 'reconciled_delivered', 'started')
        ORDER BY received_at DESC, rowid DESC LIMIT 1
      `).get(event.chatId) as PromptCommandRow | undefined;
      if (!command) return false;
      this.completeSupersededTasks(event.chatId, command.task_id, command.received_at);
      this.database.prepare("UPDATE prompt_commands SET state = 'started', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(command.id);
      this.database.prepare("UPDATE agent_tasks SET state = 'running', state_reason = NULL, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(command.task_id);
      this.appendEvent(command.task_id, `command:${command.id}:provider-event:${event.id}`, "prompt.started", {
        commandId: command.id,
        evidenceType: event.source,
        providerEventId: event.id,
        providerTurnId: event.turnId,
      });
      return true;
    })();
  }
}
