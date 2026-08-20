import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AppDatabase } from "../core/database";
import { writeAudit } from "../core/audit";
import type { HistoryMessage, ProviderAdapter } from "../providers/provider";
import type { Provider } from "../../shared/types";
import type { HistoryCache } from "./history-cache";
import type { SessionManager } from "./session-manager";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_CONTEXT_MESSAGES = 200;
const MAX_DELEGATION_DEPTH = 4;
const DEFAULT_DELEGATION_TIMEOUT_SECONDS = 300;
const MAX_DELEGATION_TIMEOUT_SECONDS = 900;

export interface AgentBridgeRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface AgentBridgeDependencies {
  database: AppDatabase;
  adapters: ProviderAdapter[];
  historyCache: HistoryCache;
  sessions: Pick<SessionManager, "start" | "sendPrompt">;
  // 실험실을 에이전트에게 노출한다. 주입하지 않으면 experiment.* 메서드는 사용할 수 없다.
  experiments?: {
    repository: {
      listFixtures(): unknown;
      createFixture(input: unknown): { id: string };
      listExperiments(projectId: number): unknown;
      listRunPlans(experimentId: string): unknown;
    };
    summary(experimentId: string): unknown;
    suiteSummary(suiteId: string): unknown;
    cleanupWorkspaces(filter: { experimentId?: string; suiteId?: string }): Promise<unknown>;
    startRunPlan(experimentId: string, input: Record<string, unknown>): unknown;
    cancelRunPlan(planId: string): unknown;
  };
  socketPath: string;
}

interface BridgeChat {
  id: number;
  project_id: number;
  provider: Provider;
  provider_session_id: string | null;
  tmux_name: string;
  title: string;
  status: string;
  busy: number;
  history_file: string | null;
  updated_at: string;
}

interface BridgeDelegation {
  id: string;
  source_chat_id: number | null;
  target_chat_id: number;
  prompt: string;
  history_prompt: string | null;
  status: string;
  error: string | null;
  baseline_message_count: number;
  result_json: string | null;
  completed_at: string | null;
}

// 로컬 에이전트가 세션 문맥을 조회하고 명시적으로 작업을 전달하는 Unix 소켓 API를 제공한다.
export class AgentBridge {
  private readonly adapterById: Map<Provider, ProviderAdapter>;
  private server?: net.Server;

  constructor(private readonly dependencies: AgentBridgeDependencies) {
    this.adapterById = new Map(dependencies.adapters.map((adapter) => [adapter.id, adapter]));
  }

  // 실험실이 붙어 있지 않은 배포에서 experiment.* 호출을 명확히 거부한다.
  private requireExperiments(): NonNullable<AgentBridgeDependencies["experiments"]> {
    const experiments = this.dependencies.experiments;
    if (!experiments) throw new Error("이 서버에는 실험실이 연결되어 있지 않습니다.");
    return experiments;
  }

