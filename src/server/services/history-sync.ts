import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { ProviderAdapter, HistorySession } from "../providers/provider";
import type { RealtimeHub } from "./realtime";
import type { Notifier } from "./notifier";
import type { HistoryCache } from "./history-cache";
import type { ApprovalService } from "./approval";
import type { AgentAccountService } from "./agent-accounts";
import { setChatBusy, shouldHealStuckBusy } from "../core/chat-busy";
import { tokenUsageSnapshotForChat, type TokenUsageLedger } from "./token-usage-ledger";
import type { HookObserver } from "./agent-hook-events";
import type { TaskCommandService } from "./task-command-service";

// 세션 저장소 아래의 JSONL 파일을 재귀적으로 찾는다. Task 도구로 뜬 서브에이전트 기록
// (`<세션ID>/subagents/agent-*.jsonl`)은 내부 레코드에 자기 고유 ID 없이 부모 세션의 sessionId를
// 그대로 들고 있어, 이걸 포함해서 스캔하면 persist()가 "같은 세션"으로 보고 부모 채팅의
// history_file·제목을 서브에이전트 내용으로 덮어써버린다(실사용 보고로 확인, 2026-07-24) —
// subagents 디렉터리 자체를 순회 대상에서 뺀다.
function findJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === "subagents") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(target);
    }
  };
  walk(root);
  return output;
}

// 실험실이 만든 격리 작업공간에서 돈 세션은 사람이 여는 채팅이 아니다. 실행마다 worktree가 하나씩
// 생기므로 그대로 두면 비교 한 번에 채팅이 arm 수 × 반복 수만큼 쌓여 목록이 묻힌다. 앱이 관리하는
// 경로이므로 경로만으로 확실히 구분할 수 있다.
export function isLabWorkspace(cwd: string, dataDir: string): boolean {
  let actual: string;
  let root: string;
  try {
    actual = fs.realpathSync(cwd);
    root = fs.realpathSync(dataDir);
  } catch {
    return false;
  }
  return ["experiment-worktrees", "evaluation-workspaces"].some((name) => {
    const managed = path.join(root, name);
    return actual === managed || actual.startsWith(`${managed}${path.sep}`);
  });
}

// 부모 채팅이 시작한 위임 한 건이 알림 기준으로 아직 끝나지 않았는지 본다.
export interface SourceDelegationRow {
  id: string;
  status: string;
  completed_at: string | null;
  created_at: string;
  busy: number;
  chatStatus: string;
}

// 대상이 시작 전이거나 작업 중이면 이 위임은 아직 열린 상태다.
export function isOpenSourceDelegation(row: SourceDelegationRow): boolean {
  if (row.status === "failed" || row.completed_at) return false;
  return row.chatStatus === "starting" || row.busy === 1;
}

// 이 채팅이 시작한 위임 중 아직 안 끝난 목록을 반환한다.
export function listOpenSourceDelegations(database: AppDatabase, chatId: number): SourceDelegationRow[] {
  const rows = database.prepare(`
    SELECT d.id, d.status, d.completed_at, d.created_at, c.busy, c.status AS chatStatus
    FROM delegations d
    JOIN chats c ON c.id = d.target_chat_id
    WHERE d.source_chat_id = ?
  `).all(chatId) as SourceDelegationRow[];
  return rows.filter(isOpenSourceDelegation);
}

