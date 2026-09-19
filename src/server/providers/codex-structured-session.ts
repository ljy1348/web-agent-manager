import crypto from "node:crypto";
import type { NormalizedAgentEvent, NormalizedAgentEventType } from "../../shared/provider-runtime";
import { CodexAppServerClient, codexAppServerClientVersion, type CodexAppServerNotification, type CodexAppServerRequestId } from "./codex-app-server";

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexStructuredSessionInput {
  chatId: number;
  cwd: string;
  environment?: Record<string, string>;
  model?: string | null;
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
  developerInstructions?: string | null;
}

export interface CodexStructuredSessionHandle {
  chatId: number;
  threadId: string;
}

export interface CodexStructuredDeliveryReceipt {
  commandId: string;
  threadId: string;
  turnId: string;
  acceptedAt: string;
}

export type CodexStructuredApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CodexStructuredApprovalRequest {
  requestId: CodexAppServerRequestId;
  chatId: number;
  requestType: "command_execution" | "file_change";
  threadId: string;
  turnId: string;
  itemId: string;
  availableDecisions: CodexStructuredApprovalDecision[];
}

export interface CodexStructuredClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export type CodexStructuredConnector = (options: {
  environment: Record<string, string>;
  onNotification: (notification: CodexAppServerNotification) => void;
  onServerRequest: (request: { id: CodexAppServerRequestId; method: string; params: unknown }) => Promise<unknown>;
}) => Promise<CodexStructuredClient>;

const defaultConnector: CodexStructuredConnector = async ({ environment, onNotification, onServerRequest }) => CodexAppServerClient.connect({
  environment,
  clientVersion: codexAppServerClientVersion(),
  onNotification,
  onServerRequest,
});

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function idFromResult(result: unknown, container: "thread" | "turn"): string {
  const id = object(object(result)?.[container])?.id;
  if (typeof id !== "string" || !id) throw new Error(`Codex app-server ${container} 응답에 ID가 없습니다.`);
  return id;
}

// app-server session/turn 쓰기 계약을 캡슐화한다. limited 후보 transport와 격리 canary가 사용하며,
// browser/web API가 이 class를 직접 생성하는 경로는 없다.
export class CodexStructuredSessionAdapter {
  private client: CodexStructuredClient | undefined;
  private handle: CodexStructuredSessionHandle | undefined;

  constructor(
    private readonly connector: CodexStructuredConnector = defaultConnector,
    private readonly onEvent?: (event: NormalizedAgentEvent) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly approvalDecider?: (request: CodexStructuredApprovalRequest) => Promise<CodexStructuredApprovalDecision>,
    // assistant delta 본문을 WAM 원장에 복제하지 않고 Codex JSONL 동기화만 앞당기는 신호다.
    private readonly onHistorySignal?: () => void,
  ) {}

