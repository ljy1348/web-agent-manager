import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import type { ChatRecord } from "../../shared/types";
import type { NormalizedAgentEvent } from "../../shared/provider-runtime";
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredApprovalRequest,
  type CodexStructuredConnector,
} from "../providers/codex-structured-session";
import type { ApprovalService } from "./approval";
import type { AgentAccountService } from "./agent-accounts";
import type { CredentialVault } from "./credential-vault";
import { PromptDeliveryUnknownError } from "./prompt-delivery";
import { projectProfileLaunch } from "./project-profile-launch";

interface StructuredChatRow extends ChatRecord {
  workspace_path: string;
  model: string | null;
  preset_config_json: string | null;
}

interface TransportRow {
  chat_id: number;
  cohort: string;
  state: string;
  thread_id: string | null;
  current_turn_id: string | null;
  last_command_id: string | null;
}

interface StructuredSession {
  adapter: CodexStructuredSessionAdapter;
  connecting: Promise<void>;
}

export interface CodexStructuredTransportCallbacks {
  onStatus(chatId: number, status: ChatRecord["status"], error: string | null): void;
  onBusy(chatId: number, busy: boolean): void;
  onEvent(event: NormalizedAgentEvent): void;
  onHistorySignal(): void;
}

export interface CodexStructuredTransportOptions {
  enabled: boolean;
  cohort?: string;
  maxNewChats?: number;
  readiness: { snapshot(): Record<string, unknown> };
  connector?: CodexStructuredConnector;
  now?: () => Date;
}

export class CodexStructuredPreDeliveryError extends Error {
  constructor(message = "Codex 구조화 연결 전 실패로 TUI 경로를 사용합니다.") {
    super(message);
    this.name = "CodexStructuredPreDeliveryError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function candidateEligible(snapshot: Record<string, unknown>): boolean {
  return record(snapshot.readiness)?.candidateEligible === true;
}

function safeErrorCode(error: unknown): string {
  const code = record(error)?.code;
  if (typeof code === "number" && Number.isFinite(code)) return `rpc_${code}`;
  const message = error instanceof Error ? error.message : String(error);
  if (/시간이 초과|timed? out/i.test(message)) return "timeout";
  if (/종료|닫혀|closed|exit/i.test(message)) return "connection_closed";
  return "app_server_error";
}

function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
}

// 명시적 cohort/quota 안의 신규 Codex 채팅만 소유하는 limited transport다. 메시지 본문은 저장하지
// 않고 Codex의 영속 history를 계속 정본으로 사용하며, 여기에는 thread/turn ACK와 실패 분류만 남긴다.
export class CodexStructuredTransportService {
  private readonly sessions = new Map<number, StructuredSession>();
  private readonly now: () => Date;
  private readonly maxNewChats: number;

  constructor(
    private readonly database: AppDatabase,
    private readonly accounts: AgentAccountService,
    private readonly approvals: Pick<ApprovalService, "awaitCodexAppServerDecision" | "closeChatApprovals">,
    private readonly credentialVault: Pick<CredentialVault, "withMcpEnvironment"> | undefined,
    private readonly callbacks: CodexStructuredTransportCallbacks,
    private readonly options: CodexStructuredTransportOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxNewChats = Math.min(20, Math.max(0, Math.trunc(options.maxNewChats ?? 0)));
  }

  // 서버 재시작 중 turn/start 응답을 기다리던 요청은 전달 여부를 알 수 없으므로 재전송하지 않는다.
  // ACK까지 받은 진행 중 turn도 app-server child와 함께 관찰 채널이 끊겼으므로, 완료를 추정해 새 입력을
  // 받지 않고 운영자가 history/공급자 상태를 대조할 때까지 확인 필요 상태로 잠근다.
  recoverInterruptedDeliveries(): number {
    const dispatching = this.database.prepare(`SELECT command_id, chat_id FROM codex_structured_delivery_receipts
      WHERE state = 'dispatching'`).all() as Array<{ command_id: string; chat_id: number }>;
    const accepted = this.database.prepare(`SELECT chat_id FROM codex_structured_transports
      WHERE state = 'turn_accepted'`).all() as Array<{ chat_id: number }>;
    if (!dispatching.length && !accepted.length) return 0;
    const at = this.now().toISOString();
    this.database.transaction(() => {
      for (const row of dispatching) {
        this.database.prepare(`UPDATE codex_structured_delivery_receipts
          SET state='delivery_unknown', error_code='server_restart_before_turn_ack', updated_at=? WHERE command_id=?`)
          .run(at, row.command_id);
        this.database.prepare(`UPDATE codex_structured_transports
          SET state='delivery_unknown', error_code='server_restart_before_turn_ack', updated_at=? WHERE chat_id=?`)
          .run(at, row.chat_id);
      }
      for (const row of accepted) {
        this.database.prepare(`UPDATE codex_structured_transports
          SET state='error', error_code='server_restart_after_turn_ack_requires_reconciliation', updated_at=? WHERE chat_id=?`)
          .run(at, row.chat_id);
      }
    })();
    const affected = new Set([...dispatching.map((row) => row.chat_id), ...accepted.map((row) => row.chat_id)]);
    for (const chatId of affected) {
      this.callbacks.onBusy(chatId, false);
      this.callbacks.onStatus(chatId, "error", "재시작 전 Codex 구조화 turn의 완료 여부를 확인해야 합니다.");
    }
    return affected.size;
  }