  private requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label}이 필요합니다.`);
    return value.trim();
  }

  private requireNumber(value: unknown, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label}이 필요합니다.`);
    return parsed;
  }

  // 소유자 전용 권한의 Unix 소켓을 열고 오래된 소켓 파일을 정리한다.
  async start(): Promise<void> {
    const { socketPath } = this.dependencies;
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    const existing = fs.lstatSync(socketPath, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isSocket()) throw new Error(`에이전트 브리지 경로에 소켓이 아닌 파일이 있습니다: ${socketPath}`);
      fs.unlinkSync(socketPath);
    }
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
  }

  // 새 연결에서 줄 단위 JSON 요청만 제한된 크기로 처리한다.
  private handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: "브리지 요청이 너무 큽니다." })}\n`);
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void this.handleLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
  }

  // JSON 요청 하나를 실행해 요청 ID와 함께 성공·오류 응답을 반환한다.
  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: AgentBridgeRequest;
    try {
      request = JSON.parse(line) as AgentBridgeRequest;
      const requestedTimeout = Number(request.params?.timeoutSeconds);
      if (request.method === "delegation.wait" || request.method === "delegation.send_wait") {
        const timeoutSeconds = Math.min(MAX_DELEGATION_TIMEOUT_SECONDS, Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_DELEGATION_TIMEOUT_SECONDS));
        socket.setTimeout((timeoutSeconds + 5) * 1000, () => socket.destroy());
      }
      const result = await this.execute(request);
      socket.write(`${JSON.stringify({ id: request.id ?? null, ok: true, result })}\n`);
    } catch (error) {
      let id: string | number | null = null;
      try {
        id = (JSON.parse(line) as AgentBridgeRequest).id ?? null;
      } catch {
        // 파싱 실패 응답에는 연결 가능한 요청 ID가 없다.
      }
      socket.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }

  // 허용된 브리지 메서드만 명시적으로 분기해 내부 서비스에 전달한다.
  async execute(request: AgentBridgeRequest): Promise<unknown> {
    const params = request.params ?? {};
    switch (request.method) {
      case "ping": return { ready: true };
      case "projects.list": return this.listProjects();
      case "chats.list": return this.listChats(params);
      case "context.get": return this.getContext(params);
      case "context.snapshot": return this.createSnapshot(params);
      case "delegation.send": return this.sendDelegation(params);
      case "delegation.send_wait": return this.sendDelegationAndWait(params);
      case "delegation.wait": return this.waitForDelegation(params);
      case "delegation.status": return this.getDelegation(params);
      case "experiment.fixtures": return this.requireExperiments().repository.listFixtures();
      case "experiment.fixture_create": return this.requireExperiments().repository.createFixture(params.fixture ?? params);
      case "experiment.list": return this.requireExperiments().repository.listExperiments(this.requireNumber(params.projectId, "projectId"));
      case "experiment.summary": return this.requireExperiments().summary(this.requireString(params.experimentId, "experimentId"));
      case "experiment.suite_summary": return this.requireExperiments().suiteSummary(this.requireString(params.suiteId, "suiteId"));
      case "experiment.cleanup": return this.requireExperiments().cleanupWorkspaces({
        experimentId: typeof params.experimentId === "string" ? params.experimentId : undefined,
        suiteId: typeof params.suiteId === "string" ? params.suiteId : undefined,
      });
      case "experiment.plans": return this.requireExperiments().repository.listRunPlans(this.requireString(params.experimentId, "experimentId"));
      case "experiment.plan_start": return this.requireExperiments().startRunPlan(this.requireString(params.experimentId, "experimentId"), {
        stage: params.stage, repetitions: params.repetitions,
      });
      case "experiment.plan_cancel": return this.requireExperiments().cancelRunPlan(this.requireString(params.planId, "planId"));
      default: throw new Error(`지원하지 않는 브리지 메서드입니다: ${request.method}`);
    }
  }

  // 활성 프로젝트의 식별 정보만 반환하고 파일 내용은 노출하지 않는다.
  private listProjects(): unknown {
    return {
      projects: this.dependencies.database.prepare(
        "SELECT id, name, path, updated_at FROM projects WHERE active = 1 ORDER BY updated_at DESC",
      ).all(),
    };
  }

  // 프로젝트 ID·경로·호출 위치 중 하나로 대상 프로젝트를 결정한다.
  private resolveProject(params: Record<string, unknown>): { id: number; name: string; path: string } {
    const projectId = Number(params.projectId);
    if (Number.isInteger(projectId) && projectId > 0) {
      const project = this.dependencies.database.prepare(
        "SELECT id, name, path FROM projects WHERE id = ? AND active = 1",
      ).get(projectId) as { id: number; name: string; path: string } | undefined;
      if (!project) throw new Error("등록된 프로젝트를 찾을 수 없습니다.");
      return project;
    }
    const explicitPath = typeof params.projectPath === "string" ? params.projectPath : "";
    const callerCwd = typeof params.cwd === "string" ? params.cwd : "";
    const candidate = explicitPath || callerCwd;
    if (candidate) {
      const actual = fs.realpathSync(candidate);
      const projects = this.dependencies.database.prepare(
        "SELECT id, name, path FROM projects WHERE active = 1 ORDER BY length(path) DESC",
      ).all() as Array<{ id: number; name: string; path: string }>;
      const project = projects.find((item) => actual === item.path || actual.startsWith(`${item.path}${path.sep}`));
      if (project) return project;
    }
    throw new Error("등록된 프로젝트 ID 또는 경로가 필요합니다.");
  }

  // 프로젝트의 공개 가능한 채팅 메타데이터를 최근 순으로 반환한다.
  private listChats(params: Record<string, unknown>): unknown {
    const project = this.resolveProject(params);
    const chats = this.dependencies.database.prepare(`
      SELECT id, project_id, provider, title, status, busy, model, updated_at
      FROM chats WHERE project_id = ? ORDER BY updated_at DESC LIMIT 300
    `).all(project.id) as Array<Record<string, unknown>>;
    return { project, chats: chats.filter((chat) => this.isVisibleChat(chat)) };
  }

  // 채팅 번호 또는 프로젝트·공급자로 읽을 세션을 결정한다.
  private resolveChat(params: Record<string, unknown>): BridgeChat {
    const chatId = Number(params.chatId);
    let chat: BridgeChat | undefined;
    if (Number.isInteger(chatId) && chatId > 0) {
      chat = this.dependencies.database.prepare(`
        SELECT id, project_id, provider, provider_session_id, tmux_name, title, status, busy, history_file, updated_at
        FROM chats WHERE id = ?
      `).get(chatId) as BridgeChat | undefined;
    } else {
      const project = this.resolveProject(params);
      const provider = params.provider === "codex" || params.provider === "claude" ? params.provider : undefined;
      chat = this.dependencies.database.prepare(`
        SELECT id, project_id, provider, provider_session_id, tmux_name, title, status, busy, history_file, updated_at
        FROM chats WHERE project_id = ? AND (? IS NULL OR provider = ?) ORDER BY updated_at DESC LIMIT 1
      `).get(project.id, provider ?? null, provider ?? null) as BridgeChat | undefined;
    }
    if (!chat || !this.isVisibleChat(chat as unknown as Record<string, unknown>)) throw new Error("채팅을 찾을 수 없습니다.");
    return chat;
  }

  // 내부 모니터 세션처럼 웹 목록에서 숨기는 기록은 브리지에서도 제외한다.
  private isVisibleChat(chat: Record<string, unknown>): boolean {
    const adapter = this.adapterById.get(chat.provider as Provider);
    const historyFile = typeof chat.history_file === "string" ? chat.history_file : "";
    return !historyFile || !adapter?.isHiddenHistoryFile?.(historyFile);
  }

  // 선택한 세션의 마지막 메시지를 크기 제한과 함께 구조화해 반환한다.
  private getContext(params: Record<string, unknown>): unknown {
    const chat = this.resolveChat(params);
    const requestedLimit = Number(params.limit);
    const limit = Math.min(MAX_CONTEXT_MESSAGES, Math.max(1, Number.isInteger(requestedLimit) ? requestedLimit : 60));
    const messages = this.historyMessages(chat);
    const selected = messages.slice(-limit);
    return {
      chat: {
        id: chat.id,
        projectId: chat.project_id,
        provider: chat.provider,
        title: chat.title,
        status: chat.status,
        busy: Boolean(chat.busy),
        updatedAt: chat.updated_at,
      },
      messages: selected,
      hasMore: messages.length > selected.length,
    };
  }

  // 채팅의 현재 공급자 기록을 읽고 아직 기록 파일이 없으면 빈 목록을 반환한다.
  private historyMessages(chat: BridgeChat): HistoryMessage[] {
    const adapter = this.adapterById.get(chat.provider);
    const session = chat.history_file && adapter ? this.dependencies.historyCache.get(adapter, chat.history_file) : null;
    return session?.messages ?? [];
  }

  // 현재 세션 문맥을 만료 시각이 있는 불변 스냅샷으로 저장한다.
  private createSnapshot(params: Record<string, unknown>): unknown {
    const context = this.getContext(params) as { chat: { id: number; projectId: number } };
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.dependencies.database.prepare(
      "INSERT INTO context_snapshots(id, project_id, source_chat_id, content_json, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, context.chat.projectId, context.chat.id, JSON.stringify(context), expiresAt);
    this.dependencies.database.prepare("DELETE FROM context_snapshots WHERE expires_at <= ?").run(new Date().toISOString());
    writeAudit(this.dependencies.database, null, "agent.context_snapshot", "chat", context.chat.id, { snapshotId: id });
    return { snapshotId: id, expiresAt, context };
  }

  // 대상 채팅이 없을 때 지정 프로젝트와 공급자로 새 채팅 레코드를 만든다.
  private createTargetChat(projectId: number, provider: Provider): BridgeChat {
    const adapter = this.adapterById.get(provider);
    if (!adapter) throw new Error("지원하지 않는 공급자입니다.");
    const placeholder = `pending_${crypto.randomUUID().replaceAll("-", "")}`;
    const created = this.dependencies.database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title) VALUES (?, ?, ?, 'starting', ?)
    `).run(projectId, provider, placeholder, `새 ${adapter.displayLabel} 채팅`);
    const chatId = Number(created.lastInsertRowid);
    this.dependencies.database.prepare("UPDATE chats SET tmux_name = ? WHERE id = ?").run(`web_agent_manager_chat_${chatId}`, chatId);
    this.dependencies.sessions.start(chatId, false);
    return this.resolveChat({ chatId });
  }

  // 명시한 대상 세션 또는 프로젝트의 공급자 세션에 작업을 중복 없이 전달한다.
  private async sendDelegation(params: Record<string, unknown>): Promise<unknown> {
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (!prompt || prompt.length > 100_000) throw new Error("전달할 작업은 1자 이상 100,000자 이하여야 합니다.");
    const sourceChatId = Number(params.sourceChatId);
    if (Number.isInteger(sourceChatId) && sourceChatId > 0) this.resolveChat({ chatId: sourceChatId });
    const idempotencyKey = typeof params.idempotencyKey === "string" && params.idempotencyKey.trim()
      ? params.idempotencyKey.trim().slice(0, 200)
      : crypto.randomUUID();
    const existing = this.dependencies.database.prepare(
      "SELECT id, source_chat_id, target_chat_id, status, error, created_at, updated_at FROM delegations WHERE idempotency_key = ?",
    ).get(idempotencyKey);
    if (existing) return { delegation: existing, duplicate: true };

    let target: BridgeChat;
    const targetChatId = Number(params.targetChatId);
    if (Number.isInteger(targetChatId) && targetChatId > 0) {
      target = this.resolveChat({ chatId: targetChatId });
    } else {
      const project = this.resolveProject(params);
      const provider = params.provider;
      if (provider !== "codex" && provider !== "claude") throw new Error("대상 공급자(codex 또는 claude)가 필요합니다.");
      if (params.createNew === true) {
        target = this.createTargetChat(project.id, provider);
      } else {
        const existingTarget = this.dependencies.database.prepare(`
          SELECT id, project_id, provider, provider_session_id, tmux_name, title, status, busy, history_file, updated_at
          FROM chats WHERE project_id = ? AND provider = ? ORDER BY updated_at DESC LIMIT 1
        `).get(project.id, provider) as BridgeChat | undefined;
        target = existingTarget && this.isVisibleChat(existingTarget as unknown as Record<string, unknown>)
          ? existingTarget
          : this.createTargetChat(project.id, provider);
      }
    }
    const validSourceChatId = Number.isInteger(sourceChatId) && sourceChatId > 0 ? sourceChatId : null;
    if (validSourceChatId === target.id) throw new Error("같은 채팅으로 작업을 다시 전달할 수 없습니다.");
    const parentDelegationId = typeof params.parentDelegationId === "string" && params.parentDelegationId.trim()
      ? params.parentDelegationId.trim()
      : null;
    const lineage = this.resolveDelegationLineage(parentDelegationId, validSourceChatId);
    if (lineage.depth > MAX_DELEGATION_DEPTH) throw new Error(`작업 전달 깊이는 ${MAX_DELEGATION_DEPTH}단계까지 허용합니다.`);
    if (lineage.chatIds.has(target.id)) throw new Error("조상 채팅으로 작업을 다시 전달할 수 없습니다.");

    const id = crypto.randomUUID();
    const baselineMessageCount = this.historyMessages(target).length;
    this.dependencies.database.prepare(`
      INSERT INTO delegations(
        id, idempotency_key, parent_delegation_id, depth, source_chat_id, target_chat_id,
        prompt, status, baseline_message_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, idempotencyKey, parentDelegationId, lineage.depth, validSourceChatId, target.id, prompt, baselineMessageCount);
    try {
      const deliveredPrompt = await this.dependencies.sessions.sendPrompt(target.id, prompt, null);
      this.dependencies.database.prepare(
        "UPDATE delegations SET status = 'sent', history_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(typeof deliveredPrompt === "string" ? deliveredPrompt : prompt, id);
      writeAudit(this.dependencies.database, null, "agent.delegate", "chat", target.id, { delegationId: id, sourceChatId: sourceChatId || null });
    } catch (error) {
      this.dependencies.database.prepare(
        "UPDATE delegations SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).run(error instanceof Error ? error.message : String(error), id);
      throw error;
    }
    return this.getDelegation({ delegationId: id });
  }

  // 새 자식 채팅 생성을 기본값으로 작업을 전달하고 같은 호출에서 완료 응답까지 기다린다.
  private async sendDelegationAndWait(params: Record<string, unknown>): Promise<unknown> {
    const sent = await this.sendDelegation({ ...params, createNew: params.createNew !== false }) as {
      delegation?: { id?: string };
    };
    const delegationId = sent.delegation?.id;
    if (!delegationId) throw new Error("작업 전달 ID를 확인할 수 없습니다.");
    return this.waitForDelegation({ delegationId, timeoutSeconds: params.timeoutSeconds });
  }

  // 전달 프롬프트 뒤의 새 assistant 응답과 idle 상태를 확인해 결과를 영속화하고 반환한다.
  private async waitForDelegation(params: Record<string, unknown>): Promise<unknown> {
    const delegationId = typeof params.delegationId === "string" ? params.delegationId : "";
    if (!delegationId) throw new Error("전달 ID가 필요합니다.");
    const requestedTimeout = Number(params.timeoutSeconds);
    const timeoutSeconds = Math.min(
      MAX_DELEGATION_TIMEOUT_SECONDS,
      Math.max(1, Number.isFinite(requestedTimeout) ? requestedTimeout : DEFAULT_DELEGATION_TIMEOUT_SECONDS),
    );
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      const completed = this.resolveDelegationResult(delegationId);
      if (completed) return completed;
      if (Date.now() >= deadline) return { ...(this.getDelegation({ delegationId }) as Record<string, unknown>), timedOut: true };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // 저장된 기준 메시지 이후의 실제 사용자 프롬프트와 완료 응답을 찾아 완료 상태로 확정한다.
  private resolveDelegationResult(delegationId: string): unknown | null {
    const delegation = this.dependencies.database.prepare(`
      SELECT id, source_chat_id, target_chat_id, prompt, history_prompt, status, error,
             baseline_message_count, result_json, completed_at
      FROM delegations WHERE id = ?
    `).get(delegationId) as BridgeDelegation | undefined;
    if (!delegation) throw new Error("작업 전달 기록을 찾을 수 없습니다.");
    if (delegation.completed_at && delegation.result_json) return this.getDelegation({ delegationId });
    if (delegation.status === "failed") return this.getDelegation({ delegationId });

    const chat = this.resolveChat({ chatId: delegation.target_chat_id });
    const messages = this.historyMessages(chat);
    const added = messages.slice(Math.min(delegation.baseline_message_count, messages.length));
    const expectedPrompt = (delegation.history_prompt ?? delegation.prompt).replace(/\r\n/g, "\n").trim();
    const promptIndex = added.findIndex((message) => message.role === "user"
      && message.content.replace(/\r\n/g, "\n").trim() === expectedPrompt);
    const resultMessages = promptIndex >= 0 ? added.slice(promptIndex + 1) : [];
    const response = [...resultMessages].reverse().find((message) => message.role === "assistant" && message.content.trim());
    if (response && !chat.busy) {
      const result = {
        response: response.content,
        messages: resultMessages.slice(-40),
        chat: { id: chat.id, provider: chat.provider, title: chat.title, status: chat.status, busy: Boolean(chat.busy) },
      };
      this.dependencies.database.prepare(`
        UPDATE delegations
        SET result_json = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(JSON.stringify(result), delegationId);
      return this.getDelegation({ delegationId });
    }
    if (!chat.busy && ["stopped", "error"].includes(chat.status)) {
      this.dependencies.database.prepare(`
        UPDATE delegations SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(`대상 채팅이 ${chat.status} 상태로 종료됐습니다.`, delegationId);
      return this.getDelegation({ delegationId });
    }
    return null;
  }

  // 부모 전달 체인을 따라 깊이와 이미 거친 채팅을 계산해 순환 위임을 차단한다.
  private resolveDelegationLineage(parentDelegationId: string | null, sourceChatId: number | null): { depth: number; chatIds: Set<number> } {
    const chatIds = new Set<number>();
    if (sourceChatId) chatIds.add(sourceChatId);
    if (!parentDelegationId) return { depth: 0, chatIds };
    let currentId: string | null = parentDelegationId;
    let expectedSource = sourceChatId;
    let depth = 0;
    while (currentId) {
      const parent = this.dependencies.database.prepare(`
        SELECT id, parent_delegation_id, depth, source_chat_id, target_chat_id FROM delegations WHERE id = ?
      `).get(currentId) as {
        id: string;
        parent_delegation_id: string | null;
        depth: number;
        source_chat_id: number | null;
        target_chat_id: number;
      } | undefined;
      if (!parent) throw new Error("부모 작업 전달 기록을 찾을 수 없습니다.");
      if (expectedSource && parent.target_chat_id !== expectedSource) throw new Error("부모 작업의 대상 채팅과 현재 원본 채팅이 일치하지 않습니다.");
      if (parent.source_chat_id) chatIds.add(parent.source_chat_id);
      chatIds.add(parent.target_chat_id);
      depth = Math.max(depth, parent.depth + 1);
      expectedSource = parent.source_chat_id;
      currentId = parent.parent_delegation_id;
      if (depth > MAX_DELEGATION_DEPTH) break;
    }
    return { depth, chatIds };
  }

  // 전달 레코드와 대상 채팅의 현재 상태를 함께 반환한다.
  private getDelegation(params: Record<string, unknown>): unknown {
    const id = typeof params.delegationId === "string" ? params.delegationId : "";
    if (!id) throw new Error("전달 ID가 필요합니다.");
    const delegation = this.dependencies.database.prepare(`
      SELECT d.id, d.parent_delegation_id, d.depth, d.source_chat_id, d.target_chat_id,
             d.status, d.error, d.result_json, d.completed_at, d.created_at, d.updated_at,
             c.provider, c.title, c.status AS chat_status, c.busy
      FROM delegations d JOIN chats c ON c.id = d.target_chat_id WHERE d.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!delegation) throw new Error("작업 전달 기록을 찾을 수 없습니다.");
    let result: unknown = null;
    if (typeof delegation.result_json === "string") {
      try {
        result = JSON.parse(delegation.result_json);
      } catch {
        result = null;
      }
    }
    const { result_json: _resultJson, ...publicDelegation } = delegation;
    if (publicDelegation.completed_at) publicDelegation.status = "completed";
    return { delegation: publicDelegation, result };
  }

  // 서버를 닫고 소켓 파일을 제거해 다음 시작에서 안전하게 다시 만들 수 있게 한다.
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const existing = fs.lstatSync(this.dependencies.socketPath, { throwIfNoEntry: false });
    if (existing?.isSocket()) fs.unlinkSync(this.dependencies.socketPath);
  }
}
