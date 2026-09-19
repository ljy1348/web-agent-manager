import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { AppDatabase } from "../core/database";
import type { ProviderAdapter, ProviderLaunch, TmuxIO } from "../providers/provider";
import type { AuthUser, ChatRecord, Provider } from "../../shared/types";
import type { RealtimeHub } from "./realtime";
import type { ApprovalService } from "./approval";
import type { Notifier } from "./notifier";
import type { AgentAccountService } from "./agent-accounts";
import type { ProviderRolloutService } from "./provider-rollout";
import type { CredentialVault } from "./credential-vault";
import { writeAudit } from "../core/audit";
import { stripAnsi } from "../core/security";
import { setChatBusy } from "../core/chat-busy";
import { createLogger } from "../core/logger";
import { pastePromptToTmux, sendTmuxEnter, sendTmuxEscape, sendTmuxBackspace, sendTmuxLeft, sendTmuxRight, sendTmuxShiftTab, sendTmuxText, scrollTmuxHistory, exitTmuxCopyMode, resizeTmuxWindow } from "./tmux-input";
import { parseResetTime } from "./rate-limit-resume";
import { TerminalScreen } from "./terminal-screen";
import { prepareChatPrompt } from "./chat-prompt";
import { promptCharacterCount } from "../../shared/chat-prompt";
import { PromptDeliveryUnknownError } from "./prompt-delivery";
import { CodexStructuredPreDeliveryError, type CodexStructuredTransportService } from "./codex-structured-transport";
import { projectProfileLaunch } from "./project-profile-launch";

// 가로 열 수를 바꾸면 이미 찍힌 tmux 스크롤백이 새 폭으로 다시 감기지 않아 한글·긴 줄이 깨질 수 있다.
// 따라서 256열은 고정하고, 줄바꿈에 영향을 주지 않는 세로 행 수만 웹 패널 높이에 맞춰 동기화한다.
const DEFAULT_COLS = 256;
const DEFAULT_ROWS = 36;
const MIN_ROWS = 12;
const MAX_ROWS = 120;

interface ManagedTerminal {
  pty: IPty;
  screen?: TerminalScreen;
  buffer: string;
  approvalFingerprint: string | null;
  approvalCandidateFingerprint: string | null;
  approvalVerifyTimer?: NodeJS.Timeout;
  tmuxName: string;
  rows: number;
  busyPollTimer?: NodeJS.Timeout;
  stateScanTimer?: NodeJS.Timeout;
  lastStateScanAt?: number;
  readySince?: number;
  copyMode?: boolean;
}

const TERMINAL_SCROLL_MAX_LINES = 200;
const TERMINAL_STATE_SCAN_THROTTLE_MS = 500;
const TERMINAL_STATE_IDLE_POLL_MS = 5_000;
// 웹 질문을 막 제출한 직후 CLI가 끝나면 history-sync의 다음 전체 발견(30초)보다 종료 이벤트가 먼저
// 올 수 있다. 그 채팅만 한 주기 기다렸다가 실제 기록이 붙었는지 재확인한다.
const EMPTY_CHAT_ACTIVITY_GRACE_MS = 35_000;
// 같은 판정 결과에서 스피너·경과 시간만 바뀌는 화면은 이 간격보다 자주 상세 로그를 남기지 않는다.
// debug 운영에서 0.5초마다 화면 전체가 직렬화되어 서버 힙과 로그 파일이 함께 커진 실측을 막는다.
const TERMINAL_STATE_LOG_INTERVAL_MS = 30_000;

interface ChatWithProject extends ChatRecord {
  project_path: string;
  workspace_path: string;
  preset_config_json: string | null;
}

interface PromptHistoryBaseline {
  file: string;
  userMessageIds: Set<string>;
  observedMtimeMs: number;
  observedSize: number;
}

export interface PromptDispatchOptions {
  // 원장에 접수된 명령은 확인 실패 시 초안을 지우거나 Enter를 반복하지 않는다. 외부 CLI가 멱등 키를
  // 받지 않으므로 불확실한 전달을 재시도하는 대신 상위 서비스가 delivery_unknown으로 보존한다.
  trackedDelivery?: boolean;
  // task ledger command ID를 app-server clientUserMessageId와 영속 ACK에 그대로 결합한다.
  commandId?: string;
}

export interface PromptDeliveryContext {
  adapter: "tui" | "codex_app_server";
  evidenceType: "tui_submission_confirmation" | "provider_turn_ack";
  supportsQueue: boolean;
}

// 사용자가 터미널 모드에서 수동 보존하는 단일 시점의 화면·판정 증거다. 화면과 판정을 따로 읽으면
// 그 사이 TUI가 바뀌어 다시 모순이 생길 수 있으므로 같은 snapshot 문자열에서 모두 계산한다.
export interface TerminalDiagnosticSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  serverPid: number;
  chat: {
    id: number;
    projectId: number;
    provider: Provider;
    title: string;
    status: ChatRecord["status"];
    busy: boolean;
    lastError: string | null;
    tmuxName: string;
    providerSessionId: string | null;
    historyFile: string | null;
  };
  terminal: { attached: true; rows: number; copyMode: boolean };
  classification: {
    isBusy: boolean;
    isReady: boolean;
    promptDraft: string | null;
    approval: { requestType: string; summary: string } | null;
    permissionMode: string | null;
  };
  pendingApprovals: Array<{ id: string; requestType: string; status: string; createdAt: string }>;
  screen: string;
}

type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

// 화면에 입력창이 있는지(초안이 남아 있어도 포함) 확인한다. 판정을 제공하지 않는 공급자는 false를 돌려
// 기존 isReady 경로만 쓰게 한다.
function hasPromptBox(adapter: ProviderAdapter, screen: string): boolean {
  return adapter.readPromptDraft ? adapter.readPromptDraft(screen) !== null : false;
}