// 위임 생성 시각이 부모 턴 종료 후 1분 이내면 그 턴에 속한 작업으로 본다.
function delegationBelongsToTurn(createdAt: string, turnAt: string | undefined): boolean {
  const created = Date.parse(createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`);
  const ended = turnAt ? Date.parse(turnAt) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(created) || !Number.isFinite(ended)) return true;
  return created <= ended + 60_000;
}

interface HeldCompletion {
  chatId: number;
  eventId: string;
  provider: string;
  title: string;
  cwd: string;
  delegationIds: string[];
}

// 발견 세션의 작업 경로가 허용된 루트 내부인지 확인한다.
function isAllowedProject(cwd: string, allowedRoots: string[]): boolean {
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return false;
  let actual: string;
  try {
    actual = fs.realpathSync(cwd);
  } catch {
    return false;
  }
  return allowedRoots.some((root) => {
    if (!fs.existsSync(root)) return false;
    const actualRoot = fs.realpathSync(root);
    if (actualRoot === path.sep) return true;
    return actual === actualRoot || actual.startsWith(`${actualRoot}${path.sep}`);
  });
}

// 공급자 전역 세션 기록을 프로젝트·채팅 테이블에 동기화한다.
// 메시지 본문은 DB에 미러링하지 않고 항상 JSONL을 신뢰 가능한 단일 소스로 그때그때 읽는다(history-cache 참고).
export class HistorySynchronizer {
  private readonly seenMtime = new Map<string, number>();
  // Grok처럼 한 세션의 본문·턴 종료·토큰이 여러 파일로 갈리는 공급자를 위해, DB가 가리키는 주 기록
  // 파일에서 실제 원본 파일 묶음을 역으로 찾는다. 전체 발견 스캔 때 채워 활성 채팅의 빠른 확인에 쓴다.
  private readonly sourceFilesByHistoryFile = new Map<string, Set<string>>();
  private readonly lastSeenMessageId = new Map<number, string>();
  private readonly lastSeenTurnEnd = new Map<number, string>();
  // 부모 턴은 끝났지만 위임이 남아 아직 보내지 않은 완료 알림.
  private readonly heldCompletions = new Map<number, HeldCompletion>();
  // 본문 파일별로 마지막에 확인한 "토큰이 붙은 메시지 수". 사이드카 갱신이 실제 토큰 추가인지 가린다.
  private readonly lastTokenUsageCount = new Map<string, number>();
  private activeTimer?: NodeJS.Timeout;
  private discoveryTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly adapters: ProviderAdapter[],
    private readonly realtime: RealtimeHub,
    private readonly notifications: Notifier,
    private readonly historyCache: HistoryCache,
    private readonly approvals: ApprovalService,
    private readonly accounts: AgentAccountService,
    private readonly tokenUsage?: TokenUsageLedger,
    // 폴링이 찾은 턴 종료를 훅 도착과 대조하는 관찰기(#93). 없으면 관찰하지 않는다.
    private readonly hookObserver?: Pick<HookObserver, "recordPollingTurnEnd">,
    private readonly taskCommands?: Pick<TaskCommandService, "observeHistoryMessages">,
  ) {}

  // 초기 전체 스캔 뒤 활성 채팅은 빠르게, 새 외부 세션 발견은 느리게 나눠 동기화한다. 예전에는 2초마다
  // 수백 개의 과거 JSONL을 전부 재귀 열거·stat해 4 vCPU 서버 기준 약 3~4% CPU를 상시 사용했다.
  start(activeIntervalMs = 2_000, discoveryIntervalMs = 30_000): void {
    this.syncAll(false);
    this.activeTimer = setInterval(() => this.syncActive(true), activeIntervalMs);
    this.activeTimer.unref();
    this.discoveryTimer = setInterval(() => this.syncAll(true), discoveryIntervalMs);
    this.discoveryTimer.unref();
  }

  // 기록 동기화 타이머를 종료한다.
  stop(): void {
    if (this.activeTimer) clearInterval(this.activeTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
  }

  // 채팅 연결이 끊긴 기록 파일을 다음 전체 스캔에서 다시 반영하게 한다. 파일이 바뀌지 않으면 syncFile이
  // 건너뛰므로, /clear로 채팅이 새 세션으로 옮겨진 옛 대화가 재시작 전까지 어느 채팅에도 등록되지 않았다(#91).
  forgetHistoryFile(file: string): void {
    this.seenMtime.delete(file);
  }

  // 파일 하나의 변경을 확인하고, 바뀐 경우에만 파싱·DB 반영한다.
  private syncFile(adapter: ProviderAdapter, accountId: number, file: string, notifyCompletion: boolean): void {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    if (this.seenMtime.get(file) === mtime) return;
    if (adapter.isHiddenHistoryFile?.(file)) {
      this.removeHiddenChat(adapter, file);
      this.seenMtime.set(file, mtime);
      return;
    }
    const session = this.historyCache.get(adapter, file);
    if (!session || !isAllowedProject(session.cwd, this.config.allowedRoots)) return;
    const sources = this.sourceFilesByHistoryFile.get(session.historyFile) ?? new Set<string>();
    sources.add(file);
    // 주 기록 자체가 이번 전체 스캔에서 별도 입구로 나오지 않는 공급자도 빠른 확인 대상에 포함한다.
    sources.add(session.historyFile);
    this.sourceFilesByHistoryFile.set(session.historyFile, sources);
    // 한 세션이 본문 파일과 사이드카 파일(턴 종료·턴 토큰)로 나뉘는 공급자(Grok)에서는, 사이드카만
    // 바뀌어도 채팅 API가 읽는 본문 파일 캐시에는 새 토큰이 반영되지 않는다. 다만 사이드카는 턴
    // 중에도 계속 쌓이므로 실제 토큰 추가일 때만 본문 캐시를 버린다.
    if (session.historyFile !== file) {
      const usageCount = session.messages.reduce((count, message) => count + (message.tokenUsage ? 1 : 0), 0);
      if (this.lastTokenUsageCount.get(session.historyFile) !== usageCount) {
        this.lastTokenUsageCount.set(session.historyFile, usageCount);
        this.historyCache.invalidate(session.historyFile);
      }
    }
    if (isLabWorkspace(session.cwd, this.config.dataDir)) {
      this.seenMtime.set(file, mtime);
      return;
    }
    this.persist(adapter, session, notifyCompletion, accountId);
    this.seenMtime.set(file, mtime);
  }

  private finishSyncCycle(notifyCompletion: boolean, recoverStuckBusy = true): void {
    // 변경된 활성 파일은 persist가 busy를 바로 갱신한다. 고착 복구는 캐시를 강제로 버리고 기록 전체를
    // 다시 읽으므로 시작·30초 발견 주기에만 실행한다 — 큰 진행 중 JSONL을 2초마다 재파싱하면 전체
    // 디렉터리 탐색을 줄여도 같은 CPU 스파이크가 남는다.
    if (recoverStuckBusy) this.recoverStuckBusyChats();
    if (notifyCompletion) this.flushHeldCompletions();
  }

  // 모든 공급자의 변경된 JSONL 파일을 발견·동기화한다. 계정마다 설정 디렉터리가 갈라지므로 등록된
  // 계정 전부를 훑되, 정상 운영에서는 30초 발견 주기와 시작 시 한 번만 이 전체 경로를 탄다.
  syncAll(notifyCompletion = false): void {
    for (const adapter of this.adapters) {
      for (const account of this.accounts.list(adapter.id)) {
        for (const file of findJsonlFiles(adapter.historyRootFor(this.accounts.cliConfigDir(account)))) {
          this.syncFile(adapter, account.id, file, notifyCompletion);
        }
      }
    }
    this.finishSyncCycle(notifyCompletion);
  }

  // 이미 WAM 채팅에 연결된 활성 기록만 2초마다 확인한다. 아직 기록 파일이 없는 채팅이 실제 질문을
  // 처리 중이면 새 파일을 찾을 때까지 전체 스캔으로 승격해 첫 응답·완료 반영이 30초 늦어지지 않는다.
  syncActive(notifyCompletion = false): void {
    const unbound = this.database.prepare(`
      SELECT 1 FROM chats
      WHERE history_file IS NULL
        AND (status IN ('starting', 'resuming') OR (status = 'running' AND busy = 1))
      LIMIT 1
    `).get();
    if (unbound) {
      this.syncAll(notifyCompletion);
      return;
    }
    const rows = this.database.prepare(`
      SELECT provider, account_id AS accountId, history_file AS historyFile
      FROM chats
      WHERE history_file IS NOT NULL AND status IN ('starting', 'running', 'resuming', 'stopping')
    `).all() as Array<{ provider: string; accountId: number | null; historyFile: string }>;
    const checked = new Set<string>();
    for (const row of rows) {
      const adapter = this.adapters.find((item) => item.id === row.provider);
      if (!adapter) continue;
      const accountId = row.accountId ?? this.accounts.defaultAccount(adapter.id).id;
      const sources = this.sourceFilesByHistoryFile.get(row.historyFile) ?? new Set([row.historyFile]);
      for (const file of sources) {
        const key = `${adapter.id}\u0000${accountId}\u0000${file}`;
        if (checked.has(key)) continue;
        checked.add(key);
        this.syncFile(adapter, accountId, file, notifyCompletion);
      }
    }
    this.finishSyncCycle(notifyCompletion, false);
  }

  // 파일이 더 안 바뀌어 persist가 건너뛰어져도, 종료가 확인된 채팅의 busy 고착은 다음 전체 주기에 푼다.
  private recoverStuckBusyChats(): void {
    const rows = this.database.prepare(`
      SELECT id, provider, history_file AS historyFile, status
      FROM chats WHERE busy = 1 AND history_file IS NOT NULL
    `).all() as Array<{ id: number; provider: string; historyFile: string; status: string }>;
    for (const row of rows) {
      if (row.status === "stopped" || row.status === "error") {
        setChatBusy(this.database, this.realtime, row.id, false);
        continue;
      }
      if (!shouldHealStuckBusy(row.id)) continue;
      const adapter = this.adapters.find((item) => item.id === row.provider);
      if (!adapter) continue;
      this.historyCache.invalidate(row.historyFile);
      const session = this.historyCache.get(adapter, row.historyFile);
      if (!session) continue;
      const last = session.messages[session.messages.length - 1];
      const decision = adapter.evaluateHistorySync({
        session,
        last,
        newMessages: [],
        isTurnEnd: !!session.turnEndedAt,
      });
      if (decision.clearBusy && !decision.markBusy) setChatBusy(this.database, this.realtime, row.id, false);
    }
  }

  // 과거 버그로 이미 등록된 공급자 내부용 기록 채팅을 목록에서 제거한다.
  private removeHiddenChat(adapter: ProviderAdapter, file: string): void {
    const chat = this.database.prepare("SELECT id FROM chats WHERE provider = ? AND history_file = ?").get(adapter.id, file) as { id: number } | undefined;
    if (!chat) return;
    this.database.prepare("DELETE FROM chats WHERE id = ?").run(chat.id);
    this.historyCache.invalidate(file);
    this.realtime.broadcast("history_updated", { chatId: chat.id });
  }

  // 아직 등록되지 않은 경로의 프로젝트를 정한다. 이미 등록된 프로젝트의 하위 경로면 새로 만들지 않고
  // 가장 가까운 상위 프로젝트에 귀속시킨다 — 실험 worktree·평가 작업공간·artifacts 같은 작업 부산물이
  // 실행마다 별도 프로젝트로 등록돼 목록을 오염시켰다(2026-08-14, discovered 34건).
  private discoverProject(normalizedPath: string): { id: number } {
    const ancestor = this.database.prepare(`
      SELECT id FROM projects WHERE substr(?, 1, length(path) + 1) = path || ?
      ORDER BY length(path) DESC LIMIT 1
    `).get(normalizedPath, path.sep) as { id: number } | undefined;
    if (ancestor) return ancestor;
    this.database.prepare(`
      INSERT INTO projects(name, path, source, updated_at)
      VALUES (?, ?, 'discovered', CURRENT_TIMESTAMP)
      ON CONFLICT(path) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(path.basename(normalizedPath), normalizedPath);
    return this.database.prepare("SELECT id FROM projects WHERE path = ?").get(normalizedPath) as { id: number };
  }

  // 파싱한 세션과 메시지를 중복 없이 데이터베이스에 반영한다.
  // accountId는 이 기록 파일이 발견된 계정 슬롯으로, 채팅이 어느 계정에서 만들어졌는지의 실제 근거다.
  private persist(adapter: ProviderAdapter, session: HistorySession, notifyCompletion: boolean, accountId: number): void {
    const transaction = this.database.transaction(() => {
      const normalizedPath = fs.realpathSync(session.cwd);
      // 채팅 전용 worktree에서 실행하면 세션 cwd가 worktree 경로다. 그 경로로 프로젝트를 새로 만들면
      // worktree마다 "193" 같은 별도 프로젝트가 생기고 대화 기록이 그쪽으로 흘러가, 정작 채팅이 속한
      // 원본 프로젝트 화면에서는 답변이 보이지 않았다(실사용 보고, 2026-08-07). worktree는 같은
      // 프로젝트의 다른 작업공간이므로 그 worktree를 쓰는 채팅의 프로젝트로 귀속시킨다.
      // worktree_path가 그 프로젝트의 checkout 경로와 같은 행이 과거 데이터에 있어(정상 상태에서는 NULL),
      // 그대로 두면 일반 프로젝트 세션까지 worktree로 오판한다 — 프로젝트 경로와 다른 경우만 인정한다.
      // 세션 cwd가 이미 등록된 프로젝트 경로면 그 프로젝트가 정답이므로 worktree 판정을 아예 하지 않는다.
      // 이 확인이 없으면 프로젝트가 한 번 잘못 바뀐 채팅이 자기 자신을 worktree 소유자로 찾아(자기 worktree_path가
      // 새 프로젝트 경로와 달라 위 `<> p.path` 방어를 통과한다) 잘못된 project_id를 매 동기화마다 재확인하며
      // 영구 고착됐다(실사용 보고, 2026-08-14 채팅 #257).
      const registeredProject = this.database.prepare("SELECT id, active FROM projects WHERE path = ?").get(normalizedPath) as { id: number; active: number } | undefined;
      const worktreeOwner = registeredProject ? undefined : this.database.prepare(`
        SELECT c.id, c.project_id AS projectId FROM chats c JOIN projects p ON p.id = c.project_id
        WHERE c.worktree_path = ? AND c.provider = ? AND c.worktree_path <> p.path
        ORDER BY c.id DESC LIMIT 1
      `).get(normalizedPath, session.provider) as { id: number; projectId: number; branch: string | null } | undefined;
      const project: { id: number } = registeredProject ?? (worktreeOwner ? { id: worktreeOwner.projectId } : this.discoverProject(normalizedPath));
      if (registeredProject) {
        this.database.prepare("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(registeredProject.id);
      }
      let chat = this.database.prepare("SELECT id FROM chats WHERE provider = ? AND provider_session_id = ?").get(session.provider, session.sessionId) as { id: number } | undefined;
      // worktree 채팅은 프로젝트 경로가 아니라 worktree 경로로 찾아야 아래 경로 매칭에서 놓치지 않는다.
      if (!chat && worktreeOwner) {
        chat = this.database.prepare("SELECT id FROM chats WHERE id = ? AND provider_session_id IS NULL").get(worktreeOwner.id) as { id: number } | undefined;
      }
      if (!chat) {
        // 일반 웹 채팅도 실제로 전달한 첫 프롬프트를 짧게 영속 보존한다. Codex처럼 새 session ID를
        // 미리 지정할 수 없어도 JSONL의 첫 user 메시지와 정확히 같은 채팅을 찾을 수 있다. 같은 문구가
        // 동시에 전송된 경우에는 기록 시각과 가장 가까운 claim을 고른다.
        const firstUserMessage = session.messages.find((message) => message.role === "user");
        const firstUserPrompt = firstUserMessage?.content.replace(/\r\n/g, "\n").trim();
        if (firstUserMessage && firstUserPrompt) {
          this.database.prepare("DELETE FROM chat_history_claims WHERE datetime(created_at) < datetime('now', '-1 day')").run();
          const claims = this.database.prepare(`
            SELECT h.chat_id AS id, h.created_at AS createdAt
            FROM chat_history_claims h
            JOIN chats c ON c.id = h.chat_id
            JOIN projects p ON p.id = c.project_id
            WHERE c.provider = ? AND c.provider_session_id IS NULL AND p.path = ?
              AND c.worktree_path IS NULL AND (c.account_id = ? OR c.account_id IS NULL)
              AND c.status IN ('starting', 'running', 'resuming', 'stopped')
              AND h.prompt = ?
          `).all(session.provider, normalizedPath, accountId, firstUserPrompt) as Array<{ id: number; createdAt: string }>;
          const firstUserAt = Date.parse(firstUserMessage.createdAt);
          const matched = claims
            .map((candidate) => ({ ...candidate, distance: Math.abs(Date.parse(candidate.createdAt) - firstUserAt) }))
            .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= 60 * 60 * 1_000)
            .sort((left, right) => left.distance - right.distance || left.id - right.id)[0];
          if (matched) chat = { id: matched.id };
        }
      }
      if (!chat) {
        // 새 세션 ID를 미리 지정할 수 없는 Codex 위임이 동시에 여러 개 생기거나, 앞선 제출 실패 채팅이
        // 미귀속으로 남으면 상태·생성시각 휴리스틱만으로는 다음 JSONL이 엉뚱한 채팅에 붙는다. 위임은
        // 실제 터미널에 전달한 history_prompt를 보존하므로 첫 user 메시지가 정확히 같은 대상부터 고른다.
        // 줄바꿈 형식과 양끝 공백만 정규화하고 내용 일부·제목으로 추측하지 않아 다른 작업을 가로채지 않는다.
        const firstUserPrompt = session.messages.find((message) => message.role === "user")?.content.replace(/\r\n/g, "\n").trim();
        if (firstUserPrompt) {
          const candidates = this.database.prepare(`
            SELECT c.id, COALESCE(d.history_prompt, d.prompt) AS deliveredPrompt
            FROM delegations d
            JOIN chats c ON c.id = d.target_chat_id
            JOIN projects p ON p.id = c.project_id
            WHERE c.provider = ? AND c.provider_session_id IS NULL AND p.path = ?
              AND c.worktree_path IS NULL AND d.status IN ('pending', 'sent')
            ORDER BY d.created_at DESC, d.rowid DESC
          `).all(session.provider, normalizedPath) as Array<{ id: number; deliveredPrompt: string }>;
          const matched = candidates.find((candidate) => candidate.deliveredPrompt.replace(/\r\n/g, "\n").trim() === firstUserPrompt);
          if (matched) chat = { id: matched.id };
        }
      }
      // session_meta만 생기고 첫 user 메시지가 아직 없는 미예약 세션을 FIFO로 붙이면, sendPrompt의
      // busy 반영보다 스캔이 먼저 돈 순간 다른 빈 채팅을 가로챈다. 첫 메시지가 생길 때까지 보류한다.
      if (!chat && !session.messages.some((message) => message.role === "user")) return null;
      if (!chat) {
        // Codex는 새 세션 ID를 실행 전에 지정할 수 없어 첫 질문 뒤 생긴 JSONL을 미귀속 채팅에 붙인다.
        // 이때 오래전에 만들었다가 비워 둔 stopped 채팅을 단순 FIFO로 먼저 집으면, 방금 실행한 채팅의
        // 대화가 그 옛 채팅으로 들어가고 현재 채팅은 history_file 없이 남는다(실사용 보고, 2026-08-22).
        // 실행 중인 채팅을 stopped보다 먼저, 그중 실제 질문을 받아 busy인 채팅을 먼저 고른다. 같은
        // 상태끼리는 기존 FIFO를 유지해 동시에 시작된 세션을 오래된 순서로 스캔해도 회전하지 않게 한다.
        chat = this.database.prepare(`
          SELECT c.id FROM chats c JOIN projects p ON p.id = c.project_id
          WHERE c.provider = ? AND c.provider_session_id IS NULL AND p.path = ? AND c.worktree_path IS NULL
          ORDER BY
            CASE WHEN c.status IN ('starting', 'resuming', 'running') THEN 0 ELSE 1 END,
            c.busy DESC,
            c.created_at ASC,
            c.id ASC
          LIMIT 1
        `).get(session.provider, normalizedPath) as { id: number } | undefined;
      }
      // 공급자가 주는 더 나은 표시 제목(displayTitle: Claude는 claude --resume 화면과 같은 CLI 표시
      // 이름, 없으면 aiTitle)이 있으면 그걸, 없으면 원래대로 첫 메시지 기반 제목을 쓴다.
      const preferredTitle = session.displayTitle?.trim() || session.title;
      if (chat) {
        // worktree 세션이 별도 프로젝트에 붙어 원본 화면에서 답변이 보이지 않던 문제 때문에 기존 채팅도
        // 올바른 프로젝트로 되돌린다. 되돌리는 건 worktree 소유자가 확인된 경우뿐이다 — 일반 채팅까지
        // 세션 cwd로 매번 재귀속하면 에이전트가 Bash로 `cd`만 해도 채팅이 다른 프로젝트로 튕겨나간다
        // (실사용 보고, 2026-08-14 채팅 #257). 채팅의 프로젝트는 생성 시점에 정해지고 작업 중의 cwd
        // 이동은 귀속을 바꾸지 않는다.
        // 세션이 worktree에서 돌고 있으면 그 경로·브랜치도 함께 남긴다. 이게 없으면 목록에서
        // worktree 묶음이 아니라 프로젝트 채팅 묶음에 섞여 "워크트리 채팅이 안 보인다"가 된다.
        if (worktreeOwner) {
          this.database.prepare("UPDATE chats SET project_id = ?, worktree_path = ?, git_branch = COALESCE(git_branch, ?) WHERE id = ?")
            .run(project.id, normalizedPath, worktreeOwner.branch, chat.id);
        }
        // title_source가 'manual'(SessionManager.renameSession으로 사람이 직접 이름을 바꾼 경우)이면
        // 절대 덮어쓰지 않는다. 그 외(아직 아무도 안 바꾼 채팅 전부, 기존 행 포함 — NULL도 여기 해당)는
        // 매 동기화마다 그 시점 최선의 제목으로 계속 갱신한다.
        // 기록 파일이 실제로 놓인 계정이 그 채팅의 계정이다. 계정을 옮긴 뒤 새로 만들어진 세션도
        // 이 경로로 올바른 계정에 다시 붙는다.
        this.database.prepare(`
          UPDATE chats SET provider_session_id = ?, history_file = ?, account_id = ?,
            title = CASE WHEN title_source = 'manual' THEN title ELSE ? END,
            updated_at = ?, status = CASE WHEN status = 'starting' THEN 'running' ELSE status END
          WHERE id = ?
        `).run(session.sessionId, session.historyFile, accountId, preferredTitle, session.updatedAt, chat.id);
        this.database.prepare("DELETE FROM chat_history_claims WHERE chat_id = ?").run(chat.id);
      } else {
        // 사용자가 정리한(active=0) 프로젝트의 세션은 다시 채팅으로 만들지 않는다. 이게 없으면 채팅을
        // 지워도 다음 스캔에서 같은 JSONL로 곧바로 재등록돼 정리가 유지되지 않는다(#47).
        if (registeredProject && !registeredProject.active) return null;
        const tmuxSuffix = crypto.createHash("sha256").update(`${session.provider}:${session.sessionId}`).digest("hex").slice(0, 16);
        // 이 INSERT 경로에 오는 건 MyAgent가 만든 적 없는 외부 CLI 세션뿐이다(웹에서 만든 채팅은
        // 이미 행이 있어 위 UPDATE 경로를 탄다). 사용자가 웹에서 띄우지 않은 세션까지 일반 목록에
        // 쌓이면 실제 채팅이 묻히므로(실측 #61: 목록 100건 중 77건이 이 경로로 등록된 것), 목록에서
        // 빠지는 origin으로 등록한다. 사용자가 웹에서 이 채팅에 프롬프트를 보내면 SessionManager가
        // 'user'로 승격해 다시 목록에 올린다.
        // origin에 CHECK(origin IN ('user','delegation')) 제약이 있어 'external' 같은 새 값을 쓰려면
        // 테이블 재생성이 필요하다. 운영 DB 재생성은 위험 대비 실익이 적어 기존 값을 재사용한다 —
        // 사람이 터미널에서 직접 띄운 세션도 함께 묶이지만, "웹에서 명시적으로 띄우지 않은 건 목록에
        // 보일 필요가 없다"는 판단이라 동작상 차이가 없다.
        const result = this.database.prepare(`
          INSERT INTO chats(project_id, provider, account_id, provider_session_id, tmux_name, status, title, history_file, worktree_path, git_branch, created_at, updated_at, origin)
          VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, 'delegation')
        `).run(project.id, session.provider, accountId, session.sessionId, `web_agent_manager_${tmuxSuffix}`, preferredTitle, session.historyFile,
          worktreeOwner ? normalizedPath : null, worktreeOwner?.branch ?? null, session.createdAt, session.updatedAt);
        chat = { id: Number(result.lastInsertRowid) };
      }
      return { chatId: chat.id };
    });
    const persisted = transaction();
    // 정리된 프로젝트의 세션은 채팅을 만들지 않았으므로 이후 갱신·알림도 건너뛴다.
    if (!persisted) return;
    const { chatId } = persisted;
    this.taskCommands?.observeHistoryMessages(chatId, session.messages);
    const usageSnapshot = tokenUsageSnapshotForChat(this.database, chatId);
    if (usageSnapshot) this.tokenUsage?.recordSession(session, usageSnapshot);
    console.debug("[web-agent-manager:chat:server]", "history:updated", { at: new Date().toISOString(), chatId, provider: session.provider, messageCount: session.messages.length, turnEndedAt: session.turnEndedAt ?? null });
    this.realtime.broadcast("history_updated", { chatId });
    // JSONL 자체에 기록된 모델명이 있으면 그걸로 갱신한다. 터미널 시작 배너 화면 파싱은 타이밍에 의존적이라
    // 한 번 놓치면 재시도가 없었는데, 이 값은 새 메시지가 기록될 때마다 갱신되어 훨씬 안정적으로 복구된다.
    if (session.model) {
      const current = this.database.prepare("SELECT model FROM chats WHERE id = ?").get(chatId) as { model: string | null } | undefined;
      if (current?.model !== session.model) {
        this.database.prepare("UPDATE chats SET model = ? WHERE id = ?").run(session.model, chatId);
        this.realtime.broadcast("chat_model", { chatId, model: session.model });
      }
    }
    const last = session.messages[session.messages.length - 1];
    const previousLastMessageId = this.lastSeenMessageId.get(chatId);
    // 직전 동기화(2초 간격) 이후 새로 쌓인 메시지 "전부"를 본다. 마지막 메시지 하나만 보면, 그 사이에
    // tool_call과 그 결과(tool_result)가 둘 다 빠르게 기록돼버린 경우(짧은 명령 하나만 실행한 턴 등)
    // 마지막으로 남는 건 tool_result뿐이라 중간의 tool_call이 통째로 스킵되어 작업중 표시가 한 번도
    // 안 뜨는 문제가 있었다.
    const previousIndex = previousLastMessageId !== undefined ? session.messages.findIndex((message) => message.id === previousLastMessageId) : -1;
    const newMessages = previousIndex >= 0 ? session.messages.slice(previousIndex + 1) : last ? [last] : [];
    if (last) this.lastSeenMessageId.set(chatId, last.id);
    // 사용량 한도 등으로 assistant 메시지 없이 턴이 끝날 수도 있어, 새 메시지 유무와 별개로
    // 턴 종료 자체도 감지해야 "응답 생성 중" 표시가 영영 안 풀리는 문제를 막을 수 있다.
    // isTurnEnd는 "지금 턴이 끝나 있는가"(수준)다. 같은 종료 시각을 사이드카가 한 번 더 persist해도
    // 도구 결과로 busy를 다시 올리지 않는다. 완료 알림만 엣지(처음 본 종료 시각)로 보낸다.
    const currentTurnComplete = !!session.turnEndedAt;
    const isTurnEndEdge = currentTurnComplete && this.lastSeenTurnEnd.get(chatId) !== session.turnEndedAt;
    if (session.turnEndedAt) this.lastSeenTurnEnd.set(chatId, session.turnEndedAt);
    // 완료 알림·작업중 표시 정책은 공급자별 기록 형식에 강하게 묶여 있어 어댑터가 판단한다.
    // HistorySynchronizer는 새 메시지와 턴 종료 여부만 계산해 전달한다.
    const decision = adapter.evaluateHistorySync({ session, last, newMessages, isTurnEnd: currentTurnComplete });
    const chatState = this.database.prepare("SELECT status, origin, busy FROM chats WHERE id = ?").get(chatId) as
      { status: string; origin: string; busy: number } | undefined;
    // 외부 JSONL을 자동 발견한 채팅은 실제 관리 tmux가 없어 stopped로 등록된다. 완료 레코드 없이
    // user 메시지만 남은 기록이더라도 실행 중인 터미널이 없으므로 busy를 올리지 않고 옛 값도 정리한다.
    // error도 같이 내린다. setStatus는 오류 시 busy를 내리지만 곧바로 여기서 다시 올려버려
    // `status='error' + busy=1`이 남았고, 그 조합에서는 사용자가 작업중 표시를 보면서도 전송이 계속
    // 실패해 스스로 복구할 방법이 없었다(실사용 보고, 2026-08-14 채팅 #257).
    if (chatState?.status === "stopped" || chatState?.status === "error") {
      setChatBusy(this.database, this.realtime, chatId, false);
    } else {
      if (decision.markBusy) setChatBusy(this.database, this.realtime, chatId, true);
      if (decision.clearBusy) setChatBusy(this.database, this.realtime, chatId, false);
    }
    // Claude가 턴을 끝냈다면 훅 요청에도 더 이상 응답을 기다리지 않으므로 유실된 HTTP 대기를 정리한다.
    if (adapter.id === "claude" && decision.notifyCompletion) {
      this.approvals.closeCompletedClaudeApprovals(chatId, "Claude 응답이 완료되어 자동으로 정리되었습니다.");
    }
    const completionEdge = decision.notifyCompletion && (!session.turnEndedAt || isTurnEndEdge);
    if (completionEdge) {
      this.considerCompletionNotification(chatId, session, last, notifyCompletion, chatState?.origin ?? "user");
      // 시작 스캔의 과거 턴과 종료된 외부 채팅은 훅 대조 대상이 아니므로 실시간 주기의 실행 중 채팅만 센다.
      if (notifyCompletion && chatState && chatState.status !== "stopped") this.hookObserver?.recordPollingTurnEnd(adapter.id, chatId);
    }
  }

  // 위임 채팅은 알림을 생략하고, 부모는 미완료 위임이 있으면 완료 알림을 보류한다.
  private considerCompletionNotification(
    chatId: number,
    session: HistorySession,
    last: HistorySession["messages"][number] | undefined,
    notifyCompletion: boolean,
    origin: string,
  ): void {
    if (origin === "delegation") return;
    const completionKey = session.turnEndedAt ?? last?.id ?? session.updatedAt;
    const held: HeldCompletion = {
      chatId,
      eventId: `completed:${session.provider}:${session.sessionId}:${completionKey}`,
      provider: session.provider,
      title: session.title,
      cwd: session.cwd,
      delegationIds: [],
    };
    const open = listOpenSourceDelegations(this.database, chatId);
    const turnAt = session.turnEndedAt ?? last?.createdAt ?? session.updatedAt;
    const relevant = notifyCompletion ? open : open.filter((row) => delegationBelongsToTurn(row.created_at, turnAt));
    if (relevant.length) {
      held.delegationIds = relevant.map((row) => row.id);
      this.heldCompletions.set(chatId, held);
      return;
    }
    if (!notifyCompletion) return;
    this.heldCompletions.delete(chatId);
    this.emitCompletion(held);
  }

  // 보류해 둔 부모 완료 알림을, 위임이 모두 끝나고 부모도 한가할 때 한 번 보낸다.
  private flushHeldCompletions(): void {
    for (const [chatId, held] of [...this.heldCompletions]) {
      if (listOpenSourceDelegations(this.database, chatId).length) continue;
      const parent = this.database.prepare("SELECT busy FROM chats WHERE id = ?").get(chatId) as { busy: number } | undefined;
      if (parent?.busy === 1) continue;
      this.heldCompletions.delete(chatId);
      this.emitCompletion(held, this.failureSummary(held.delegationIds));
    }
  }

  // 보류했던 위임 ID 가운데 실패로 끝난 건수를 센다.
  private failureSummary(delegationIds: string[]): { total: number; failed: number } {
    if (!delegationIds.length) return { total: 0, failed: 0 };
    const placeholders = delegationIds.map(() => "?").join(",");
    const row = this.database.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM delegations WHERE id IN (${placeholders})
    `).get(...delegationIds) as { total: number; failed: number | null };
    return { total: row.total, failed: row.failed ?? 0 };
  }

  // 푸시·ntfy와 브라우저용 task_completed 이벤트를 함께 보낸다.
  private emitCompletion(held: HeldCompletion, summary?: { total: number; failed: number }): void {
    const lines = [
      "AI 작업이 완료되었습니다.",
      `공급자: ${held.provider}`,
      `프로젝트: ${path.basename(held.cwd)}`,
    ];
    if (summary && summary.failed > 0) {
      lines.push(`위임 작업 ${summary.total}건 중 ${summary.failed}건이 실패했습니다.`);
    }
    lines.push(`${this.config.publicUrl}/?chat=${held.chatId}`);
    void this.notifications.notify(held.eventId, "task_completed", lines.join("\n"));
    // chat_busy:false는 도구 호출 사이 턴 종료 등 완료가 아닌 경우에도 뜨므로, 브라우저 알림은 실제
    // 완료(decision.notifyCompletion)에만 반응하도록 별도 이벤트로 분리해 보낸다.
    this.realtime.broadcast("task_completed", { chatId: held.chatId, provider: held.provider, title: held.title });
  }
}