  // 이미 배정된 채팅은 계속 같은 transport를 사용한다. 새 배정은 flag, cohort, quota, 두 shadow gate,
  // 신규/무기록 Codex 채팅 조건이 모두 맞을 때만 원자적으로 이루어진다.
  claimOrOwn(chatId: number): boolean {
    const existing = this.row(chatId);
    if (existing) return existing.state !== "fallback_tui";
    if (!this.options.enabled || !this.options.cohort || this.maxNewChats < 1) return false;
    if (!candidateEligible(this.options.readiness.snapshot())) return false;
    const chat = this.database.prepare(`SELECT provider, provider_session_id, history_file, status FROM chats WHERE id=?`)
      .get(chatId) as { provider: string; provider_session_id: string | null; history_file: string | null; status: string } | undefined;
    if (!chat || chat.provider !== "codex" || chat.provider_session_id || chat.history_file || !["starting", "stopped"].includes(chat.status)) return false;
    const at = this.now().toISOString();
    return this.database.transaction(() => {
      const count = (this.database.prepare("SELECT COUNT(*) AS count FROM codex_structured_transports WHERE cohort=?")
        .get(this.options.cohort) as { count: number }).count;
      if (count >= this.maxNewChats) return false;
      return this.database.prepare(`INSERT OR IGNORE INTO codex_structured_transports(
        chat_id, cohort, state, assigned_at, updated_at
      ) VALUES (?, ?, 'assigned', ?, ?)`).run(chatId, this.options.cohort, at, at).changes === 1;
    })();
  }

  owns(chatId: number): boolean {
    const row = this.row(chatId);
    return Boolean(row && row.state !== "fallback_tui");
  }

  state(chatId: number): { transport: "app_server" | "tui"; state: string; cohort: string | null } {
    const row = this.row(chatId);
    return row && row.state !== "fallback_tui"
      ? { transport: "app_server", state: row.state, cohort: row.cohort }
      : { transport: "tui", state: row?.state ?? "default", cohort: row?.cohort ?? null };
  }

  start(chatId: number): Promise<void> {
    if (!this.owns(chatId)) return Promise.reject(new CodexStructuredPreDeliveryError());
    return this.ensureConnected(chatId);
  }

  async send(chatId: number, commandId: string, content: string): Promise<string> {
    let session: StructuredSession;
    try {
      await this.ensureConnected(chatId);
      session = this.sessions.get(chatId)!;
    } catch (error) {
      if (error instanceof CodexStructuredPreDeliveryError) throw error;
      throw new CodexStructuredPreDeliveryError();
    }
    const existing = this.database.prepare("SELECT state FROM codex_structured_delivery_receipts WHERE command_id=?")
      .get(commandId) as { state: string } | undefined;
    if (existing) {
      if (existing.state === "accepted") return content;
      throw new PromptDeliveryUnknownError("동일 구조화 명령의 전달 상태를 자동 재시도할 수 없습니다.", contentHash(content));
    }
    const row = this.requireRow(chatId);
    if (row.current_turn_id || row.state === "turn_accepted") {
      throw new Error("Codex 구조화 채팅이 응답 중입니다. 완료 후 다음 메시지를 보내주세요.");
    }
    const at = this.now().toISOString();
    this.database.prepare(`INSERT INTO codex_structured_delivery_receipts(
      command_id, chat_id, thread_id, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'dispatching', ?, ?)`).run(commandId, chatId, row.thread_id, at, at);
    this.database.prepare(`UPDATE codex_structured_transports SET last_command_id=?, updated_at=? WHERE chat_id=?`)
      .run(commandId, at, chatId);
    try {
      // 이 호출을 시작한 뒤에는 응답 유실과 미수락을 구분할 수 없으므로 어떤 오류도 TUI fallback하지 않는다.
      const receipt = await session.adapter.send(commandId, content);
      const acceptedAt = receipt.acceptedAt || this.now().toISOString();
      this.database.transaction(() => {
        this.database.prepare(`UPDATE codex_structured_delivery_receipts
          SET thread_id=?, turn_id=?, state='accepted', accepted_at=?, updated_at=? WHERE command_id=? AND state='dispatching'`)
          .run(receipt.threadId, receipt.turnId, acceptedAt, acceptedAt, commandId);
        this.database.prepare(`UPDATE codex_structured_transports
          SET state='turn_accepted', thread_id=?, current_turn_id=?, error_code=NULL, updated_at=? WHERE chat_id=?`)
          .run(receipt.threadId, receipt.turnId, acceptedAt, chatId);
      })();
      this.callbacks.onBusy(chatId, true);
      return content;
    } catch (error) {
      const code = safeErrorCode(error);
      const failedAt = this.now().toISOString();
      this.database.transaction(() => {
        this.database.prepare(`UPDATE codex_structured_delivery_receipts
          SET state='delivery_unknown', error_code=?, updated_at=? WHERE command_id=? AND state='dispatching'`)
          .run(code, failedAt, commandId);
        this.database.prepare(`UPDATE codex_structured_transports
          SET state='delivery_unknown', error_code=?, updated_at=? WHERE chat_id=?`)
          .run(code, failedAt, chatId);
      })();
      this.callbacks.onStatus(chatId, "error", "Codex 구조화 전달 확인이 필요합니다. 자동 재전송하지 않았습니다.");
      throw new PromptDeliveryUnknownError(
        "Codex에 turn 시작을 요청했지만 ACK를 확인하지 못했습니다. 자동 재전송하지 않고 확인 필요 상태로 보존했습니다.",
        contentHash(content),
      );
    }
  }

