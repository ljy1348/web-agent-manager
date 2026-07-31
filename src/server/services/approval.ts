import crypto from "node:crypto";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { AuthUser } from "../../shared/types";
import type { RealtimeHub } from "./realtime";
import type { Notifier } from "./notifier";

interface ClaudeHookRequest {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  permission_suggestions?: Array<Record<string, unknown>>;
}

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

// 승인 요청 알림에 넣을 짧은 설명을 요청 payload에서 뽑는다.
function approvalNotificationDetail(requestType: string, payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim().split("\n").slice(0, 8).join("\n");
    if (requestType === "permission" && typeof record.tool_name === "string") return record.tool_name;
  }
  return requestType || null;
}

// 웹 승인 요청을 저장하고 Claude 훅의 대기 응답을 연결한다.
export class ApprovalService {
  // id 하나에 대기자가 여럿일 수 있다 — 같은 tool 호출의 훅 요청이 재시도로 두 번 들어오면(네트워크
  // 순간 오류 등) 새 승인을 또 만들지 않고 기존 요청에 합류시키는데, 그 각각의 훅 호출이 자기 나름의
  // HTTP 응답을 기다리고 있으므로 결정 하나로 전부 응답해줘야 한다.
  private readonly waiting = new Map<string, Array<(decision: ApprovalDecision, answer?: string) => void>>();
  private terminalDecisionHandler?: (chatId: number, decision: ApprovalDecision, requestType: string) => void;
  // 터미널 스크래핑 기반 승인(Codex, Claude confirm_yn 등)이 지금도 실제로 화면에 떠 있는지 재확인하는 콜백.
  // dismiss()가 "이미 지나간 요청"인지 판단할 때만 쓰고, 결과에 따라 실제 키 입력은 절대 보내지 않는다.
  private terminalLiveCheckHandler?: (chatId: number, requestType: string) => boolean;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly realtime: RealtimeHub,
    private readonly notifications: Notifier,
  ) {}

  // Codex PTY 승인 결정을 전달할 콜백을 등록한다.
  setTerminalDecisionHandler(handler: (chatId: number, decision: ApprovalDecision, requestType: string) => void): void {
    this.terminalDecisionHandler = handler;
  }

  // 터미널 승인이 지금도 실제로 살아있는지 재확인하는 콜백을 등록한다.
  setTerminalLiveCheckHandler(handler: (chatId: number, requestType: string) => boolean): void {
    this.terminalLiveCheckHandler = handler;
  }

  // 터미널에서 감지한 공급자별 승인·선택 요청을 중복 없이 생성한다. notify=false면 웹·Slack에 알리지
  // 않는다 — rate_limit_options처럼 사람이 볼 새도 없이 곧바로 자동 처리되는 화면까지 "승인 필요"
  // 알림을 띄우면, 실제로는 할 일이 없는데도 알림이 와서 혼란스럽다(session-manager.ts 참고).
  createTerminalApproval(chatId: number, provider: "codex" | "claude", summary: string, requestType = "terminal_approval", notify = true): string {
    const existing = this.database.prepare("SELECT id FROM approvals WHERE chat_id = ? AND status = 'pending'").get(chatId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO approvals(id, chat_id, provider, request_type, request_payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, chatId, provider, requestType, JSON.stringify({ summary }));
    if (notify) this.publish(id, chatId, provider, requestType, { summary });
    return id;
  }

  // Claude PermissionRequest 훅을 웹 승인으로 전환하고 결과를 기다린다. 같은 tool 호출이 네트워크
  // 순간 오류 등으로 재시도되면 CLI가 hook을 다시 호출하는데, 그때마다 새 승인을 만들면 사람이 볼
  // 카드가 중복으로 뜨고(실제로 겪음) 어느 쪽에 답해야 실제로 진행되는지 헷갈린다. 같은 채팅에 같은
  // tool_name+tool_input의 pending 요청이 이미 있으면 새로 만들지 않고 그 요청에 합류한다.
  async handleClaudeHook(input: ClaudeHookRequest): Promise<Record<string, unknown>> {
    const chat = this.findClaudeChat(input);
    if (!chat) return this.denyClaude("연결된 웹 채팅을 찾지 못했습니다.", false);
    const duplicate = this.database.prepare(`
      SELECT id FROM approvals WHERE chat_id = ? AND provider = 'claude' AND request_type = 'permission' AND status = 'pending' AND request_payload = ?
    `).get(chat.id, JSON.stringify(input)) as { id: string } | undefined;
    const id = duplicate?.id ?? crypto.randomUUID();
    if (!duplicate) {
      this.database.prepare(`
        INSERT INTO approvals(id, chat_id, provider, request_type, request_payload)
        VALUES (?, ?, 'claude', 'permission', ?)
      `).run(id, chat.id, JSON.stringify(input));
      this.publish(id, chat.id, "claude", "permission", input);
    }
    const { decision, answer } = await new Promise<{ decision: ApprovalDecision; answer?: string }>((resolve) => {
      // 9분간 응답이 없으면 Claude에는 거부로 응답한다. finalizeApproval을 그대로 타야 DB·웹 화면에도
      // "처리 완료"가 반영되어, 응답 없이 방치된 요청이 승인 목록에 영원히 pending으로 남지 않는다
      // (시스템이 자동으로 정리한 것이므로 decided_by는 비워둔다). 합류한 재시도는 별도 타이머 없이
      // 원래 요청의 타이머·결정을 그대로 따른다.
      if (!duplicate) {
        const timeout = setTimeout(() => this.finalizeApproval(id, "decline", null, undefined, false), 9 * 60 * 1000);
        timeout.unref();
        this.waiting.set(id, [(value, replyText) => { clearTimeout(timeout); resolve({ decision: value, answer: replyText }); }]);
      } else {
        const waiters = this.waiting.get(id);
        if (!waiters) { resolve({ decision: "decline", answer: "이미 처리된 요청입니다." }); return; }
        waiters.push((value, replyText) => resolve({ decision: value, answer: replyText }));
      }
    });
    if (decision === "accept") return this.allowClaude();
    if (decision === "acceptForSession") return this.allowClaudeForSession(input.permission_suggestions);
    // AskUserQuestion처럼 실제 선택·답변이 필요한 도구는 decline의 message에 그 답을 그대로 실어
    // 보내면, 터미널 조작 없이도 Claude가 자연어 피드백으로 읽고 답변받은 것처럼 이어갈 수 있다.
    return this.denyClaude(answer || (decision === "cancel" ? "사용자가 작업을 취소했습니다." : "사용자가 권한을 거부했습니다."), decision === "cancel");
  }

  // 인증된 사용자의 승인 결정을 저장하고 대기 중인 공급자에 전달한다.
  decide(id: string, decision: ApprovalDecision, user: AuthUser, answer?: string): void {
    if (!this.finalizeApproval(id, decision, user.id, answer, true)) throw new Error("처리 가능한 승인 요청이 아닙니다.");
  }

  // 사람 개입 없이 시스템이 즉시 결정한다(예: rate_limit_options의 "재설정까지 대기" 자동 선택).
  // decided_by는 시스템이 처리했다는 뜻으로 비워둔다.
  autoResolve(id: string, decision: ApprovalDecision): void {
    this.finalizeApproval(id, decision, null, undefined, true);
  }

  // "닫기": 웹 목록에서만 정리한다. 실제로 AI가 지금 이 요청에 대한 응답을 기다리고 있는 게 확인되면
  // (Claude 훅이 아직 대기 중이거나, 터미널 화면에 그 프롬프트가 여전히 떠 있으면) 절대 조용히 넘어가지
  // 않고 에러를 던진다 — 살아있는 요청을 실수로 끊어버리는 대신, 사용자가 실제로 답변하거나 거부하도록
  // 강제한다. 이미 다른 경로로 끝났거나 화면이 지나간 게 확인된 경우에만 AI 쪽은 전혀 건드리지 않고
  // DB 상태만 정리한다.
  dismiss(id: string, user: AuthUser): void {
    const approval = this.database.prepare("SELECT chat_id, provider, request_type, status FROM approvals WHERE id = ?").get(id) as {
      chat_id: number;
      provider: "codex" | "claude";
      request_type: string;
      status: string;
    } | undefined;
    if (!approval || approval.status !== "pending") throw new Error("처리 가능한 승인 요청이 아닙니다.");
      // Claude PermissionRequest 훅은 공급자 고유 HTTP 훅 경로라 어댑터 TUI 추상화 대상이 아니다.
      const isHookLive = approval.provider === "claude" && approval.request_type === "permission" && this.waiting.has(id);
    const isTerminalLive = approval.request_type !== "permission" && (this.terminalLiveCheckHandler?.(approval.chat_id, approval.request_type) ?? false);
    if (isHookLive || isTerminalLive) throw new Error("AI가 지금 이 요청에 대한 응답을 실제로 기다리고 있어 그냥 닫을 수 없습니다. 답변하거나 거부해주세요.");
    this.database.prepare(`
      UPDATE approvals SET status = 'dismissed', decision = 'dismiss', decided_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(user.id, id);
    this.realtime.broadcast("approval_resolved", { id, decision: "dismiss", chatId: approval.chat_id });
  }

  // 터미널·프로세스가 사라진 채팅에 남은 pending 승인을 전부 정리한다. 그대로 두면 대상이 없어진 요청이
  // 승인 목록에 계속 남아 사용자가 매번 지나간 요청을 걸러봐야 하는 문제가 있었다.
  closeChatApprovals(chatId: number, message: string): void {
    const rows = this.database.prepare("SELECT id FROM approvals WHERE chat_id = ? AND status = 'pending'").all(chatId) as { id: string }[];
    for (const row of rows) this.finalizeApproval(row.id, "decline", null, message, false);
  }

  // 승인 요청을 실제로 종료 처리하는 단일 경로. decide()·9분 타임아웃·프로세스 종료 정리가 모두 여기를
  // 거치게 해, DB 갱신·훅 대기 해제·터미널 키 입력·웹 알림이 어디서 호출되든 항상 같이 일어나게 한다.
  // notifyTerminal=false면 터미널에 실제로 키를 보내지 않는다(프로세스가 이미 사라진 경우 등).
  private finalizeApproval(id: string, decision: ApprovalDecision, decidedBy: number | null, answer: string | undefined, notifyTerminal: boolean): boolean {
    const approval = this.database.prepare("SELECT chat_id, provider, request_type, status FROM approvals WHERE id = ?").get(id) as {
      chat_id: number;
      provider: "codex" | "claude";
      request_type: string;
      status: string;
    } | undefined;
    if (!approval || approval.status !== "pending") return false;
    this.database.prepare(`
      UPDATE approvals SET status = ?, decision = ?, decided_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(decision === "accept" || decision === "acceptForSession" ? "accepted" : "declined", decision, decidedBy, id);
    const waiters = this.waiting.get(id);
    // Claude PermissionRequest 훅은 공급자 고유 HTTP 훅 경로라 어댑터 TUI 추상화 대상이 아니다.
    if (approval.provider === "claude" && waiters) {
      // 재시도로 합류한 대기자가 있으면 전부 같은 결정으로 응답해야, 그중 어느 훅 HTTP 호출도
      // 응답 없이 매달려 있지 않는다.
      for (const waiter of waiters) waiter(decision, answer);
      this.waiting.delete(id);
    } else if (notifyTerminal) {
      this.terminalDecisionHandler?.(approval.chat_id, decision, approval.request_type);
    }
    this.realtime.broadcast("approval_resolved", { id, decision, chatId: approval.chat_id });
    return true;
  }

  // Claude 훅 세션 ID 또는 작업 경로로 연결된 채팅을 찾는다.
  private findClaudeChat(input: ClaudeHookRequest): { id: number } | null {
    if (input.session_id) {
      const bySession = this.database.prepare("SELECT id FROM chats WHERE provider = 'claude' AND provider_session_id = ?").get(input.session_id) as { id: number } | undefined;
      if (bySession) return bySession;
    }
    if (input.cwd) {
      const byCwd = this.database.prepare(`
        SELECT c.id FROM chats c JOIN projects p ON p.id = c.project_id
        WHERE c.provider = 'claude' AND p.path = ? ORDER BY c.updated_at DESC LIMIT 1
      `).get(input.cwd) as { id: number } | undefined;
      if (byCwd) return byCwd;
    }
    return null;
  }

  // 승인 요청을 웹과 등록된 알림 채널에 알린다.
  private publish(id: string, chatId: number, provider: string, requestType: string, payload: unknown): void {
    const detail = approvalNotificationDetail(requestType, payload);
    this.realtime.broadcast("approval_requested", { id, chatId, provider, requestType, payload });
    void this.notifications.notify(
      `approval:${id}`,
      "approval_requested",
      `권한 승인이 필요합니다.\n공급자: ${provider}\n채팅 ID: ${chatId}${detail ? `\n요청: ${detail}` : ""}\n${this.config.publicUrl}/?chat=${chatId}`,
    );
  }

  // Claude에 1회 허용 결정을 반환한다.
  private allowClaude(): Record<string, unknown> {
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
  }

  // Claude에 현재 세션 범위의 지속 허용 결정을 반환한다.
  private allowClaudeForSession(suggestions: Array<Record<string, unknown>> | undefined): Record<string, unknown> {
    const updatedPermissions = (suggestions ?? []).map((suggestion) => ({ ...suggestion, destination: "session" }));
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions } } };
  }

  // Claude에 거부 또는 취소 결정을 반환한다.
  private denyClaude(message: string, interrupt: boolean): Record<string, unknown> {
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message, interrupt } } };
  }
}