// 기록 파일의 변경 여부를 비교할 수 있게 수정 시각·크기를 한 문자열로 돌려준다. 파일이 없으면 null.
function historyFileState(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

// tmux는 기본이 prefix 매칭이라 chat_1이 chat_10을 칠 수 있어, 정확 이름만 고른다.
function exactTmuxTarget(name: string): string {
  return `=${name}`;
}

// tmux가 지정 세션을 보유하고 있는지 확인한다. prefix 매칭으로 다른 채팅을 건드리지 않게 정확 이름을 쓴다.
function tmuxExists(name: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", exactTmuxTarget(name)], { stdio: "ignore" }).status === 0;
}

// 채팅별 tmux와 PTY 연결을 생성·복구·종료한다.
// TODO(임시 상세 로그): 상태 판정 오류 추적용. 문제가 안정화되면 호출부와 함께 제거하거나 레벨을 낮춘다.
const stateLog = createLogger("state-check");

export class SessionManager {
  // 원문 화면을 보관하면 채팅 수·화면 크기만큼 힙을 계속 붙드므로 짧은 해시와 판정만 기억한다.
  private lastStateLog = new Map<string, { fingerprint: string; result: string; loggedAt: number }>();

  // 상태 판정의 실제 입력(터미널 스냅샷)과 출력(판정 결과)을 그대로 로그에 남긴다.
  private logStateCheck(kind: string, chatId: number, snapshot: string, result: unknown): void {
    const key = `${kind}:${chatId}`;
    const resultText = JSON.stringify(result) ?? "";
    const fingerprint = crypto.createHash("sha256").update(snapshot).update("\u0000").update(resultText).digest("base64url");
    const previous = this.lastStateLog.get(key);
    if (previous?.fingerprint === fingerprint) return;
    const now = Date.now();
    if (previous?.result === resultText && now - previous.loggedAt < TERMINAL_STATE_LOG_INTERVAL_MS) return;
    this.lastStateLog.set(key, { fingerprint, result: resultText, loggedAt: now });
    stateLog.debug(kind, { chatId, out: result, in: snapshot });
  }

  // 종료된 채팅의 판정·프롬프트 캐시를 남기지 않는다. 서버가 오래 떠 있어도 과거 채팅 수에 비례해
  // 메모리가 늘어나지 않아야 한다.
  private clearChatCaches(chatId: number): void {
    for (const key of this.lastStateLog.keys()) if (key.endsWith(`:${chatId}`)) this.lastStateLog.delete(key);
    this.inputQueues.delete(chatId);
    this.lastPromptText.delete(chatId);
    this.promptSubmittedAt.delete(chatId);
  }

  private readonly terminals = new Map<number, ManagedTerminal>();
  private readonly adapters: Map<Provider, ProviderAdapter>;
  private readonly inputQueues = new Map<number, Promise<unknown>>();
  private readonly emptyExitCleanupTimers = new Map<number, NodeJS.Timeout>();
  // 중단 시 Claude가 자기 입력창에 복구해두는 텍스트를 정확한 길이만큼 Backspace로 지우기 위해 기억해둔다.
  private readonly lastPromptText = new Map<number, string>();
  // 채팅별 마지막 UserPromptSubmit 훅 도착 시각. 전송 확인의 제출 증거다(#98).
  private readonly promptSubmittedAt = new Map<number, number>();

  constructor(
    private readonly database: AppDatabase,
    adapters: ProviderAdapter[],
    private readonly realtime: RealtimeHub,
    private readonly approvals: ApprovalService,
    private readonly notifications: Notifier,
    private readonly accounts: AgentAccountService,
    private readonly providerRollouts?: Pick<ProviderRolloutService, "assignNewChat" | "resolveLaunch" | "observeChatStatus">,
    private readonly credentialVault?: Pick<CredentialVault, "withMcpEnvironment">,
    private readonly structuredTransport?: Pick<CodexStructuredTransportService, "claimOrOwn" | "owns" | "start" | "send" | "interrupt" | "stop" | "close" | "state">,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    approvals.setTerminalDecisionHandler((chatId, decision, requestType) => this.applyTerminalApproval(chatId, decision, requestType));
    approvals.setTerminalLiveCheckHandler((chatId, requestType) => this.isTerminalApprovalLive(chatId, requestType));
    realtime.setTerminalHandlers(
      (chatId, data, user) => this.writeTerminal(chatId, data, user),
      (chatId, _user, rows) => rows === undefined ? this.refreshTerminal(chatId) : this.resizeTerminal(chatId, rows),
      (chatId, lines) => this.scrollTerminal(chatId, lines),
      (chatId, rows) => this.resizeTerminal(chatId, rows),
    );
  }

  // DB에 실행 중으로 남은 tmux 세션을 서버 시작 시 다시 연결한다.
  restore(): void {
    const chats = this.database.prepare(`
      SELECT c.*, p.path AS project_path, COALESCE(c.worktree_path, p.path) AS workspace_path
      FROM chats c JOIN projects p ON p.id = c.project_id
      WHERE c.status IN ('starting', 'running', 'resuming')
    `).all() as ChatWithProject[];
    for (const chat of chats) {
      if (this.structuredTransport?.claimOrOwn(chat.id)) {
        void this.structuredTransport.start(chat.id).catch((error) => {
          if (error instanceof CodexStructuredPreDeliveryError) this.start(chat.id, Boolean(chat.provider_session_id));
        });
        continue;
      }
      if (tmuxExists(chat.tmux_name)) this.attach(chat);
      else this.setStatus(chat.id, "stopped", null);
    }
  }

  // 새 채팅 또는 저장된 공급자 세션을 tmux에서 시작한다. 예약 ID만 있고 실제 기록이 없는 빈 채팅은
  // resume하면 CLI가 즉시 종료되므로, 기록을 검증한 뒤 새 세션으로 안전하게 되돌린다.
  start(chatId: number, resume = false): void {
    let chat = this.getChat(chatId);
    if (this.structuredTransport?.claimOrOwn(chatId)) {
      const structuredState = this.structuredTransport.state(chatId).state;
      if (["delivery_unknown", "error"].includes(structuredState)) {
        throw new Error("Codex 구조화 전달 상태를 먼저 확인해야 세션을 시작할 수 있습니다.");
      }
      void this.structuredTransport.start(chatId).catch((error) => {
        // thread 연결 전 실패는 prompt가 전달될 수 없는 구간이라 TUI로 한 번 안전하게 되돌린다.
        if (error instanceof CodexStructuredPreDeliveryError) this.start(chatId, Boolean(this.getChat(chatId).provider_session_id));
      });
      return;
    }
    if (this.terminals.has(chatId)) return;
    if (tmuxExists(chat.tmux_name)) {
      this.attach(chat);
      return;
    }
    const adapter = this.adapters.get(chat.provider);
    if (!adapter) throw new Error("지원하지 않는 공급자입니다.");
    let shouldResume = resume;
    if (shouldResume && !this.hasResumableHistory(chat, adapter)) {
      // history_file이 없거나 사라졌거나 내부 session ID가 다르면 이 ID로 resume할 근거가 없다.
      // 파일 자체는 삭제하지 않고 DB 연결만 끊어, 빈 채팅을 새 세션으로 다시 사용할 수 있게 한다.
      this.database.prepare("UPDATE chats SET provider_session_id = NULL, history_file = NULL WHERE id = ?").run(chatId);
      chat = this.getChat(chatId);
      shouldResume = false;
    }
    if (shouldResume && !chat.provider_session_id) throw new Error("재개할 공급자 세션 ID가 없습니다.");
    if (!shouldResume) this.providerRollouts?.assignNewChat(chat.provider, chat.id);
    const newSessionId = this.reserveNewSessionId(chat, adapter, shouldResume);
    let launch: ProviderLaunch;
    try {
      const profile = projectProfileLaunch(chat.preset_config_json, chat.workspace_path);
      const baseLaunch = adapter.createLaunch(chat.workspace_path, shouldResume ? chat.provider_session_id! : undefined, newSessionId, profile);
      launch = this.providerRollouts?.resolveLaunch(chat.id, chat.provider, baseLaunch) ?? baseLaunch;
    } catch (error) {
      if (newSessionId) this.releaseUnusedSessionId(chatId, newSessionId);
      const message = error instanceof Error ? error.message : "rollout CLI를 확인하지 못했습니다.";
      this.setStatus(chatId, "error", message);
      throw error;
    }
    // -x/-y를 안 주면 tmux가 클라이언트 없는 세션을 자체 기본 크기(보통 80x24)로 만든다. Claude는
    // --ax-screen-reader 모드에서 시작 시점의 폭으로 이미 그려둔 과거 스크롤백을 나중에 attach()가
    // 120x36으로 리사이즈해도 다시 그리지 않아, 그 사이에 출력된 내용(특히 폭 계산이 더 예민한 한글
    // 같은 wide 문자가 많은 줄)이 원본 터미널(xterm.js)에서 계단식으로 밀려 보이는 문제가 있었다.
    // attach()의 pty.spawn과 같은 크기로 처음부터 만들어 이 불일치 자체를 없앤다.
    // 채팅에 할당된 계정의 설정 디렉터리를 환경변수로 실어 보낸다. 환경변수는 tmux 세션을 만드는
    // 이 시점에만 적용되므로, 이미 떠 있는 세션의 계정을 바꾸려면 세션을 종료하고 다시 시작해야 한다.
    const account = this.accounts.resolveForChat(chat.provider, chat.account_id);
    this.setStatus(chatId, shouldResume ? "resuming" : "starting", null);
    const spawnTerminal = (mcpEnvironment: Record<string, string>) => {
      const launchEnv = {
        ...(launch.env ?? {}),
        ...this.accounts.environment(account),
        ...mcpEnvironment,
        // MCP/CLI가 위임 시 부모 채팅을 알 수 있게 채팅 번호를 상속한다.
        WEB_AGENT_MANAGER_CHAT_ID: String(chat.id),
      };
      const args = ["new-session", "-d", "-s", chat.tmux_name, "-x", String(DEFAULT_COLS), "-y", String(DEFAULT_ROWS), "-c", chat.workspace_path];
      for (const [key, value] of Object.entries(launchEnv)) args.push("-e", `${key}=${value}`);
      args.push("--", launch.command, ...launch.args);
      return spawnSync("tmux", args, { encoding: "utf8", env: { ...process.env, ...launchEnv } });
    };
    const result = this.credentialVault
      ? this.credentialVault.withMcpEnvironment(chat.provider, chat.project_id, `chat:${chat.id}:launch`, spawnTerminal)
      : spawnTerminal({});
    if (result.status !== 0) {
      if (newSessionId) this.releaseUnusedSessionId(chatId, newSessionId);
      const message = result.stderr?.trim() || "tmux 세션을 시작하지 못했습니다.";
      this.setStatus(chatId, "error", message);
      throw new Error(message);
    }
    // tmux 상태바(맨 아래 "[세션명:창이름*]" 줄)는 절대 행 번호로 그려지는데, 웹에서는 이미 그 정보를
    // 채팅 헤더로 따로 보여주고 있어 불필요하다. 꺼두지 않으면 클라이언트가 이 상태바의 절대 위치
    // 갱신을 자기 뷰포트 기준으로 잘못 해석해 맨 아래 줄이 계속 새로 쌓이는 것처럼 보이는 문제가 있었다.
    spawnSync("tmux", ["set-option", "-t", exactTmuxTarget(chat.tmux_name), "status", "off"]);
    this.attach(this.getChat(chatId));
  }

  // 공급자 ID 문자열만 남은 상태를 실제 대화로 오인하지 않도록 파일과 내부 session ID까지 확인한다.
  private hasResumableHistory(chat: ChatWithProject, adapter: ProviderAdapter): boolean {
    if (!chat.provider_session_id || !chat.history_file) return false;
    try {
      if (!fs.statSync(chat.history_file).isFile()) return false;
      return adapter.parseHistoryFile(chat.history_file)?.sessionId === chat.provider_session_id;
    } catch {
      return false;
    }
  }

  // 새 대화에 `--session-id`를 쓸 수 있으면 UUID를 미리 정해 기록 동기화가 같은 채팅에 붙게 한다.
  private reserveNewSessionId(chat: ChatWithProject, adapter: ProviderAdapter, resume: boolean): string | undefined {
    if (resume || !adapter.supportsNewSessionId) return undefined;
    if (chat.provider_session_id) return chat.provider_session_id;
    const sessionId = crypto.randomUUID();
    this.database.prepare("UPDATE chats SET provider_session_id = ? WHERE id = ? AND provider_session_id IS NULL").run(sessionId, chat.id);
    return sessionId;
  }

  // tmux 생성에 실패하면 아직 기록이 없는 예약 ID를 지워 다음 시작이 새 대화로 가게 한다.
  private releaseUnusedSessionId(chatId: number, sessionId: string): void {
    this.database.prepare("UPDATE chats SET provider_session_id = NULL WHERE id = ? AND provider_session_id = ? AND history_file IS NULL").run(chatId, sessionId);
  }

  // 신규 session ID를 미리 정할 수 없는 채팅의 첫 프롬프트를 기록 동기화기와 공유한다. 제출 실패 시
  // 이 행만 지우고, 성공하면 HistorySynchronizer가 실제 첫 user 메시지와 맞춘 뒤 모두 소비한다.
  private createHistoryClaim(chatId: number, prompt: string): number | null {
    const chat = this.getChat(chatId);
    if (chat.history_file) return null;
    const result = this.database.prepare(`
      INSERT INTO chat_history_claims(chat_id, prompt, created_at) VALUES (?, ?, ?)
    `).run(chatId, prompt.replace(/\r\n/g, "\n").trim(), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  private releaseHistoryClaim(claimId: number | null): void {
    if (claimId !== null) this.database.prepare("DELETE FROM chat_history_claims WHERE id = ?").run(claimId);
  }

  // 터미널이 사라진 뒤에도 실제 사용자·assistant 메시지가 하나라도 있으면 채팅을 보존한다. 공급자가
  // 예약 UUID나 /exit 같은 로컬 명령만 기록한 경우는 대화가 아니므로 목록 row만 제거한다. JSONL은
  // 사용자가 명시적으로 삭제한 것이 아니므로 건드리지 않고 history-sync의 숨김 기록 정책에 맡긴다.
  private removeEmptyChatAfterTerminalExit(chatId: number, allowActivityGrace = true): boolean {
    const row = this.database.prepare(`
      SELECT provider, provider_session_id AS providerSessionId, history_file AS historyFile,
        last_user_activity_at AS lastUserActivityAt
      FROM chats WHERE id = ?
    `).get(chatId) as {
      provider: Provider;
      providerSessionId: string | null;
      historyFile: string | null;
      lastUserActivityAt: string | null;
    } | undefined;
    if (!row) return false;

    if (row.historyFile) {
      try {
        const session = this.getAdapter(row.provider).parseHistoryFile(row.historyFile);
        // 해석할 수 없는 파일은 데이터 유실 가능성이 있으므로 자동 삭제하지 않는다.
        if (!session) return false;
        if (session.messages.some((message) => message.role === "user" || message.role === "assistant")) return false;
      } catch {
        return false;
      }
    } else if (allowActivityGrace) {
      const hasClaim = !!this.database.prepare("SELECT 1 FROM chat_history_claims WHERE chat_id = ? LIMIT 1").get(chatId);
      if (hasClaim || row.lastUserActivityAt) {
        if (!this.emptyExitCleanupTimers.has(chatId)) {
          const timer = setTimeout(() => {
            this.emptyExitCleanupTimers.delete(chatId);
            this.removeEmptyChatAfterTerminalExit(chatId, false);
          }, EMPTY_CHAT_ACTIVITY_GRACE_MS);
          timer.unref();
          this.emptyExitCleanupTimers.set(chatId, timer);
        }
        return false;
      }
    }

    const removed = this.database.prepare("DELETE FROM chats WHERE id = ?").run(chatId).changes > 0;
    if (!removed) return false;
    const timer = this.emptyExitCleanupTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.emptyExitCleanupTimers.delete(chatId);
    writeAudit(this.database, null, "terminal.empty_chat_delete", "chat", chatId, {
      provider: row.provider,
      providerSessionId: row.providerSessionId,
    });
    this.realtime.broadcast("chat_deleted", { chatId, reason: "empty_terminal_exit" });
    return true;
  }

  // 한 채팅의 질문을 직렬화해 실행 중 또는 재개된 PTY에 전달한다. user가 null이면 rate-limit-resume
  // 같은 시스템 자동화가 보낸 것으로 보고 감사 로그의 행위자를 비워둔다.
  async sendPrompt(chatId: number, text: string, user: AuthUser | null, options: PromptDispatchOptions = {}): Promise<string> {
    // CLI 시작·큐 대기·실제 제출 성공과 무관하게, 사람이 웹에서 보내기를 누른 순간부터 새 유휴
    // 시간으로 센다. 시스템의 rate-limit 재개 입력은 사용자 활동으로 위장하지 않는다.
    if (user) {
      this.database.prepare("UPDATE chats SET last_user_activity_at = CURRENT_TIMESTAMP WHERE id = ?").run(chatId);
    }
    const previous = this.inputQueues.get(chatId) ?? Promise.resolve();
    const queued = previous.then(() => this.sendPromptNow(chatId, text, user, options));
    this.inputQueues.set(chatId, queued.catch(() => undefined));
    return await queued;
  }

  deliveryContext(chatId: number): PromptDeliveryContext {
    return this.structuredTransport?.owns(chatId)
      ? { adapter: "codex_app_server", evidenceType: "provider_turn_ack", supportsQueue: false }
      : { adapter: "tui", evidenceType: "tui_submission_confirmation", supportsQueue: true };
  }

  // 시스템 자동 입력은 종료된 세션을 되살리지 않고, 실행 중인 실제 터미널이 있을 때만 직렬 전송한다.
  async sendPromptIfRunning(chatId: number, text: string, user: AuthUser | null): Promise<boolean> {
    let sent = false;
    const previous = this.inputQueues.get(chatId) ?? Promise.resolve();
    const queued = previous.then(async () => {
      // 빈 터미널 종료 정리와 시스템 재개 타이머가 겹치면 대상 row가 이미 사라질 수 있다.
      if (!this.database.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)) return;
      const chat = this.getChat(chatId);
      const structured = this.structuredTransport?.owns(chatId) ?? false;
      if (chat.status !== "running" || chat.busy || (!structured && !this.terminals.has(chatId))) return;
      await this.sendPromptNow(chatId, text, user);
      sent = true;
    });
    this.inputQueues.set(chatId, queued.catch(() => undefined));
    await queued;
    return sent;
  }

  // 서버 상태 판정이 실제로 본 현재 화면을 상태·승인 판정과 함께 한 번에 캡처한다. 터미널 입력,
  // copy-mode, DB busy 값은 변경하지 않는 읽기 전용 진단 동작이며 파일 저장은 HTTP 라우터가 담당한다.
  captureTerminalDiagnostic(chatId: number): TerminalDiagnosticSnapshot {
    const chat = this.getChat(chatId);
    const terminal = this.terminals.get(chatId);
    if (!terminal) throw new Error("실행 중인 터미널이 없어 스냅샷을 찍을 수 없습니다.");
    const adapter = this.getAdapter(chat.provider);
    const screen = this.captureSnapshot(chatId);
    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      serverPid: process.pid,
      chat: {
        id: chat.id,
        projectId: chat.project_id,
        provider: chat.provider,
        title: chat.title,
        status: chat.status,
        busy: Boolean(chat.busy),
        lastError: chat.last_error,
        tmuxName: chat.tmux_name,
        providerSessionId: chat.provider_session_id,
        historyFile: chat.history_file,
      },
      terminal: { attached: true, rows: terminal.rows, copyMode: Boolean(terminal.copyMode) },
      classification: {
        isBusy: adapter.isBusy(screen),
        isReady: adapter.isReady(screen),
        promptDraft: adapter.readPromptDraft?.(screen) ?? null,
        approval: adapter.detectApproval(screen),
        permissionMode: adapter.detectPermissionMode?.(screen) ?? null,
      },
      pendingApprovals: this.database.prepare(`
        SELECT id, request_type AS requestType, status, created_at AS createdAt
        FROM approvals WHERE chat_id = ? AND status = 'pending' ORDER BY created_at ASC
      `).all(chatId) as TerminalDiagnosticSnapshot["pendingApprovals"],
      screen,
    };
  }

  // TUI 조작이 필요한 관리 작업(모델·이름 변경 등) 전에 이미 busy인 채팅은 시작부터 막는다. 안 그러면
  // waitUntilReady가 15초 내내 기다리다 "CLI가 입력 가능한 상태가 아닙니다"라는, 원인을 알 수 없는
  // 오류로 실패했다 — 실제로 정확히 이 채팅이 한창 응답을 생성 중일 때 모델 변경을 시도해 재현됨(대화가
  // 길게 이어지는 채팅일수록 반복적으로 겪게 됨). 처음부터 명확한 이유로 즉시 실패시킨다.
  private assertChatNotBusy(chat: ChatWithProject, action: string): void {
    if (chat.busy) throw new Error(`지금 응답을 생성 중이라 ${action}을 할 수 없습니다. 완료된 뒤 다시 시도해주세요.`);
  }

  // 선택한 모델 ID·번호와, 공급자가 지원하면 별도 추론 강도 명령까지 해당 채팅 TUI에 적용한다.
  async changeModel(chatId: number, modelIndex: number, modelId: string | null, effortId: string | null, user: AuthUser): Promise<void> {
    if (!Number.isInteger(modelIndex) || modelIndex < 1 || modelIndex > 20) throw new Error("유효하지 않은 모델 선택입니다.");
    const chat = this.getChat(chatId);
    this.assertChatNotBusy(chat, "모델 변경");
    const terminal = await this.waitUntilReady(chatId, chat.provider);
    const adapter = this.getAdapter(chat.provider);
    if (!adapter.applyModelSelection) throw new Error("이 공급자는 모델 변경을 지원하지 않습니다.");
    pastePromptToTmux(terminal.tmuxName, "/model");
    sendTmuxEnter(terminal.tmuxName);
    await adapter.applyModelSelection(this.tmuxIO(chatId, terminal.tmuxName, adapter), modelIndex, effortId, modelId);
    const effortCommand = effortId ? adapter.effortCommand?.(effortId) : null;
    if (effortId && adapter.effortCommand && !effortCommand) throw new Error("유효하지 않은 추론 강도 선택입니다.");
    if (effortCommand) {
      const effortTerminal = await this.waitUntilReady(chatId, chat.provider);
      pastePromptToTmux(effortTerminal.tmuxName, effortCommand);
      sendTmuxEnter(effortTerminal.tmuxName);
    }
    writeAudit(this.database, user.id, "chat.model_change", "chat", chatId, { modelIndex, modelId, effortId });
    void this.detectAndStoreModel(chatId, chat.provider, 8_000);
  }

  // 채팅 이름을 CLI의 /rename 명령으로 실제 세션(터미널에서 claude --resume·codex resume으로 찾을 때
  // 쓰는 이름)에도 반영하고, web-agent-manager 자체 title도 같은 값으로 즉시 갱신한다. Claude·Codex 둘 다
  // "/rename <이름>"을 인자와 함께 한 줄로 바로 실행하는 동일한 문법이라(공급자별 메뉴 탐색이 필요한
  // /model과 달리) 어댑터 분기 없이 공통으로 처리한다. 화면에서 확인 문구를 다시 파싱하는 대신, 사용자가
  // 입력한 값을 그대로 즉시 반영해 화면이 곧바로 갱신되게 한다(확인 문구 형식이 버전마다 달라질 수 있음).
  async renameSession(chatId: number, name: string, user: AuthUser): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) throw new Error("이름은 1자 이상 200자 이하여야 합니다.");
    const chat = this.getChat(chatId);
    const adapter = this.getAdapter(chat.provider);
    if (!adapter.supportsSessionRename) throw new Error(`${adapter.displayLabel} CLI는 세션 이름 변경을 지원하지 않습니다.`);
    this.assertChatNotBusy(chat, "이름 변경");
    const terminal = await this.waitUntilReady(chatId, chat.provider);
    pastePromptToTmux(terminal.tmuxName, `/rename ${trimmed}`);
    sendTmuxEnter(terminal.tmuxName);
    // title_source='manual'로 표시해야 history-sync가 이후 자동 파생 제목으로 다시 덮어쓰지 않는다.
    this.database.prepare("UPDATE chats SET title = ?, title_source = 'manual' WHERE id = ?").run(trimmed, chatId);
    this.realtime.broadcast("chat_title", { chatId, title: trimmed });
    writeAudit(this.database, user.id, "chat.rename", "chat", chatId, { title: trimmed });
  }

  // 채팅이 쓸 인증 계정을 바꾼다. 환경변수는 tmux 세션 생성 시점에만 적용되므로 실행 중에는 바꿀 수 없고,
  // 이미 다른 계정에서 만들어진 공급자 세션은 그 계정 폴더에만 기록이 있어 재개도 불가능하다.
  // 그래서 계정을 옮기면 세션 연결을 끊고 다음 시작은 새 대화로 진행한다.
  assignAccount(chatId: number, accountId: number | null, user: AuthUser): void {
    const chat = this.getChat(chatId);
    if (this.structuredTransport?.owns(chatId)) {
      throw new Error("Codex app-server 후보 채팅은 인증 계정을 바꿀 수 없습니다.");
    }
    if (this.terminals.has(chatId) || tmuxExists(chat.tmux_name)) {
      throw new Error("실행 중인 채팅은 계정을 바꿀 수 없습니다. 먼저 채팅을 종료해주세요.");
    }
    const account = this.accounts.requireForProvider(chat.provider, accountId);
    if (account.id === chat.account_id) return;
    // 옛 계정의 세션 ID를 그대로 두면 다음 시작에서 그 계정에 없는 세션을 재개하려다 실패한다.
    // 기록 파일 자체는 지우지 않으므로 계정을 되돌리면 이전 대화를 다시 이어갈 수 있다.
    this.database.prepare("UPDATE chats SET account_id = ?, provider_session_id = NULL, history_file = NULL WHERE id = ?")
      .run(account.id, chatId);
    this.realtime.broadcast("chat_account", { chatId, accountId: account.id });
    writeAudit(this.database, user.id, "chat.assign_account", "chat", chatId, { accountId: account.id, label: account.label });
  }

  // /model 화면이 실제로 열린 뒤에만 다음 번호 키를 보내도록 대기한다.
  private async waitForModelMenu(chatId: number, adapter: ProviderAdapter, part: "models" | "efforts", timeoutMs: number): Promise<boolean> {
    if (!adapter.parseModelOptions) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = this.captureSnapshot(chatId);
      const hasMenu = adapter.isModelMenu?.(snapshot, part) ?? (part === "models" && adapter.parseModelOptions(snapshot).models.length > 0);
      if (hasMenu) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  // 종료 상태면 정확한 세션을 재개하고 입력 가능 프롬프트 뒤 질문을 전송한다.
  private async sendPromptNow(chatId: number, text: string, user: AuthUser | null, options: PromptDispatchOptions = {}): Promise<string> {
    let chat = this.getChat(chatId);
    let adapter = this.getAdapter(chat.provider);
    if (this.structuredTransport?.owns(chatId)) {
      const prepared = prepareChatPrompt(chatId, chat.project_path, chat.workspace_path, text);
      try {
        const delivered = await this.structuredTransport.send(chatId, options.commandId ?? crypto.randomUUID(), prepared.terminalText);
        setChatBusy(this.database, this.realtime, chatId, true);
        writeAudit(this.database, user?.id ?? null, "chat.prompt", "chat", chatId, {
          length: text.length,
          deliveredLength: delivered.length,
          attachmentPath: prepared.attachmentPath,
          transport: "app_server",
        });
        if (user) this.database.prepare("UPDATE chats SET origin = 'user' WHERE id = ? AND origin = 'delegation'").run(chatId);
        return delivered;
      } catch (error) {
        if (!(error instanceof CodexStructuredPreDeliveryError)) throw error;
        // app-server thread가 생기기 전 실패만 안전하다. 임시 장문 첨부를 정리하고 같은 원문을 TUI
        // 준비 경로에서 다시 만들며, turn/start 이후 오류는 위에서 절대 이 분기로 들어오지 않는다.
        prepared.cleanup();
        if (!this.terminals.has(chatId)) this.start(chatId, Boolean(this.getChat(chatId).provider_session_id));
        chat = this.getChat(chatId);
        adapter = this.getAdapter(chat.provider);
      }
    }
    // resume 세션은 화면 busy 신호보다 실제 JSONL user turn을 제출 증거로 삼는다. 시작 이벤트나 과거
    // 화면 재생만으로 파일이 바뀌어도 기존 user ID 집합과 구분할 수 있게 전송 전에 기준선을 잡는다.
    const historyBaseline = chat.provider === "codex" ? this.capturePromptHistoryBaseline(chat, adapter) : null;
    const alreadyRunning = this.terminals.has(chatId);
    if (!alreadyRunning) {
      this.start(chatId, Boolean(chat.provider_session_id));
    }
    // 세션이 이미 떠 있으면 터미널에 직접 타이핑하는 것과 마찬가지로, CLI가 응답을 생성 중이어도
    // 그 입력창에 그대로 큐잉된다(Claude·Codex TUI 둘 다 지원). 여기서까지 idle 프롬프트를
    // 기다리면, 작업이 15초 넘게 걸리는 정상적인 경우에도 "CLI가 입력 가능한 상태가 되지
    // 않았습니다" 오류로 전송 자체가 씹혀버린다. 다만 start()는 TUI 준비 전에 terminal map과
    // running 상태를 먼저 만들므로, busy도 ready도 아닌 화면은 새 세션 초기화 중으로 보고 기다린다.
    const existingTerminal = this.terminals.get(chatId);
    const currentSnapshot = alreadyRunning ? this.captureSnapshot(chatId) : "";
    // 이미 오류로 남은 채팅에서 또 idle 프롬프트를 기다리면, 매 전송이 15초를 기다렸다 실패하고 다시
    // 오류로 덮어써 사용자가 스스로 복구할 방법이 없는 교착이 된다. 실행 중인 터미널이 있으면 터미널에
    // 직접 타이핑하는 것과 같으므로 그대로 전송하고, 성공하면 바로 아래에서 상태를 되돌린다.
    const canTypeDirectly = chat.busy || chat.status === "error" || adapter.isBusy(currentSnapshot) || adapter.isReady(currentSnapshot);
    const terminal = alreadyRunning && existingTerminal && canTypeDirectly
      ? existingTerminal
      : await this.waitUntilReady(chatId, chat.provider);
    // waitUntilReady를 건너뛴 경우에도, 이전에 타임아웃으로 남은 오류 상태는 여기서 정상으로 되돌린다
    // (실제 전송이 되고 있다는 뜻이므로 더 이상 오류가 아니다).
    if (alreadyRunning && chat.status === "error") this.setStatus(chatId, "running", null);
    const prepared = prepareChatPrompt(chatId, chat.project_path, chat.workspace_path, text);
    const terminalText = prepared.terminalText;
    const slashCommand = terminalText.trim().startsWith("/");
    const historyClaimId = slashCommand ? null : this.createHistoryClaim(chatId, terminalText);
    // 작업 중 추가 입력은 TUI 큐에 들어가므로, 중지 후 복구·정리할 원래 실행 질문을 후속 입력으로
    // 덮어쓰지 않는다.
    if (!chat.busy) this.lastPromptText.set(chatId, terminalText);
    // 누군가 웹에서 기록을 위로 올려둔 상태면 붙여넣기·Enter가 copy-mode에 먹히므로 먼저 되돌린다.
    this.leaveCopyMode(terminal);
    const sentAt = Date.now();
    try {
      this.clearPromptDraft(chatId, adapter, terminal.tmuxName);
      pastePromptToTmux(terminal.tmuxName, terminalText);
      // 붙여넣기가 입력창에 반영되기 전에 Enter가 가면 TUI가 빠른 입력 중의 Enter로 보고 줄바꿈으로
      // 처리할 수 있다(#98). 초안이 보일 때까지 짧게 기다린 뒤 안정화 지연을 둔다.
      if (!slashCommand) await this.waitForPastedDraft(chatId, adapter, 800);
      const pasteDelay = adapter.promptQuirks?.pasteSubmitDelayMs;
      if (pasteDelay) await new Promise((resolve) => setTimeout(resolve, pasteDelay));
      sendTmuxEnter(terminal.tmuxName);
      // Codex는 "/"로 시작하는 입력에 자동완성 목록을 띄우므로, 첫 Enter는 목록 확정이고
      // 실제 실행에는 Enter가 한 번 더 필요하다(stop()의 /exit 처리와 동일한 이유).
      const slashDelay = adapter.promptQuirks?.slashCommandConfirmDelayMs;
      if (slashDelay && slashCommand) {
        await new Promise((resolve) => setTimeout(resolve, slashDelay));
        sendTmuxEnter(terminal.tmuxName);
      }
      // 일반 프롬프트는 유휴·작업 중 모두 실제 제출을 확인한다(#98). 작업 중 입력은 TUI 대기열로 들어가
      // 입력창이 비워지는 것으로 확인한다. 실패는 글이 입력창에 계속 남아 있을 때만 판정한다.
      if (!slashCommand && adapter.promptQuirks?.verifyPromptSubmission) {
        const submitted = await this.confirmPromptSubmission(
          chatId,
          adapter,
          terminal.tmuxName,
          historyBaseline,
          terminalText,
          sentAt,
          chat.history_file ?? null,
          !options.trackedDelivery,
        );
        if (!submitted) {
          if (options.trackedDelivery) {
            throw new PromptDeliveryUnknownError(
              `${adapter.displayLabel}에 메시지 입력을 시도했지만 제출 여부를 확인하지 못했습니다. 자동 재전송하지 않고 확인 필요 상태로 보존했습니다.`,
              crypto.createHash("sha256").update(terminalText.replace(/\r\n/g, "\n").trim()).digest("hex"),
            );
          }
          const draft = adapter.readPromptDraft?.(this.captureSnapshot(chatId));
          sendTmuxBackspace(terminal.tmuxName, draft ? promptCharacterCount(draft) : promptCharacterCount(terminalText));
          throw new Error(`${adapter.displayLabel}가 메시지 제출을 확인하지 못했습니다. 입력 내용을 복구했으니 다시 시도해주세요.`);
        }
      }
    } catch (error) {
      const deliveryUnknown = error instanceof PromptDeliveryUnknownError;
      // 불확실 전달은 뒤늦은 JSONL·훅과 대조할 기준선과 장문 첨부를 보존한다. 일반적인 전송 전
      // 거부·실패만 이전처럼 임시 claim/첨부를 정리한다.
      if (!deliveryUnknown) {
        this.releaseHistoryClaim(historyClaimId);
        prepared.cleanup();
      }
      // 전송 전부터 작업 중이던 채팅은 후속 입력 하나가 실패해도 진행 중인 턴은 그대로다. 예전에는 무조건
      // busy를 꺼서 작업 중인 채팅이 "대기중"으로 보였다(#103).
      if (!deliveryUnknown && !chat.busy) setChatBusy(this.database, this.realtime, chatId, false);
      throw error;
    }
    // 새 assistant 메시지가 JSONL에 나타나면 history-sync가 chat_busy:false로 정리한다.
    setChatBusy(this.database, this.realtime, chatId, true);
    writeAudit(this.database, user?.id ?? null, "chat.prompt", "chat", chatId, {
      length: text.length,
      deliveredLength: terminalText.length,
      attachmentPath: prepared.attachmentPath,
    });
    // 사람이 직접 쓰기 시작한 위임 채팅은 일반 목록에서 다시 찾을 수 있게 한다.
    if (user) this.database.prepare("UPDATE chats SET origin = 'user' WHERE id = ? AND origin = 'delegation'").run(chatId);
    // /model 명령 뒤에는 배너가 다시 그려지므로 잠시 후 재감지해 캐시된 모델명을 갱신한다.
    if (terminalText.trim().startsWith("/model")) void this.detectAndStoreModel(chatId, chat.provider, 8_000);
    return terminalText;
  }

  // 입력창에 남아 있던 미전송 초안을 지운다. 취소된 질문이 CLI에 복구되어 있거나 앞선 전송의 Enter가
  // 먹지 않아 글자가 남은 상태에서 그대로 붙여넣으면 두 입력이 한 줄로 이어붙어 엉뚱한 질문이 전송된다.
  // 웹 채팅 입력은 "지금 보낸 것"이 그대로 전송돼야 하므로 남은 초안은 새 입력으로 덮어쓴다.
  private clearPromptDraft(chatId: number, adapter: ProviderAdapter, tmuxName: string): void {
    const draft = adapter.readPromptDraft?.(this.captureSnapshot(chatId));
    if (draft) sendTmuxBackspace(tmuxName, promptCharacterCount(draft));
  }

  private capturePromptHistoryBaseline(chat: ChatWithProject, adapter: ProviderAdapter): PromptHistoryBaseline | null {
    if (!chat.history_file) return null;
    try {
      const stat = fs.statSync(chat.history_file);
      const session = adapter.parseHistoryFile(chat.history_file);
      if (!session) return null;
      return {
        file: chat.history_file,
        userMessageIds: new Set(session.messages.filter((message) => message.role === "user").map((message) => message.id)),
        observedMtimeMs: stat.mtimeMs,
        observedSize: stat.size,
      };
    } catch {
      return null;
    }
  }

  private hasNewRecordedUserMessage(adapter: ProviderAdapter, baseline: PromptHistoryBaseline, expectedPrompt: string): boolean {
    try {
      const stat = fs.statSync(baseline.file);
      if (stat.mtimeMs === baseline.observedMtimeMs && stat.size === baseline.observedSize) return false;
      const session = adapter.parseHistoryFile(baseline.file);
      if (!session) return false;
      baseline.observedMtimeMs = stat.mtimeMs;
      baseline.observedSize = stat.size;
      // CLI가 줄바꿈·연속 공백을 다르게 기록해도 같은 질문으로 본다.
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      const expected = normalize(expectedPrompt);
      return session.messages.some((message) => message.role === "user"
        && !baseline.userMessageIds.has(message.id)
        && normalize(message.content) === expected);
    } catch {
      return false;
    }
  }

  // UserPromptSubmit 훅이 온 시각을 기록한다(#98). 전송 확인에서 가장 확실한 제출 증거로 쓴다.
  notePromptSubmitted(chatId: number): void {
    this.promptSubmittedAt.set(chatId, Date.now());
  }

  // 붙여넣은 글이 입력창에 보일 때까지 기다린다. 판독을 지원하지 않거나 끝내 안 보이면 그대로 진행한다.
  private async waitForPastedDraft(chatId: number, adapter: ProviderAdapter, timeoutMs: number): Promise<void> {
    if (!adapter.readPromptDraft) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (adapter.readPromptDraft(this.captureSnapshot(chatId))) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // Enter 뒤 실제 제출(또는 작업 중 대기열 진입)을 확인하고, 글이 입력창에 남아 있으면 Enter를 재시도한다(#98).
  // 성공 증거: UserPromptSubmit 훅, 새 JSONL user 기록, JSONL 대기열 기록(Claude 작업 중 입력, #103), 입력창이
  // 비워짐, 입력창 없이 작업중. 실패는 글이 입력창에 계속 남아 있을 때만 판정한다 — Codex는 대기열·기록 지연으로
  // JSONL user 레코드를 수 초~수십 초 늦게 쓰는데, 예전에는 1.8초 안에 그 레코드만 찾다가 실제로 전송된 입력을
  // 지우고 실패를 알렸다.
  private async confirmPromptSubmission(
    chatId: number,
    adapter: ProviderAdapter,
    tmuxName: string,
    historyBaseline: PromptHistoryBaseline | null,
    expectedPrompt: string,
    sentAt: number,
    historyFile: string | null = null,
    retrySubmission = true,
  ): Promise<boolean> {
    const readsDraft = typeof adapter.readPromptDraft === "function";
    const deadline = Date.now() + 6_000;
    let nextRetryAt = Date.now() + 900;
    let retries = 0;
    let lastDraft: string | null = null;
    // 대기열 기록은 파일이 바뀌었을 때만 다시 읽는다(100ms마다 끝부분을 읽지 않도록).
    let queueFileState = "";
    while (Date.now() < deadline) {
      if ((this.promptSubmittedAt.get(chatId) ?? 0) >= sentAt) return true;
      if (historyBaseline && this.hasNewRecordedUserMessage(adapter, historyBaseline, expectedPrompt)) return true;
      if (historyFile && adapter.hasQueuedPrompt) {
        const state = historyFileState(historyFile);
        if (state && state !== queueFileState) {
          queueFileState = state;
          if (adapter.hasQueuedPrompt(historyFile, expectedPrompt, sentAt)) return true;
        }
      }
      const snapshot = this.captureSnapshot(chatId);
      const initializing = adapter.isInitializing?.(snapshot) ?? false;
      let stuck: boolean;
      if (readsDraft) {
        // 새 Codex가 MCP를 부팅하는 동안에는 붙여넣은 프롬프트가 입력창에 남아 있어도 "esc to interrupt"
        // 때문에 isBusy가 true다. 실제 초안이 남아 있으면 busy 신호보다 우선해 아직 제출되지 않은 것으로 본다.
        const draft = adapter.readPromptDraft!(snapshot);
        if (draft !== null) lastDraft = draft;
        if (!initializing && (draft === "" || (draft === null && adapter.isBusy(snapshot)))) return true;
        stuck = !!draft;
      } else {
        // 입력창을 읽지 못하는 공급자는 예전 규칙을 따른다: 연결된 기록이 있으면 기록만 증거로 인정한다.
        if (!historyBaseline && !initializing && (adapter.isBusy(snapshot) || adapter.isReady(snapshot))) return true;
        stuck = true;
      }
      if (retrySubmission && stuck && retries < 3 && Date.now() >= nextRetryAt) {
        sendTmuxEnter(tmuxName);
        retries += 1;
        nextRetryAt = Date.now() + 1_500;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 입력창을 읽을 수 있는데 글이 남아 있지 않았다면 실패를 증명할 수 없다(승인 화면 등). 지우지 않는다.
    return readsDraft && !lastDraft;
  }

  // 시작·모델 변경 배너가 나타날 때까지 기다렸다가 감지된 모델명을 저장하고 웹에 알린다.
  // terminal.buffer는 스피너 등 과거 프레임까지 누적된 원시 로그라 오검출될 수 있어, tmux가 그려주는
  // 현재 화면 스냅샷(captureSnapshot)만 본다.
  private async detectAndStoreModel(chatId: number, provider: Provider, timeoutMs: number): Promise<void> {
    const adapter = this.adapters.get(provider);
    if (!adapter) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = this.terminals.has(chatId) ? this.captureSnapshot(chatId) : "";
      const model = snapshot ? adapter.detectModel(snapshot) : null;
      this.logStateCheck("model", chatId, snapshot, model);
      if (model) {
        const current = this.database.prepare("SELECT model FROM chats WHERE id = ?").get(chatId) as { model: string | null } | undefined;
        if (current?.model !== model) {
          this.database.prepare("UPDATE chats SET model = ? WHERE id = ?").run(model, chatId);
          this.realtime.broadcast("chat_model", { chatId, model });
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  // Claude 하단 상태줄이 렌더링될 때까지 기다렸다가 감지된 권한 모드를 저장하고 웹에 알린다.
  // 터미널 부착 직후(아직 onData가 안 왔을 수 있음) 초기값을 채우는 용도.
  private async detectAndStorePermissionMode(chatId: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.storePermissionModeIfChanged(chatId, this.terminals.has(chatId) ? this.captureSnapshot(chatId) : "")) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  // onData가 올 때마다 현재 tmux 스냅샷에서 권한 모드를 다시 읽어 변경분만 저장·알림한다(Shift+Tab
  // 전환 직후 다음 화면 갱신에서 곧바로 반영됨).
  private detectPermissionModeChange(chatId: number, snapshot?: string): void {
    this.storePermissionModeIfChanged(chatId, snapshot ?? this.captureSnapshot(chatId));
  }

  // 스냅샷에서 권한 모드를 감지해 이전과 다르면 DB에 저장하고 브로드캐스트한다. 감지·갱신했으면 true.
  private storePermissionModeIfChanged(chatId: number, snapshot: string): boolean {
    const chat = this.getChat(chatId);
    const mode = snapshot ? this.getAdapter(chat.provider).detectPermissionMode?.(snapshot) ?? null : null;
    this.logStateCheck("permission-mode", chatId, snapshot, mode);
    if (!mode) return false;
    const current = this.database.prepare("SELECT permission_mode FROM chats WHERE id = ?").get(chatId) as { permission_mode: string | null } | undefined;
    if (current?.permission_mode !== mode) {
      this.database.prepare("UPDATE chats SET permission_mode = ? WHERE id = ?").run(mode, chatId);
      this.realtime.broadcast("chat_permission_mode", { chatId, mode });
    }
    return true;
  }

  // TUI 프롬프트가 화면에 나타날 때까지 제한 시간 동안 기다린다. 입력창에 미전송 초안이 남아 있어도
  // 입력 자체는 가능하므로 준비된 것으로 본다 — isReady는 빈 입력창만 인정해서(제출 확인이 그 성질에
  // 의존한다) 초안이 남으면 isReady·isBusy가 동시에 false가 되고, 매 전송이 15초 뒤 실패하며 상태를
  // 다시 error로 덮어써 사용자가 스스로 복구할 수 없는 교착이 됐다(채팅 #257에서 실제로 겪음).
  private async waitUntilReady(chatId: number, provider: Provider): Promise<ManagedTerminal> {
    const existing = this.terminals.get(chatId);
    if (existing) this.leaveCopyMode(existing);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const terminal = this.terminals.get(chatId);
      const buffered = terminal ? stripAnsi(terminal.buffer).slice(-4_000) : "";
      const snapshot = terminal ? this.captureSnapshot(chatId) : "";
      const adapter = this.getAdapter(provider);
      // 승인·선택 메뉴에는 입력창이 없어, 붙여넣은 글자가 그대로 메뉴 키 입력으로 새어 들어간다.
      // 15초를 기다렸다 원인을 알 수 없는 타임아웃을 내는 대신 곧바로 이유를 알려주고 막는다.
      if (terminal && adapter.detectApproval(snapshot)) {
        throw new Error("지금은 승인 요청이 떠 있어 입력을 보낼 수 없습니다. 승인 카드에서 먼저 처리해주세요.");
      }
      const initializing = adapter.isInitializing?.(snapshot) ?? false;
      if (terminal && !initializing && (adapter.isReady(`${buffered}\n${snapshot}`) || hasPromptBox(adapter, snapshot))) {
        const current = this.database.prepare("SELECT status FROM chats WHERE id = ?").get(chatId) as { status: string } | undefined;
        if (current?.status === "error") this.setStatus(chatId, "running", null);
        return terminal;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.setStatus(chatId, "error", "CLI 입력 준비 시간을 초과했습니다.");
    throw new Error("CLI가 입력 가능한 상태가 되지 않았습니다.");
  }

  // 브라우저 터미널의 원시 키 입력을 연결된 PTY에 전달한다.
  writeTerminal(chatId: number, data: string, user: AuthUser): void {
    const terminal = this.terminals.get(chatId);
    if (!terminal) throw new Error("실행 중인 터미널이 없습니다.");
    this.leaveCopyMode(terminal);
    terminal.pty.write(data);
    writeAudit(this.database, user.id, "terminal.input", "chat", chatId, { bytes: Buffer.byteLength(data) });
  }

  // 브라우저 터미널의 휠·스와이프를 tmux 기록(copy-mode) 이동으로 옮긴다. 양수는 과거, 음수는
  // 현재 방향이다. 웹 터미널은 tmux attach 클라이언트라 xterm 자체 스크롤백이 항상 비어 있어,
  // 이 경로가 없으면 실제 CLI처럼 이전 내역을 되짚어 볼 방법이 없다.
  scrollTerminal(chatId: number, lines: number): void {
    const terminal = this.terminals.get(chatId);
    if (!terminal) return;
    const amount = Math.trunc(Math.max(-TERMINAL_SCROLL_MAX_LINES, Math.min(TERMINAL_SCROLL_MAX_LINES, lines)));
    if (!amount) return;
    terminal.copyMode = scrollTmuxHistory(terminal.tmuxName, amount);
  }

  // 데스크톱 패널 높이에 맞춰 PTY·tmux·서버 화면의 세로 행 수를 함께 바꾼다.
  resizeTerminal(chatId: number, rows: number): void {
    const terminal = this.terminals.get(chatId);
    if (!terminal) return;
    const nextRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.trunc(rows)));
    if (nextRows !== terminal.rows) {
      this.leaveCopyMode(terminal);
      terminal.rows = nextRows;
      terminal.screen?.resize(DEFAULT_COLS, nextRows);
      terminal.pty.resize(DEFAULT_COLS, nextRows);
      resizeTmuxWindow(terminal.tmuxName, DEFAULT_COLS, nextRows);
    }
    this.refreshTerminal(chatId);
  }

  // 기록 보기 중에는 키 입력이 copy-mode 키 테이블에 먹히고 화면 스냅샷도 과거 내용이라, 입력·상태
  // 판정 전에 실시간 화면으로 되돌린다(실제 터미널에서 스크롤 중 타이핑하면 맨 아래로 돌아오는 것과 같다).
  private leaveCopyMode(terminal: ManagedTerminal): void {
    if (!terminal.copyMode) return;
    terminal.copyMode = false;
    exitTmuxCopyMode(terminal.tmuxName);
  }

  // 새 웹 클라이언트가 구독할 때 누적된 원시 바이트를 재생하는 대신 tmux가 그려주는 현재 화면 스냅샷을 전달한다.
  // 원시 바이트 재생은 120,000자 절단 시 ANSI 이스케이프 시퀀스 중간이 잘려 깨진 글자·중복 줄로 보이는 문제가 있었다.
  private captureSnapshot(chatId: number): string {
    const terminal = this.terminals.get(chatId);
    return terminal?.screen?.visibleText() ?? "";
  }

  // 새 웹 클라이언트에 현재 화면·커서 초기 프레임을 즉시 보내고 서버가 소유한 tmux 클라이언트도 다시 그린다.
  private refreshTerminal(chatId: number): void {
    const terminal = this.terminals.get(chatId);
    if (!terminal) return;
    const snapshot = terminal.screen?.ansiSnapshot();
    if (snapshot) this.realtime.terminal(chatId, snapshot);
    const clients = spawnSync("tmux", ["list-clients", "-t", exactTmuxTarget(terminal.tmuxName), "-F", "#{client_pid} #{client_tty}"], { encoding: "utf8" });
    const ownClient = clients.status === 0
      ? clients.stdout.split("\n").find((line) => line.startsWith(`${terminal.pty.pid} `))
      : undefined;
    const tty = ownClient?.slice(ownClient.indexOf(" ") + 1);
    if (tty) spawnSync("tmux", ["refresh-client", "-t", tty]);
  }

  // 진행 중인 응답을 ESC로 중단시키고, 잠시 후 실제로 입력 가능한 상태로 돌아왔는지 확인해
  // 맞다면 "작업중" 표시를 바로 정리한다(놓쳐도 history-sync의 턴 종료 감지가 뒤따라 정리한다).
  async interrupt(chatId: number, user: AuthUser): Promise<void> {
    const chat = this.getChat(chatId);
    if (this.structuredTransport?.owns(chatId)) {
      await this.structuredTransport.interrupt(chatId);
      writeAudit(this.database, user.id, "chat.interrupt", "chat", chatId, { transport: "app_server" });
      return;
    }
    const terminal = this.terminals.get(chatId);
    if (!terminal) throw new Error("실행 중인 터미널이 없습니다.");
    // attach된 클라이언트 pty에 raw 0x1b 바이트를 직접 쓰면 클라이언트 쪽 이스케이프 시퀀스 파서에
    // 걸려 응답 생성이나 실행 중인 도구를 실제로는 중단시키지 못하는 경우가 있었다(Bash 도구 실행
    // 중 raw ESC로는 sleep이 끝까지 실행됐지만, tmux의 이름 있는 키 전송으로는 실제로 중단됨을 확인).
    // 기록 보기 중이면 Escape가 copy-mode 종료로만 소비되므로 먼저 실시간 화면으로 되돌린다.
    this.leaveCopyMode(terminal);
    sendTmuxEscape(terminal.tmuxName);
    writeAudit(this.database, user.id, "chat.interrupt", "chat", chatId);
    // Claude는 취소된 질문을 자기 입력창에 그대로 복구해두는데(웹 입력창 복구는 별개로 처리한다),
    // 그 복구된 글자가 실제 터미널 프롬프트에 남아있으면 어댑터 준비 판정이 "입력 중"으로 보아 다음
    // 전송이 15초 뒤 타임아웃된다. 복구가 반영될 시간을 준 뒤 방금 보낸 텍스트와 정확히 같은
    // 길이만큼만 Backspace를 보내 지운다.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lastText = this.lastPromptText.get(chatId);
    if (lastText) sendTmuxBackspace(terminal.tmuxName, promptCharacterCount(lastText));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (this.getAdapter(chat.provider).isReady(this.captureSnapshot(chatId))) {
        setChatBusy(this.database, this.realtime, chatId, false);
        return;
      }
    }
  }

  // Shift+Tab을 보내 Claude Code CLI의 기본(권한 요청)·auto-accept edits·plan mode를 다음 순서로 전환한다.
  cycleMode(chatId: number, user: AuthUser): void {
    const chat = this.getChat(chatId);
    if (!this.getAdapter(chat.provider).detectPermissionMode) throw new Error("이 공급자는 모드 전환을 지원하지 않습니다.");
    const terminal = this.terminals.get(chatId);
    if (!terminal) throw new Error("실행 중인 터미널이 없습니다.");
    sendTmuxShiftTab(terminal.tmuxName);
    writeAudit(this.database, user.id, "chat.mode_cycle", "chat", chatId);
  }

  // CLI에 정상 종료를 요청하고 제한 시간 뒤 남은 tmux 세션을 강제 종료한다.
  // user가 null이면 유휴 자동 종료처럼 시스템이 스스로 실행한 종료라 감사 로그에 사용자를 남기지 않는다.
  async stop(chatId: number, user: AuthUser | null): Promise<void> {
    const chat = this.getChat(chatId);
    if (this.structuredTransport?.owns(chatId)) {
      this.setStatus(chatId, "stopping", null);
      this.database.prepare("DELETE FROM rate_limit_waits WHERE chat_id = ?").run(chatId);
      this.structuredTransport.stop(chatId);
      this.clearChatCaches(chatId);
      writeAudit(this.database, user?.id ?? null, "terminal.stop", "chat", chatId, { transport: "app_server" });
      this.removeEmptyChatAfterTerminalExit(chatId);
      return;
    }
    this.setStatus(chatId, "stopping", null);
    // 사용자가 종료를 선택한 세션은 리밋이 풀린 뒤 시스템 입력으로 다시 시작하지 않는다.
    this.database.prepare("DELETE FROM rate_limit_waits WHERE chat_id = ?").run(chatId);
    const terminal = this.terminals.get(chatId);
    if (terminal) {
      terminal.pty.write("/exit\r");
      const slashDelay = this.getAdapter(chat.provider).promptQuirks?.slashCommandConfirmDelayMs;
      if (slashDelay) {
        await new Promise((resolve) => setTimeout(resolve, slashDelay));
        terminal.pty.write("\r");
      }
    }
    const deadline = Date.now() + 3_000;
    while (tmuxExists(chat.tmux_name) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (tmuxExists(chat.tmux_name)) spawnSync("tmux", ["kill-session", "-t", exactTmuxTarget(chat.tmux_name)], { stdio: "ignore" });
    const managed = this.terminals.get(chatId);
    if (managed?.busyPollTimer) clearInterval(managed.busyPollTimer);
    if (managed?.stateScanTimer) clearTimeout(managed.stateScanTimer);
    if (managed?.approvalVerifyTimer) clearTimeout(managed.approvalVerifyTimer);
    this.disposeTerminalScreen(managed);
    managed?.pty.kill();
    this.terminals.delete(chatId);
    this.clearChatCaches(chatId);
    this.setStatus(chatId, "stopped", null);
    writeAudit(this.database, user?.id ?? null, "terminal.stop", "chat", chatId);
    this.removeEmptyChatAfterTerminalExit(chatId);
  }

  // CLI 업데이트가 끝난 공급자의 실행 중 채팅을 전부 새 바이너리로 교체한다. 각 채팅은 먼저 기존
  // 정상 종료 경로를 거쳐 rate-limit 대기·PTY·화면 캐시를 정리하고, 저장된 공급자 세션 ID가 있으면
  // 같은 대화를 resume한다. 한 채팅 실패가 나머지 재시작을 막지 않도록 결과를 모아 반환한다.
  async restartProviderTerminals(provider: Provider, user: AuthUser): Promise<{
    restartedChatIds: number[];
    failures: Array<{ chatId: number; error: string }>;
  }> {
    const rows = this.database.prepare(`
      SELECT id, status FROM chats WHERE provider = ? ORDER BY id ASC
    `).all(provider) as Array<{ id: number; status: ChatRecord["status"] }>;
    // error 상태는 입력 준비 시간 초과 등으로 PTY가 살아있어도 발생한다. DB의 활성
    // 상태와 실제 부착 PTY를 합쳐 대상을 정하되, 이미 사용자 종료 중인 채팅은 다시 시작하지 않는다.
    const targets = rows.filter((row) => ["starting", "running", "resuming"].includes(row.status)
      || (row.status === "error" && this.terminals.has(row.id)));
    const restartedChatIds: number[] = [];
    const failures: Array<{ chatId: number; error: string }> = [];
    for (const target of targets) {
      try {
        await this.stop(target.id, user);
        const remaining = this.database.prepare("SELECT 1 FROM chats WHERE id = ?").get(target.id);
        // 사용 기록이 전혀 없는 터미널은 stop() 정책에 따라 목록에서도 제거되므로 재시작하지 않는다.
        if (!remaining) continue;
        const stopped = this.getChat(target.id);
        this.start(target.id, Boolean(stopped.provider_session_id));
        writeAudit(this.database, user.id, "terminal.restart_after_cli_update", "chat", target.id, { provider });
        restartedChatIds.push(target.id);
      } catch (error) {
        failures.push({ chatId: target.id, error: error instanceof Error ? error.message : "터미널 재시작에 실패했습니다." });
      }
    }
    return { restartedChatIds, failures };
  }

  // 서버 종료 시 tmux는 유지하고 연결된 PTY 클라이언트만 정리한다.
  close(): void {
    this.structuredTransport?.close();
    for (const terminal of this.terminals.values()) {
      if (terminal.busyPollTimer) clearInterval(terminal.busyPollTimer);
      if (terminal.stateScanTimer) clearTimeout(terminal.stateScanTimer);
      if (terminal.approvalVerifyTimer) clearTimeout(terminal.approvalVerifyTimer);
      this.disposeTerminalScreen(terminal);
      terminal.pty.kill();
    }
    this.terminals.clear();
    this.lastStateLog.clear();
    this.inputQueues.clear();
    this.lastPromptText.clear();
    this.promptSubmittedAt.clear();
    for (const timer of this.emptyExitCleanupTimers.values()) clearTimeout(timer);
    this.emptyExitCleanupTimers.clear();
  }

  // tmux 세션에 PTY 클라이언트를 붙이고 출력을 실시간으로 중계한다.
  private attach(chat: ChatWithProject): void {
    if (this.terminals.has(chat.id)) return;
    const child = pty.spawn("tmux", ["attach-session", "-t", exactTmuxTarget(chat.tmux_name)], {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: chat.workspace_path,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    const terminal: ManagedTerminal = {
      pty: child,
      screen: new TerminalScreen({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: 0 }),
      buffer: "",
      approvalFingerprint: null,
      approvalCandidateFingerprint: null,
      tmuxName: chat.tmux_name,
      rows: DEFAULT_ROWS,
    };
    this.terminals.set(chat.id, terminal);
    // detectTerminalApproval은 원래 onData(새 출력 도착)에서만 돌았는데, 서버 재시작 등으로 이미
    // "한도 초과 → 대기 프롬프트로 복귀"까지 끝나 화면이 정적으로 멈춘 채팅을 재attach하면 그 뒤로
    // 새 출력이 전혀 없어 감지가 한 번도 안 돌아 rate_limit_waits에 영영 안 올라갔다(실사용 재현:
    // Codex 한도 초과 채팅이 계속 "대기중"으로만 보임). syncTerminalBusy처럼 정적 화면도 주기적으로
    // 화면이 안 바뀌어도 현재 상태를 계속 재확인하게 한다.
    // 매 틱마다 스냅샷을 한 번만 찍어(spawnSync라 블로킹 호출임) detectTerminalApproval·syncTerminalBusy
    // 둘 다에 넘긴다 — 각자 따로 찍으면 매초 채팅당 tmux capture-pane을 두 번씩 부르게 된다.
    terminal.busyPollTimer = setInterval(() => {
      if (Date.now() - (terminal.lastStateScanAt ?? 0) >= TERMINAL_STATE_IDLE_POLL_MS) this.scanTerminalState(chat, terminal);
    }, TERMINAL_STATE_IDLE_POLL_MS);
    terminal.busyPollTimer.unref();
    void this.detectAndStoreModel(chat.id, chat.provider, 8_000);
    if (this.getAdapter(chat.provider).detectPermissionMode) void this.detectAndStorePermissionMode(chat.id, 8_000);
    this.setStatus(chat.id, "running", null);
    child.onData((data) => {
      terminal.buffer = `${terminal.buffer}${data}`.slice(-120_000);
      this.realtime.terminal(chat.id, data);
      terminal.screen?.write(data, () => this.scheduleTerminalStateScan(chat, terminal));
    });
    child.onExit(() => {
      if (terminal.busyPollTimer) clearInterval(terminal.busyPollTimer);
      if (terminal.stateScanTimer) clearTimeout(terminal.stateScanTimer);
      if (terminal.approvalVerifyTimer) clearTimeout(terminal.approvalVerifyTimer);
      this.disposeTerminalScreen(terminal);
      this.terminals.delete(chat.id);
      this.clearChatCaches(chat.id);
      const alive = tmuxExists(chat.tmux_name);
      const wasStopping = (this.database.prepare("SELECT status FROM chats WHERE id = ?").get(chat.id) as { status: string } | undefined)?.status === "stopping";
      this.setStatus(chat.id, alive ? "running" : "stopped", null);
      // 프로세스가 사라지면 그 승인 요청에 응답해도 더 이상 전달할 대상이 없으므로, 승인 목록에
      // 방치되지 않게 자동으로 정리한다.
      if (!alive) {
        this.approvals.closeChatApprovals(chat.id, "터미널 세션이 종료되어 자동으로 정리되었습니다.");
        // stop()이 진행 중이면 그 함수가 terminal.stop 감사 기록을 남긴 뒤 삭제한다. 예기치 않은 종료만
        // 여기서 즉시 수명주기를 마감해 두 경로가 서로 상태/삭제 이벤트 순서를 뒤집지 않게 한다.
        if (!wasStopping) this.removeEmptyChatAfterTerminalExit(chat.id);
      }
      // 사용자의 결정으로 터미널 종료 자체는 외부 알림을 보내지 않는다. 완료·승인·한도 알림은
      // 각각의 의미 있는 이벤트 경로에서 계속 발송한다.
    });
  }

  // 종료 경로가 겹쳐도 headless 터미널 화면을 한 번만 해제한다.
  private disposeTerminalScreen(terminal?: ManagedTerminal): void {
    terminal?.screen?.dispose();
    if (terminal) terminal.screen = undefined;
  }

  // PTY 출력이 몰릴 때 상태 판정을 짧은 주기로 합쳐 동기식 tmux 프로세스 생성을 제한한다.
  private scheduleTerminalStateScan(chat: ChatWithProject, terminal: ManagedTerminal): void {
    if (terminal.stateScanTimer) return;
    const elapsed = Date.now() - (terminal.lastStateScanAt ?? 0);
    const delay = Math.max(0, TERMINAL_STATE_SCAN_THROTTLE_MS - elapsed);
    terminal.stateScanTimer = setTimeout(() => {
      terminal.stateScanTimer = undefined;
      this.scanTerminalState(chat, terminal);
    }, delay);
    terminal.stateScanTimer.unref();
  }

  // 현재 화면을 한 번만 캡처해 승인·작업·권한 모드 판정에 함께 사용한다.
  private scanTerminalState(chat: ChatWithProject, terminal: ManagedTerminal): void {
    if (this.terminals.get(chat.id) !== terminal) return;
    // 기록 보기 중에는 화면이 과거 내용이라 승인·작업중 판정이 어긋난다. 실시간 화면으로 돌아온 뒤 다시 판정한다.
    if (terminal.copyMode) return;
    if (terminal.stateScanTimer) {
      clearTimeout(terminal.stateScanTimer);
      terminal.stateScanTimer = undefined;
    }
    terminal.lastStateScanAt = Date.now();
    const snapshot = this.captureSnapshot(chat.id);
    this.detectTerminalApproval(chat, terminal, snapshot);
    this.syncTerminalBusy(chat, snapshot);
    if (this.getAdapter(chat.provider).detectPermissionMode) this.detectPermissionModeChange(chat.id, snapshot);
  }

  // tmux 현재 화면을 보조 신호로 삼아 JSONL 기록이 아직 안 따라온 틈을 메운다. busy는 켜진 뒤
  // history-sync가 놓치면 DB에 계속 남을 수 있으므로, 현재 화면이 명확히 입력 가능할 때만 내린다.
  private syncTerminalBusy(chat: ChatWithProject, snapshot?: string): void {
    const terminal = this.terminals.get(chat.id);
    if (!terminal) return;
    snapshot ??= this.captureSnapshot(chat.id);
    const adapter = this.getAdapter(chat.provider);
    this.logStateCheck("busy", chat.id, snapshot, { isBusy: adapter.isBusy(snapshot), isReady: adapter.isReady(snapshot) });
    if (adapter.isBusy(snapshot)) {
      terminal.readySince = undefined;
      setChatBusy(this.database, this.realtime, chat.id, true);
      return;
    }
    if (adapter.isReady(snapshot)) {
      const current = this.database.prepare("SELECT busy FROM chats WHERE id = ?").get(chat.id) as { busy: number } | undefined;
      if (chat.provider === "claude" && current?.busy) {
        terminal.readySince ??= Date.now();
        if (Date.now() - terminal.readySince < 3_000) return;
      }
      setChatBusy(this.database, this.realtime, chat.id, false);
      return;
    }
    // composer가 실제로 보이는데 실행 표식이 없다면 작업 중이 아니라 미전송 초안 또는 빈 대기
    // 화면이다. isReady는 의도적으로 빈 composer만 인정하므로 이 상태를 별도로 내리지 않으면
    // 제출 성공 오판 뒤 DB busy=1이 영구 고착된다.
    const promptDraft = adapter.readPromptDraft?.(snapshot);
    if (promptDraft) {
      setChatBusy(this.database, this.realtime, chat.id, false);
      return;
    }
    terminal.readySince = undefined;
  }

  // 공급자 TUI 출력에서 새 승인·선택 프롬프트를 감지해 웹 요청으로 전환한다.
  // terminal.buffer(120,000자 원시 누적 로그)를 같이 넘기면, 화면이 이미 넘어간 옛 y/n·선택 화면
  // 문구가 다음 onData 때 다시 감지 대상에 섞여 들어와 이미 해결된 요청을 새로 또 만들어냈다
  // (실제로 디렉터리 신뢰 확인을 답한 뒤에도 confirm_yn이 다시 뜨는 것으로 확인됨). detectAndStoreModel과
  // 같은 이유로, "지금 화면에 실제로 떠 있는가"만 봐야 하므로 tmux가 그려주는 현재 스냅샷만 사용한다.
  private detectTerminalApproval(chat: ChatWithProject, terminal: ManagedTerminal, snapshot?: string): void {
    const approvalSnapshot = snapshot ?? this.captureSnapshot(chat.id);
    const hint = this.adapters.get(chat.provider)?.detectApproval(approvalSnapshot);
    this.logStateCheck("approval", chat.id, approvalSnapshot, hint ?? null);
    if (!hint) return;
    const fingerprint = `${hint.requestType}:${hint.summary.slice(-500)}`;
    if (terminal.approvalFingerprint === fingerprint || terminal.approvalCandidateFingerprint === fingerprint) return;
    terminal.approvalCandidateFingerprint = fingerprint;
    if (terminal.approvalVerifyTimer) clearTimeout(terminal.approvalVerifyTimer);
    // TUI 화면은 assistant 답변·도구 출력에도 권한 프롬프트와 같은 문구가 잠깐 찍힐 수 있으므로,
    // 짧게 기다린 뒤 같은 프롬프트가 여전히 현재 화면 하단에 있는 경우에만 승인 카드로 만든다.
    terminal.approvalVerifyTimer = setTimeout(() => this.confirmTerminalApproval(chat.id, fingerprint), 900);
    terminal.approvalVerifyTimer.unref();
  }

  // 지연 후 같은 승인 프롬프트가 계속 살아있을 때만 웹 승인 요청을 생성한다.
  private confirmTerminalApproval(chatId: number, expectedFingerprint: string): void {
    const terminal = this.terminals.get(chatId);
    if (!terminal || terminal.approvalCandidateFingerprint !== expectedFingerprint) return;
    terminal.approvalCandidateFingerprint = null;
    terminal.approvalVerifyTimer = undefined;
    const chat = this.getChat(chatId);
    const approvalSnapshot = this.captureSnapshot(chatId);
    const hint = this.adapters.get(chat.provider)?.detectApproval(approvalSnapshot);
    this.logStateCheck("approval-confirm", chat.id, approvalSnapshot, hint ?? null);
    if (!hint) return;
    const fingerprint = `${hint.requestType}:${hint.summary.slice(-500)}`;
    if (fingerprint !== expectedFingerprint || terminal.approvalFingerprint === fingerprint) return;
    terminal.approvalFingerprint = fingerprint;
    // 선택 메뉴 없이 "한도에 걸렸다" 배너만 지나가고 곧바로 idle로 돌아간 경우엔 사람이 누를 키 자체가
    // 없다. 승인 카드로 만들어 autoResolve를 태우면, 이 requestType엔 맞는 키 매핑이 없어
    // approvalInput()의 기본값("1\r")이 그대로 idle 프롬프트에 "1"을 타이핑해 새 메시지로 보내버리는
    // 사고가 난다 — 그래서 승인 카드를 거치지 않고 대기 목록에만 바로 올린다.
    if (hint.requestType === "session_limit_notice") {
      this.registerRateLimitWait(chat, hint.summary);
      return;
    }
    // 한도 선택 화면은 사람이 누를 때까지 기다리지 않고 "재설정까지 대기"를 바로 자동 선택하므로, 볼
    // 새도 없이 곧바로 처리될 "승인 필요" 알림은 굳이 띄우지 않는다(notify=false).
    const isRateLimit = hint.requestType === "rate_limit_options";
    const approvalId = this.approvals.createTerminalApproval(chat.id, chat.provider, hint.summary, hint.requestType, !isRateLimit);
    if (isRateLimit) {
      // rate_limit_options 승인을 사람 개입 없이 즉시 "재설정까지 대기"로 확정한다(decided_by는
      // 시스템이 자동 처리했다는 뜻으로 비워둔다).
      this.approvals.autoResolve(approvalId, "accept");
      this.registerRateLimitWait(chat, hint.summary);
    }
  }

  // Claude StopFailure(rate_limit) 훅의 보완 경로(#94). 화면 감지가 이미 대기를 등록했으면 그 값(화면의
  // 리셋 시각)을 덮지 않고 아무것도 하지 않는다. 훅 세부 문구에서 리셋 시각을 못 읽으면 resume_after가
  // 비어 재개 서비스가 그 계정 사용량의 실제 회복을 보고 이어 준다.
  registerRateLimitWaitFromHook(chatId: number, details: string | null): boolean {
    if (this.database.prepare("SELECT 1 FROM rate_limit_waits WHERE chat_id = ?").get(chatId)) return false;
    const chat = this.database.prepare("SELECT 1 FROM chats WHERE id = ? AND status IN ('starting', 'running', 'resuming')").get(chatId);
    if (!chat) return false;
    this.registerRateLimitWait(this.getChat(chatId), details ?? "");
    return true;
  }

  // 이 채팅을 rate_limit_waits에 올려두면, 실제 리셋 시각이 됐을 때 rate-limit-resume 서비스가 "계속"을
  // 보내 하던 작업을 이어가게 한다. 선택 메뉴가 있는 rate_limit_options·선택 메뉴 없이 배너만 뜬
  // session_limit_notice 둘 다 여기서 공통으로 처리한다. "한도에 걸렸다" 자체는 사람이 알아야 하는
  // 이벤트라(rate_limit_options는 승인 카드가 notify=false로 안 뜨므로 더더욱) 여기서 별도로 알린다.
  private registerRateLimitWait(chat: ChatWithProject, summary: string): void {
    const resumeAfter = parseResetTime(summary, new Date())?.toISOString() ?? null;
    this.database.prepare(`
      INSERT INTO rate_limit_waits(chat_id, provider, resume_after, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id) DO UPDATE SET provider = excluded.provider, resume_after = excluded.resume_after, created_at = CURRENT_TIMESTAMP
    `).run(chat.id, chat.provider, resumeAfter);
    const label = this.getAdapter(chat.provider).displayLabel;
    // 알림 채널의 중복 전송 방지는 event_id가 완전히 같을 때만 걸린다(ntfy.ts 등이 DB에서 event_id로
    // 조회). 예전엔 Date.now()를 넣어 호출마다 매번 새 ID가 됐는데, 그러면 in-memory
    // approvalFingerprint가 리셋되는 서버 재시작 직후 tmux 화면에 남아있는 "같은" 한도 배너를 다시
    // 감지했을 때(실제 새 이벤트가 아닌데도) 중복 알림이 그대로 나갔다(실사용 보고로 확인, 재시작
    // 시점과 겹치는 두 번 연속 발송을 DB에서도 확인함). 리셋 시각(resumeAfter)까지 같으면 같은 한도
    // 에피소드로 보고 같은 ID를 써서 중복을 막는다 — 리셋 시각을 못 읽은 경우에만 배너 문구로 대체한다.
    void this.notifications.notify(
      `rate-limit-hit:${chat.id}:${resumeAfter ?? summary}`,
      "rate_limit_hit",
      `${label} 사용량 한도에 걸려 재설정까지 대기합니다.\n채팅 ID: ${chat.id}`,
    );
  }

  // 터미널 스크래핑 기반 승인이 지금도 실제로 화면에 떠 있는지 재확인한다("닫기"가 안전한지 판단하는
  // 용도로만 쓰며, 여기서는 절대 키 입력을 보내지 않는다). 프로세스가 사라졌거나 화면이 이미 다른
  // 상태로 넘어갔으면 더 이상 응답을 기다리는 게 아니므로 false를 반환해 web 쪽 정리를 허용한다.
  private isTerminalApprovalLive(chatId: number, requestType: string): boolean {
    if (!this.terminals.has(chatId)) return false;
    const chat = this.getChat(chatId);
    const hint = this.adapters.get(chat.provider)?.detectApproval(this.captureSnapshot(chatId));
    return hint?.requestType === requestType;
  }

  // 웹에서 선택한 터미널 승인 결정을 해당 공급자 TUI 키 입력으로 전달한다.
  // rate_limit_options는 "대기"가 항상 몇 번인지(혹은 애초에 선택 메뉴가 뜨는지)를 고정 가정하지 않고,
  // 지금 화면을 실제로 봐서 판단한다(resolveRateLimitInput). 확신 못 하면 아무 키도 보내지 않는다 —
  // 예전엔 무조건 "1\r"을 보내서, Codex처럼 선택 메뉴 없이 안내 문구만 뜨는 화면에서 "1"이 그대로
  // 채팅 메시지로 전송돼버리는 문제가 있었다.
  private applyTerminalApproval(chatId: number, decision: ApprovalDecision, requestType: string): void {
    const terminal = this.terminals.get(chatId);
    const chat = this.getChat(chatId);
    const adapter = this.adapters.get(chat.provider);
    // 화면을 봐야 결정할 수 있는 공급자만 스냅샷을 뜬다(캡처 자체가 tmux 호출이라 매번 할 이유가 없다).
    const resolveFromScreen = (): string | null => {
      if (requestType === "rate_limit_options" && (decision === "accept" || decision === "acceptForSession")) {
        return adapter?.resolveRateLimitInput?.(decision, this.captureSnapshot(chatId)) ?? null;
      }
      if (adapter?.resolveApprovalInput) return adapter.resolveApprovalInput(decision, requestType, this.captureSnapshot(chatId));
      return null;
    };
    const needsScreen = (requestType === "rate_limit_options" && (decision === "accept" || decision === "acceptForSession"))
      || !!adapter?.resolveApprovalInput;
    const input = needsScreen ? resolveFromScreen() : adapter?.approvalInput(decision, requestType);
    if (!terminal || !input) return;
    // 웹에서 기록을 위로 올려둔 상태면 승인 키가 copy-mode에 먹히므로 먼저 실시간 화면으로 되돌린다.
    this.leaveCopyMode(terminal);
    // ESC·Enter는 raw 바이트로 직접 쓰면 attach된 클라이언트의 이스케이프 시퀀스 파서에 걸려 실제로는
    // 반영되지 않는 경우가 있어(interrupt()에서 확인한 것과 같은 문제) tmux 이름 있는 키로 보낸다.
    if (input === "\u001b") { sendTmuxEscape(terminal.tmuxName); return; }
    const digits = input.replace(/\r$/, "");
    if (digits) terminal.pty.write(digits);
    if (input.endsWith("\r")) sendTmuxEnter(terminal.tmuxName);
  }

  // 채팅과 프로젝트 경로를 함께 조회한다.
  private getChat(chatId: number): ChatWithProject {
    const chat = this.database.prepare(`
      SELECT c.*, p.path AS project_path, COALESCE(c.worktree_path, p.path) AS workspace_path
      FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ?
    `).get(chatId) as ChatWithProject | undefined;
    if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
    return chat;
  }

  // 공급자 ID로 어댑터를 찾아 서비스가 공급자별 분기를 직접 갖지 않게 한다.
  private getAdapter(provider: Provider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error("지원하지 않는 공급자입니다.");
    return adapter;
  }

  // 모델 변경 시 어댑터가 필요한 tmux 조작과 화면 대기를 수행할 수 있게 하는 좁은 IO 인터페이스를 만든다.
  private tmuxIO(chatId: number, tmuxName: string, adapter: ProviderAdapter): TmuxIO {
    return {
      tmuxName,
      sendText: (value) => sendTmuxText(tmuxName, value),
      sendEnter: () => sendTmuxEnter(tmuxName),
      sendLeft: () => sendTmuxLeft(tmuxName),
      sendRight: () => sendTmuxRight(tmuxName),
      wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      snapshot: () => this.captureSnapshot(chatId),
      waitForModelMenu: (part, timeoutMs) => this.waitForModelMenu(chatId, adapter, part, timeoutMs),
    };
  }

  // 채팅 상태와 오류를 갱신하고 웹에 알린다.
  private setStatus(chatId: number, status: ChatRecord["status"], error: string | null): void {
    this.database.prepare("UPDATE chats SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, error, chatId);
    this.providerRollouts?.observeChatStatus(chatId, status);
    console.debug("[web-agent-manager:chat:server]", "status:update", { at: new Date().toISOString(), chatId, status, hasError: Boolean(error) });
    this.realtime.broadcast("chat_status", { chatId, status, error });
    // 터미널이 멈추거나 오류가 나면 더 이상 응답을 생성할 수 없으므로 생성 중 표시를 정리한다.
    if (status === "stopped" || status === "error") setChatBusy(this.database, this.realtime, chatId, false);
  }
}