  async interrupt(chatId: number): Promise<void> {
    await this.ensureConnected(chatId);
    const row = this.requireRow(chatId);
    if (!row.current_turn_id) throw new Error("중단할 Codex 구조화 turn이 없습니다.");
    await this.sessions.get(chatId)!.adapter.interrupt(row.current_turn_id);
  }

  stop(chatId: number): void {
    this.sessions.get(chatId)?.adapter.close();
    this.sessions.delete(chatId);
    const at = this.now().toISOString();
    const row = this.requireRow(chatId);
    const needsReconciliation = ["delivery_unknown", "error"].includes(row.state);
    if (!needsReconciliation) {
      this.database.prepare(`UPDATE codex_structured_transports
        SET state='stopped', current_turn_id=NULL, updated_at=? WHERE chat_id=? AND state <> 'fallback_tui'`).run(at, chatId);
    }
    this.approvals.closeChatApprovals(chatId, "Codex 구조화 세션이 종료되어 자동으로 정리되었습니다.");
    this.callbacks.onBusy(chatId, false);
    this.callbacks.onStatus(chatId, needsReconciliation ? "error" : "stopped",
      needsReconciliation ? "Codex 구조화 전달 상태를 확인해야 새 입력을 시작할 수 있습니다." : null);
  }

  close(): void {
    for (const session of this.sessions.values()) session.adapter.close();
    this.sessions.clear();
  }

