import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { ProviderAdapter, HistorySession } from "../providers/provider";
import type { RealtimeHub } from "./realtime";
import type { Notifier } from "./notifier";
import type { HistoryCache } from "./history-cache";
import { setChatBusy } from "../core/chat-busy";

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
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly adapters: ProviderAdapter[],
    private readonly realtime: RealtimeHub,
    private readonly notifications: Notifier,
    private readonly historyCache: HistoryCache,
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

  // 모든 공급자의 변경된 JSONL 파일을 동기화한다.
  syncAll(notifyCompletion = false): void {
    for (const adapter of this.adapters) {
      for (const file of findJsonlFiles(adapter.historyRoot)) {
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
        this.persist(adapter, session, notifyCompletion);
        this.seenMtime.set(file, mtime);
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

  // 파싱한 세션과 메시지를 중복 없이 데이터베이스에 반영한다.
  private persist(adapter: ProviderAdapter, session: HistorySession, notifyCompletion: boolean): void {
    const transaction = this.database.transaction(() => {
      const normalizedPath = fs.realpathSync(session.cwd);
      this.database.prepare(`
        INSERT INTO projects(name, path, source, updated_at)
        VALUES (?, ?, 'discovered', CURRENT_TIMESTAMP)
        ON CONFLICT(path) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      `).run(path.basename(normalizedPath), normalizedPath);
      const project = this.database.prepare("SELECT id FROM projects WHERE path = ?").get(normalizedPath) as { id: number };
      let chat = this.database.prepare("SELECT id FROM chats WHERE provider = ? AND provider_session_id = ?").get(session.provider, session.sessionId) as { id: number } | undefined;
      if (!chat) {
        chat = this.database.prepare(`
          SELECT c.id FROM chats c JOIN projects p ON p.id = c.project_id
          WHERE c.provider = ? AND c.provider_session_id IS NULL AND p.path = ?
          ORDER BY c.created_at DESC LIMIT 1
        `).get(session.provider, normalizedPath) as { id: number } | undefined;
      }
      // 공급자가 주는 더 나은 표시 제목(displayTitle: Claude는 claude --resume 화면과 같은 CLI 표시
      // 이름, 없으면 aiTitle)이 있으면 그걸, 없으면 원래대로 첫 메시지 기반 제목을 쓴다.
      const preferredTitle = session.displayTitle?.trim() || session.title;
      if (chat) {
        // title_source가 'manual'(SessionManager.renameSession으로 사람이 직접 이름을 바꾼 경우)이면
        // 절대 덮어쓰지 않는다. 그 외(아직 아무도 안 바꾼 채팅 전부, 기존 행 포함 — NULL도 여기 해당)는
        // 매 동기화마다 그 시점 최선의 제목으로 계속 갱신한다.
        this.database.prepare(`
          UPDATE chats SET provider_session_id = ?, history_file = ?,
            title = CASE WHEN title_source = 'manual' THEN title ELSE ? END,
            updated_at = ?, status = CASE WHEN status = 'starting' THEN 'running' ELSE status END
          WHERE id = ?
        `).run(session.sessionId, session.historyFile, preferredTitle, session.updatedAt, chat.id);
      } else {
        const tmuxSuffix = crypto.createHash("sha256").update(`${session.provider}:${session.sessionId}`).digest("hex").slice(0, 16);
        const result = this.database.prepare(`
          INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, history_file, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'stopped', ?, ?, ?, ?)
        `).run(project.id, session.provider, session.sessionId, `web_agent_manager_${tmuxSuffix}`, preferredTitle, session.historyFile, session.createdAt, session.updatedAt);
        chat = { id: Number(result.lastInsertRowid) };
      }
      return { chatId: chat.id };
    });
    const { chatId } = transaction();
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
    if (chatState?.status === "stopped") {
      setChatBusy(this.database, this.realtime, chatId, false);
    } else {
      if (decision.markBusy) setChatBusy(this.database, this.realtime, chatId, true);
      if (decision.clearBusy) setChatBusy(this.database, this.realtime, chatId, false);
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
