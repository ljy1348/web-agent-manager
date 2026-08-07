import fs from "node:fs";
import type { AppDatabase } from "../core/database";
import { writeAudit } from "../core/audit";

const CHECK_INTERVAL_MS = 10 * 60_000;
const MIN_TIMEOUT_HOURS = 1;
const MAX_TIMEOUT_HOURS = 24 * 30;

export interface IdleChatSettings {
  enabled: boolean;
  timeoutHours: number;
}

interface IdleCandidate {
  id: number;
  title: string;
  provider: string;
  updatedAt: string | null;
  historyFile: string | null;
}

// 자동 종료가 실제로 호출할 종료 동작. SessionManager.stop을 그대로 받아 쓴다.
type StopChat = (chatId: number) => Promise<void>;

// chats.updated_at에는 history-sync가 넣는 ISO 문자열과 SQLite CURRENT_TIMESTAMP 기본값이 섞여 있다.
// 후자는 "YYYY-MM-DD HH:MM:SS" UTC라 그대로 Date.parse하면 로컬 시각으로 오해돼 유휴 판정이 시간대만큼
// 어긋난다 — 그 형식일 때만 UTC임을 명시해 파싱한다.
function parseTimestamp(value: string | null): number {
  if (!value) return Number.NaN;
  const trimmed = value.trim();
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed);
  return Date.parse(sqliteUtc ? `${trimmed.replace(" ", "T")}Z` : trimmed);
}

// 하루 넘게 아무 활동이 없는 채팅 터미널을 주기적으로 종료한다.
// 되돌릴 수 없는 동작이라 "정말 노는 중"이라는 근거가 뚜렷한 채팅만 고른다 — 작업 중이거나 리밋 재개를
// 기다리거나 사용자의 승인 응답을 기다리는 채팅은 유휴 시간이 아무리 길어도 손대지 않는다.
export class IdleChatReaper {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly database: AppDatabase,
    private readonly stopChat: StopChat,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    // 서버가 막 뜬 직후에도 한 번 훑는다. 주기만 걸어두면 재시작할 때마다 첫 정리가 10분씩 밀린다.
    // 다만 restore()가 tmux를 다시 붙이는 중에 끼어들지 않도록 잠깐 뒤로 미룬다.
    setTimeout(() => void this.sweep(), 30_000).unref();
    this.timer = setInterval(() => void this.sweep(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // 저장된 정책을 읽는다. 행이 없으면 기본값(켜짐·24시간)으로 동작한다.
  settings(): IdleChatSettings {
    const row = this.database.prepare("SELECT enabled, timeout_hours AS timeoutHours FROM idle_chat_settings WHERE id = 1")
      .get() as { enabled: number; timeoutHours: number } | undefined;
    if (!row) return { enabled: true, timeoutHours: 24 };
    return { enabled: !!row.enabled, timeoutHours: row.timeoutHours };
  }

  // 관리자가 정한 정책을 저장한다. 너무 짧은 값은 실제 작업 중인 세션을 끊을 수 있어 하한을 둔다.
  updateSettings(enabled: boolean, timeoutHours: number): IdleChatSettings {
    const hours = Math.round(Number(timeoutHours));
    if (!Number.isFinite(hours) || hours < MIN_TIMEOUT_HOURS || hours > MAX_TIMEOUT_HOURS) {
      throw new Error(`자동 종료 기준 시간은 ${MIN_TIMEOUT_HOURS}~${MAX_TIMEOUT_HOURS}시간 사이여야 합니다.`);
    }
    this.database.prepare(`
      INSERT INTO idle_chat_settings(id, enabled, timeout_hours, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, timeout_hours = excluded.timeout_hours, updated_at = CURRENT_TIMESTAMP
    `).run(enabled ? 1 : 0, hours);
    return this.settings();
  }

  // 마지막 활동 시각은 실제 대화가 기록되는 JSONL의 mtime을 1순위로 본다.
  // chats.updated_at은 서버가 재시작하며 tmux를 다시 연결할 때도 setStatus로 현재 시각이 되어(실측:
  // 27시간 논 채팅이 재시작 직후 "21분 전"이 됨) 재시작만 반복하면 자동 종료가 영영 발동하지 않았다.
  // 기록 파일을 읽을 수 없을 때만 DB 시각으로 대체한다.
  private lastActivityAt(candidate: IdleCandidate): number {
    if (candidate.historyFile) {
      try {
        return fs.statSync(candidate.historyFile).mtimeMs;
      } catch {
        // 기록 파일이 없어졌으면 아래 DB 시각으로 판단한다.
      }
    }
    const fromDatabase = parseTimestamp(candidate.updatedAt);
    return Number.isNaN(fromDatabase) ? 0 : fromDatabase;
  }

  // 종료해도 되는 채팅만 골라낸다. 판단 근거가 없는 채팅(활동 시각을 못 읽는 경우)은 남겨 둔다.
  private candidates(timeoutHours: number): IdleCandidate[] {
    const rows = this.database.prepare(`
      SELECT c.id, c.title, c.provider, c.updated_at AS updatedAt, c.history_file AS historyFile
      FROM chats c
      WHERE c.status = 'running'
        AND COALESCE(c.busy, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM rate_limit_waits w WHERE w.chat_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.chat_id = c.id AND a.status = 'pending')
    `).all() as IdleCandidate[];
    const threshold = this.now() - timeoutHours * 3_600_000;
    return rows.filter((row) => {
      const lastActivity = this.lastActivityAt(row);
      return lastActivity > 0 && lastActivity < threshold;
    });
  }

  // 한 주기 분의 정리를 수행하고 종료한 채팅 수를 돌려준다.
  async sweep(): Promise<number> {
    const { enabled, timeoutHours } = this.settings();
    if (!enabled) return 0;
    let stopped = 0;
    for (const candidate of this.candidates(timeoutHours)) {
      try {
        await this.stopChat(candidate.id);
        writeAudit(this.database, null, "chat.idle_auto_stop", "chat", candidate.id, {
          provider: candidate.provider,
          title: candidate.title,
          timeoutHours,
          lastActivityAt: new Date(this.lastActivityAt(candidate)).toISOString(),
        });
        console.info("[web-agent-manager:idle]", "auto-stop", { chatId: candidate.id, provider: candidate.provider, timeoutHours });
        stopped += 1;
      } catch (error) {
        console.warn("[web-agent-manager:idle]", "auto-stop-failed", { chatId: candidate.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return stopped;
  }
}