  private ensureConnected(chatId: number): Promise<void> {
    const live = this.sessions.get(chatId);
    if (live) return live.connecting;
    const row = this.requireRow(chatId);
    if (["delivery_unknown", "error"].includes(row.state)) {
      return Promise.reject(new Error("Codex 구조화 세션은 확인 필요 상태입니다."));
    }
    const chat = this.chat(chatId);
    const adapter = new CodexStructuredSessionAdapter(
      this.options.connector,
      (event) => this.observeEvent(event),
      this.now,
      (request: CodexStructuredApprovalRequest) => this.approvals.awaitCodexAppServerDecision(request),
      () => this.callbacks.onHistorySignal(),
    );
    const at = this.now().toISOString();
    this.database.prepare("UPDATE codex_structured_transports SET state='connecting', updated_at=? WHERE chat_id=?")
      .run(at, chatId);
    this.callbacks.onStatus(chatId, row.thread_id || chat.provider_session_id ? "resuming" : "starting", null);
    const connect = async (): Promise<void> => {
      try {
        const account = this.accounts.resolveForChat("codex", chat.account_id);
        const accountEnvironment = this.accounts.environment(account);
        const open = (mcpEnvironment: Record<string, string>) => {
          const profile = projectProfileLaunch(chat.preset_config_json, chat.workspace_path);
          if (profile && (profile.additionalWritePaths.length || profile.allowedTools.length || profile.disallowedTools.length || profile.reasoningEffort)) {
            throw new Error("Codex app-server 후보는 이 project profile 실행 옵션을 아직 안전하게 적용할 수 없습니다.");
          }
          const input = {
            chatId,
            cwd: chat.workspace_path,
            environment: { ...accountEnvironment, ...mcpEnvironment, WEB_AGENT_MANAGER_CHAT_ID: String(chatId) },
            model: profile?.model ?? chat.model,
            approvalPolicy: profile?.approvalMode ?? "on-request" as const,
            sandbox: profile?.sandbox ?? "workspace-write" as const,
          };
          const threadId = row.thread_id ?? chat.provider_session_id;
          return threadId ? adapter.resume({ ...input, threadId }) : adapter.start(input);
        };
        const handle = this.credentialVault
          ? await this.credentialVault.withMcpEnvironment("codex", chat.project_id, `chat:${chatId}:app-server`, open)
          : await open({});
        const connectedAt = this.now().toISOString();
        this.database.transaction(() => {
          this.database.prepare(`UPDATE codex_structured_transports SET
            state='active', thread_id=?, current_turn_id=NULL, connected_at=COALESCE(connected_at, ?), error_code=NULL, updated_at=?
            WHERE chat_id=?`).run(handle.threadId, connectedAt, connectedAt, chatId);
          this.database.prepare("UPDATE chats SET provider_session_id=?, status='running', last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(handle.threadId, chatId);
        })();
        this.callbacks.onStatus(chatId, "running", null);
      } catch (error) {
        adapter.close();
        this.sessions.delete(chatId);
        const current = this.requireRow(chatId);
        const hasDelivery = Boolean(this.database.prepare("SELECT 1 FROM codex_structured_delivery_receipts WHERE chat_id=? LIMIT 1").get(chatId));
        if (!hasDelivery && !current.current_turn_id) {
          const failedAt = this.now().toISOString();
          this.database.prepare(`UPDATE codex_structured_transports SET
            state='fallback_tui', fallback_reason='connect_failed_before_delivery', error_code=?, updated_at=? WHERE chat_id=?`)
            .run(safeErrorCode(error), failedAt, chatId);
          this.callbacks.onStatus(chatId, "stopped", null);
          throw new CodexStructuredPreDeliveryError();
        }
        const failedAt = this.now().toISOString();
        this.database.prepare("UPDATE codex_structured_transports SET state='error', error_code=?, updated_at=? WHERE chat_id=?")
          .run(safeErrorCode(error), failedAt, chatId);
        this.callbacks.onStatus(chatId, "error", "Codex 구조화 세션 연결을 복구하지 못했습니다.");
        throw error;
      }
    };
    const connecting = connect();
    this.sessions.set(chatId, { adapter, connecting });
    return connecting;
  }

  private observeEvent(event: NormalizedAgentEvent): void {
    const row = this.row(event.chatId);
    if (!row || (event.sessionId && row.thread_id && event.sessionId !== row.thread_id)) return;
    this.callbacks.onEvent(event);
    const at = event.observedAt;
    if (event.type === "prompt.started") {
      this.database.prepare(`UPDATE codex_structured_transports
        SET state='turn_accepted', current_turn_id=COALESCE(?, current_turn_id), updated_at=? WHERE chat_id=?`)
        .run(event.turnId, at, event.chatId);
      this.callbacks.onBusy(event.chatId, true);
    }
    if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
      const state = event.type === "turn.completed" ? "completed" : event.type === "turn.failed" ? "failed" : "interrupted";
      this.database.transaction(() => {
        if (event.turnId) this.database.prepare(`UPDATE codex_structured_delivery_receipts
          SET state=?, terminal_at=?, updated_at=? WHERE chat_id=? AND turn_id=? AND state='accepted'`)
          .run(state, at, at, event.chatId, event.turnId);
        this.database.prepare(`UPDATE codex_structured_transports
          SET state='active', current_turn_id=NULL, updated_at=? WHERE chat_id=? AND state <> 'delivery_unknown'`)
          .run(at, event.chatId);
      })();
      this.callbacks.onBusy(event.chatId, false);
      this.callbacks.onHistorySignal();
    }
    if (event.type === "session.ended") {
      this.callbacks.onStatus(event.chatId, "stopped", null);
      this.callbacks.onBusy(event.chatId, false);
    }
  }

  private row(chatId: number): TransportRow | undefined {
    return this.database.prepare("SELECT * FROM codex_structured_transports WHERE chat_id=?").get(chatId) as TransportRow | undefined;
  }

  private requireRow(chatId: number): TransportRow {
    const row = this.row(chatId);
    if (!row) throw new CodexStructuredPreDeliveryError();
    return row;
  }

  private chat(chatId: number): StructuredChatRow {
    const chat = this.database.prepare(`SELECT c.*, COALESCE(c.worktree_path, p.path) AS workspace_path
      FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=?`).get(chatId) as StructuredChatRow | undefined;
    if (!chat || chat.provider !== "codex") throw new Error("Codex 구조화 채팅을 찾을 수 없습니다.");
    return chat;
  }
}
