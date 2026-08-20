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
import { setChatBusy } from "../core/chat-busy";
import { tokenUsageSnapshotForChat, type TokenUsageLedger } from "./token-usage-ledger";

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
  private readonly lastSeenMessageId = new Map<number, string>();
  private readonly lastSeenTurnEnd = new Map<number, string>();
  // 본문 파일별로 마지막에 확인한 "토큰이 붙은 메시지 수". 사이드카 갱신이 실제 토큰 추가인지 가린다.
  private readonly lastTokenUsageCount = new Map<string, number>();
  private timer?: NodeJS.Timeout;

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
  ) {}

  // 초기 전체 스캔 후 주기적인 증분 동기화를 시작한다.
  start(intervalMs = 2_000): void {
    this.syncAll(false);
    this.timer = setInterval(() => this.syncAll(true), intervalMs);
    this.timer.unref();
  }

  // 기록 동기화 타이머를 종료한다.
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // 모든 공급자의 변경된 JSONL 파일을 동기화한다. 계정마다 설정 디렉터리가 달라 기록 루트도 갈라지므로
  // 등록된 계정 전부를 훑는다 — 한 루트만 보면 다른 계정에서 만든 채팅이 목록에 아예 나타나지 않는다.
  syncAll(notifyCompletion = false): void {
    for (const adapter of this.adapters) {
      for (const account of this.accounts.list(adapter.id)) {
        for (const file of findJsonlFiles(adapter.historyRootFor(account.config_dir))) {
          let mtime: number;
          try {
            mtime = fs.statSync(file).mtimeMs;
          } catch {
            continue;
          }
          if (this.seenMtime.get(file) === mtime) continue;
          if (adapter.isHiddenHistoryFile?.(file)) {
            this.removeHiddenChat(adapter, file);
            this.seenMtime.set(file, mtime);
            continue;
          }
          const session = this.historyCache.get(adapter, file);
          if (!session || !isAllowedProject(session.cwd, this.config.allowedRoots)) continue;
          // 한 세션이 본문 파일과 사이드카 파일(턴 종료·턴 토큰)로 나뉘는 공급자(Grok)에서는, 사이드카만
          // 바뀌어도 채팅 API가 읽는 본문 파일 캐시에는 새 토큰이 반영되지 않는다. 다만 사이드카는 턴
          // 중에도 계속 쌓이므로 바뀔 때마다 캐시를 버리면 응답 내내 본문을 반복해서 다시 파싱하게 된다
          // (실측: updates.jsonl 2.9MB, 본문 717KB) — 실제로 턴 토큰이 새로 붙었을 때만 버린다.
          if (session.historyFile !== file) {
            const usageCount = session.messages.reduce((count, message) => count + (message.tokenUsage ? 1 : 0), 0);
            if (this.lastTokenUsageCount.get(session.historyFile) !== usageCount) {
              this.lastTokenUsageCount.set(session.historyFile, usageCount);
              this.historyCache.invalidate(session.historyFile);
            }
          }
          // 실험실 격리 작업공간 세션은 채팅으로 만들지 않는다. 결과는 실험 원장에 이미 남는다.
          if (isLabWorkspace(session.cwd, this.config.dataDir)) {
            this.seenMtime.set(file, mtime);
            continue;
          }
          this.persist(adapter, session, notifyCompletion, account.id);
          this.seenMtime.set(file, mtime);
        }
      }
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
        chat = this.database.prepare(`
          SELECT c.id FROM chats c JOIN projects p ON p.id = c.project_id
          WHERE c.provider = ? AND c.provider_session_id IS NULL AND p.path = ? AND c.worktree_path IS NULL
          ORDER BY c.created_at DESC LIMIT 1
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
      } else {
        // 사용자가 정리한(active=0) 프로젝트의 세션은 다시 채팅으로 만들지 않는다. 이게 없으면 채팅을
        // 지워도 다음 스캔에서 같은 JSONL로 곧바로 재등록돼 정리가 유지되지 않는다(#47).
        if (registeredProject && !registeredProject.active) return null;
        const tmuxSuffix = crypto.createHash("sha256").update(`${session.provider}:${session.sessionId}`).digest("hex").slice(0, 16);
        const result = this.database.prepare(`
          INSERT INTO chats(project_id, provider, account_id, provider_session_id, tmux_name, status, title, history_file, worktree_path, git_branch, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?)
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
    const isTurnEnd = !!session.turnEndedAt && this.lastSeenTurnEnd.get(chatId) !== session.turnEndedAt;
    if (session.turnEndedAt) this.lastSeenTurnEnd.set(chatId, session.turnEndedAt);
    // 완료 알림·작업중 표시 정책은 공급자별 기록 형식에 강하게 묶여 있어 어댑터가 판단한다.
    // HistorySynchronizer는 새 메시지와 턴 종료 여부만 계산해 전달한다.
    const decision = adapter.evaluateHistorySync({ session, last, newMessages, isTurnEnd });
    const chatState = this.database.prepare("SELECT status FROM chats WHERE id = ?").get(chatId) as { status: string } | undefined;
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
    if (decision.notifyCompletion && notifyCompletion) {
      const completionKey = session.turnEndedAt ?? last?.id ?? session.updatedAt;
      void this.notifications.notify(
        `completed:${session.provider}:${session.sessionId}:${completionKey}`,
        "task_completed",
        `AI 작업이 완료되었습니다.\n공급자: ${session.provider}\n프로젝트: ${path.basename(session.cwd)}\n${this.config.publicUrl}/?chat=${chatId}`,
      );
      // chat_busy:false는 도구 호출 사이 턴 종료 등 완료가 아닌 경우에도 뜨므로, 브라우저 알림은 실제
      // 완료(decision.notifyCompletion)에만 반응하도록 별도 이벤트로 분리해 보낸다.
      this.realtime.broadcast("task_completed", { chatId, provider: session.provider, title: session.title });
    }
  }
}