  async start(input: CodexStructuredSessionInput): Promise<CodexStructuredSessionHandle> {
    this.assertDisconnected();
    this.client = await this.connector({
      environment: input.environment ?? {},
      onNotification: (notification) => this.observe(input.chatId, notification),
      onServerRequest: (request) => this.handleServerRequest(input.chatId, request),
    });
    try {
      const result = await this.client.request("thread/start", {
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
        ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
        ephemeral: false,
      });
      this.handle = { chatId: input.chatId, threadId: idFromResult(result, "thread") };
      return this.handle;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async resume(input: CodexStructuredSessionInput & { threadId: string }): Promise<CodexStructuredSessionHandle> {
    this.assertDisconnected();
    this.client = await this.connector({
      environment: input.environment ?? {},
      onNotification: (notification) => this.observe(input.chatId, notification),
      onServerRequest: (request) => this.handleServerRequest(input.chatId, request),
    });
    try {
      const result = await this.client.request("thread/resume", {
        threadId: input.threadId,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
        ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
        excludeTurns: true,
      });
      const threadId = idFromResult(result, "thread");
      if (threadId !== input.threadId) throw new Error("Codex app-server가 다른 thread ID를 반환했습니다.");
      this.handle = { chatId: input.chatId, threadId };
      return this.handle;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async send(commandId: string, content: string): Promise<CodexStructuredDeliveryReceipt> {
    const { client, handle } = this.assertConnected();
    const result = await client.request("turn/start", {
      threadId: handle.threadId,
      clientUserMessageId: commandId,
      input: [{ type: "text", text: content, text_elements: [] }],
    });
    return {
      commandId,
      threadId: handle.threadId,
      turnId: idFromResult(result, "turn"),
      acceptedAt: this.now().toISOString(),
    };
  }

  async interrupt(turnId: string): Promise<void> {
    const { client, handle } = this.assertConnected();
    await client.request("turn/interrupt", { threadId: handle.threadId, turnId });
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
    this.handle = undefined;
  }

  currentHandle(): CodexStructuredSessionHandle | null {
    return this.handle ?? null;
  }

  private observe(chatId: number, notification: CodexAppServerNotification): void {
    const params = object(notification.params);
    if (!params) return;
    if (notification.method === "item/agentMessage/delta" || notification.method === "item/completed" || notification.method === "turn/completed") {
      this.onHistorySignal?.();
    }
    const thread = object(params.thread);
    const turn = object(params.turn);
    const threadId = typeof params.threadId === "string" ? params.threadId : typeof thread?.id === "string" ? thread.id : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : null;
    let type: NormalizedAgentEventType | null = null;
    if (notification.method === "thread/started") type = "session.started";
    else if (notification.method === "thread/closed") type = "session.ended";
    else if (notification.method === "turn/started") type = "prompt.started";
    else if (notification.method === "turn/completed") {
      const status = turn?.status;
      type = status === "failed" ? "turn.failed" : status === "interrupted" ? "turn.interrupted" : "turn.completed";
    } else if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = object(params.item);
      const itemType = item?.type;
      if (itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
        type = notification.method === "item/started" ? "tool.started" : "tool.completed";
      }
    }
    if (!type) return;
    this.onEvent?.({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      provider: "codex",
      chatId,
      sessionId: threadId,
      turnId,
      type,
      source: "provider_api",
      observedAt: this.now().toISOString(),
      payload: {
        method: notification.method,
        ...(turn && typeof turn.status === "string" ? { status: turn.status } : {}),
        ...(object(params.item) && typeof object(params.item)?.type === "string" ? { itemType: object(params.item)!.type } : {}),
      },
    });
  }

  private async handleServerRequest(
    chatId: number,
    request: { id: CodexAppServerRequestId; method: string; params: unknown },
  ): Promise<{ decision: CodexStructuredApprovalDecision }> {
    if (!this.approvalDecider) throw new Error("Codex 구조화 승인 handler가 연결되어 있지 않습니다.");
    const params = object(request.params);
    const requestType = request.method === "item/commandExecution/requestApproval"
      ? "command_execution"
      : request.method === "item/fileChange/requestApproval" ? "file_change" : null;
    if (!params || !requestType) throw new Error(`지원하지 않는 Codex app-server 요청입니다: ${request.method}`);
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    if (!threadId || !turnId || !itemId) throw new Error("Codex 구조화 승인 요청 식별자가 불완전합니다.");
    if (this.handle && threadId !== this.handle.threadId) throw new Error("다른 Codex thread의 승인 요청입니다.");
    const supported: CodexStructuredApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];
    const advertised = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.filter((value): value is CodexStructuredApprovalDecision => typeof value === "string" && supported.includes(value as CodexStructuredApprovalDecision))
      : [];
    const availableDecisions = advertised.length ? advertised : supported;
    const approval: CodexStructuredApprovalRequest = {
      requestId: request.id,
      chatId,
      requestType,
      threadId,
      turnId,
      itemId,
      availableDecisions,
    };
    this.emitApprovalEvent(approval, "approval.requested");
    const decision = await this.approvalDecider(approval);
    if (!supported.includes(decision) || !availableDecisions.includes(decision)) throw new Error("허용되지 않은 Codex 구조화 승인 결정입니다.");
    this.emitApprovalEvent(approval, "approval.resolved", decision);
    return { decision };
  }

  private emitApprovalEvent(
    request: CodexStructuredApprovalRequest,
    type: "approval.requested" | "approval.resolved",
    decision?: CodexStructuredApprovalDecision,
  ): void {
    this.onEvent?.({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      provider: "codex",
      chatId: request.chatId,
      sessionId: request.threadId,
      turnId: request.turnId,
      type,
      source: "provider_api",
      observedAt: this.now().toISOString(),
      payload: {
        requestId: String(request.requestId),
        requestType: request.requestType,
        itemId: request.itemId,
        availableDecisions: request.availableDecisions,
        ...(decision ? { decision } : {}),
      },
    });
  }

  private assertDisconnected(): void {
    if (this.client) throw new Error("Codex 구조화 세션이 이미 연결되어 있습니다.");
  }

  private assertConnected(): { client: CodexStructuredClient; handle: CodexStructuredSessionHandle } {
    if (!this.client || !this.handle) throw new Error("Codex 구조화 세션이 연결되어 있지 않습니다.");
    return { client: this.client, handle: this.handle };
  }
}
