import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import { writeAudit } from "../core/audit";
import { createLogger } from "../core/logger";
import type { ProviderAdapter } from "../providers/provider";
import type { AuthUser, Provider } from "../../shared/types";

export type PromptScheduleMode = "new_chat" | "existing_chat";

export interface PromptScheduleInput {
  name: string;
  projectId: number;
  mode: PromptScheduleMode;
  provider?: Provider | null;
  accountId?: number | null;
  chatId?: number | null;
  prompt: string;
  dailyTime: string;
  timezone: string;
  // 지정하면 이 현지 날짜(YYYY-MM-DD)에 한 번만 실행한다(#99). 비우면 매일 반복한다.
  runDate?: string | null;
  enabled?: boolean;
}

interface PromptScheduleRow {
  id: number;
  name: string;
  project_id: number;
  mode: PromptScheduleMode;
  provider: Provider | null;
  account_id: number | null;
  chat_id: number | null;
  prompt: string;
  daily_time: string;
  timezone: string;
  run_date: string | null;
  enabled: number;
  last_run_date: string | null;
}

interface ScheduleSessionRuntime {
  start(chatId: number, resume: boolean): void;
  sendPrompt(chatId: number, text: string, user: AuthUser | null): Promise<string>;
}

interface ScheduleAccountRuntime {
  requireForProvider(provider: Provider, accountId?: number | null): { id: number };
}

const log = createLogger("prompt-scheduler");
const TICK_MS = 15_000;

function assertTimezone(timezone: string): string {
  const value = timezone.trim();
  if (!value || value.length > 100) throw new Error("유효한 시간대가 필요합니다.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); } catch { throw new Error("유효한 IANA 시간대가 필요합니다."); }
  return value;
}

function assertDailyTime(time: string): string {
  const value = time.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("매일 실행 시각은 HH:MM 형식이어야 합니다.");
  return value;
}

// 1회 실행 날짜를 검증한다. 달력에 없는 날짜(2026-02-30 등)도 거부한다.
function assertRunDate(date: string): string {
  const value = date.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!parsed || parsed.toISOString().slice(0, 10) !== value) throw new Error("1회 실행 날짜는 YYYY-MM-DD 형식이어야 합니다.");
  return value;
}

// 예약이 지금 실행할 때가 됐는지 본다. 1회 예약은 지정 날짜의 시각이 지났으면(서버가 그날 꺼져 있었다면
// 이후 첫 확인 때라도) 한 번 실행하고, 매일 예약은 오늘 시각이 지났고 오늘 아직 안 돌았을 때만 실행한다.
export function isScheduleDue(schedule: { daily_time: string; run_date: string | null; last_run_date: string | null }, stamp: { date: string; time: string }): boolean {
  if (schedule.run_date) {
    if (schedule.last_run_date) return false;
    return stamp.date > schedule.run_date || (stamp.date === schedule.run_date && stamp.time >= schedule.daily_time);
  }
  return stamp.time >= schedule.daily_time && schedule.last_run_date !== stamp.date;
}

// 한 시각을 지정 시간대의 YYYY-MM-DD와 HH:MM으로 바꿔 일일 중복 방지와 실행 판정에 함께 쓴다.
export function localScheduleStamp(now: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: assertTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

// WAM 서버가 살아 있는 동안 DB 일정을 감시하되, 실행일을 먼저 원자 선점해 재시작·겹친 tick에서도 한 번만 보낸다.
export class PromptScheduler {
  private readonly adapters: Map<string, ProviderAdapter>;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly running = new Set<number>();

  constructor(
    private readonly database: AppDatabase,
    private readonly sessions: ScheduleSessionRuntime,
    adapters: ProviderAdapter[],
    private readonly accounts: ScheduleAccountRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): Array<Record<string, unknown>> {
    return this.database.prepare(`
      SELECT s.*, p.name AS project_name, c.title AS chat_title, lc.title AS last_chat_title,
             a.label AS account_label
      FROM prompt_schedules s
      JOIN projects p ON p.id = s.project_id
      LEFT JOIN chats c ON c.id = s.chat_id
      LEFT JOIN chats lc ON lc.id = s.last_chat_id
      LEFT JOIN agent_accounts a ON a.id = s.account_id
      ORDER BY s.enabled DESC, s.daily_time, s.id
    `).all() as Array<Record<string, unknown>>;
  }

  create(input: PromptScheduleInput, userId: number): Record<string, unknown> {
    const normalized = this.validate(input);
    const lastRunDate = this.initialLastRunDate(normalized.enabled, normalized.dailyTime, normalized.timezone, normalized.runDate);
    const result = this.database.prepare(`
      INSERT INTO prompt_schedules(name, project_id, mode, provider, account_id, chat_id, prompt, daily_time, timezone, run_date, enabled, last_run_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.name, normalized.projectId, normalized.mode, normalized.provider, normalized.accountId,
      normalized.chatId, normalized.prompt, normalized.dailyTime, normalized.timezone, normalized.runDate,
      normalized.enabled ? 1 : 0, lastRunDate, userId,
    );
    const id = Number(result.lastInsertRowid);
    writeAudit(this.database, userId, "prompt_schedule.create", "prompt_schedule", id, { mode: normalized.mode, dailyTime: normalized.dailyTime, timezone: normalized.timezone, runDate: normalized.runDate });
    return this.get(id);
  }

  update(id: number, input: PromptScheduleInput, userId: number): Record<string, unknown> {
    this.require(id);
    const normalized = this.validate(input);
    const lastRunDate = this.initialLastRunDate(normalized.enabled, normalized.dailyTime, normalized.timezone, normalized.runDate);
    this.database.prepare(`
      UPDATE prompt_schedules SET name = ?, project_id = ?, mode = ?, provider = ?, account_id = ?, chat_id = ?,
        prompt = ?, daily_time = ?, timezone = ?, run_date = ?, enabled = ?, last_run_date = ?, last_status = NULL,
        last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(
      normalized.name, normalized.projectId, normalized.mode, normalized.provider, normalized.accountId,
      normalized.chatId, normalized.prompt, normalized.dailyTime, normalized.timezone, normalized.runDate,
      normalized.enabled ? 1 : 0, lastRunDate, id,
    );
    writeAudit(this.database, userId, "prompt_schedule.update", "prompt_schedule", id, { mode: normalized.mode, dailyTime: normalized.dailyTime, timezone: normalized.timezone, runDate: normalized.runDate });
    return this.get(id);
  }

  // 저장·활성화 직후의 last_run_date를 정한다. 매일 예약은 오늘 시각이 이미 지났으면 저장 직후의 뜻밖의
  // 즉시 실행을 막고 다음 날부터 시작한다. 1회 예약은 지난 시각이면 곧바로 실행되므로 저장 자체를 거부한다.
  private initialLastRunDate(enabled: boolean, dailyTime: string, timezone: string, runDate: string | null): string | null {
    const stamp = localScheduleStamp(this.now(), timezone);
    if (runDate) {
      if (enabled && (runDate < stamp.date || (runDate === stamp.date && dailyTime <= stamp.time))) {
        throw new Error("이미 지난 1회 실행 시각입니다. 앞으로의 날짜·시각을 지정해주세요.");
      }
      return null;
    }
    return enabled && stamp.time >= dailyTime ? stamp.date : null;
  }

  setEnabled(id: number, enabled: boolean, userId: number): Record<string, unknown> {
    const schedule = this.require(id);
    const lastRunDate = this.initialLastRunDate(enabled, schedule.daily_time, schedule.timezone, schedule.run_date);
    this.database.prepare("UPDATE prompt_schedules SET enabled = ?, last_run_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(enabled ? 1 : 0, lastRunDate, id);
    writeAudit(this.database, userId, enabled ? "prompt_schedule.enable" : "prompt_schedule.disable", "prompt_schedule", id);
    return this.get(id);
  }

  delete(id: number, userId: number): void {
    this.require(id);
    if (this.running.has(id)) throw new Error("실행 중인 일정은 삭제할 수 없습니다.");
    this.database.prepare("DELETE FROM prompt_schedules WHERE id = ?").run(id);
    writeAudit(this.database, userId, "prompt_schedule.delete", "prompt_schedule", id);
  }

  async runNow(id: number, userId: number): Promise<Record<string, unknown>> {
    const schedule = this.require(id);
    if (this.running.has(id)) throw new Error("이미 실행 중인 일정입니다.");
    const stamp = localScheduleStamp(this.now(), schedule.timezone);
    // 1회 예약을 즉시 실행하면 그 한 번을 쓴 것으로 보고 끈다.
    this.database.prepare(`
      UPDATE prompt_schedules SET last_run_date = ?, last_run_at = CURRENT_TIMESTAMP, last_status = 'running', last_error = NULL,
        enabled = CASE WHEN run_date IS NULL THEN enabled ELSE 0 END, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(stamp.date, id);
    writeAudit(this.database, userId, "prompt_schedule.run", "prompt_schedule", id);
    await this.execute({ ...schedule, last_run_date: stamp.date });
    return this.get(id);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const schedules = this.database.prepare("SELECT * FROM prompt_schedules WHERE enabled = 1").all() as PromptScheduleRow[];
      const executions: Promise<void>[] = [];
      for (const schedule of schedules) {
        if (this.running.has(schedule.id)) continue;
        let stamp: { date: string; time: string };
        try { stamp = localScheduleStamp(this.now(), schedule.timezone); } catch (error) {
          this.markError(schedule.id, error);
          continue;
        }
        if (!isScheduleDue(schedule, stamp)) continue;
        // 1회 예약은 선점과 같은 UPDATE에서 끈다. 겹친 tick·재시작에서도 두 번 실행되지 않는다.
        const claimed = this.database.prepare(`
          UPDATE prompt_schedules SET last_run_date = ?, last_run_at = CURRENT_TIMESTAMP, last_status = 'running', last_error = NULL,
            enabled = CASE WHEN run_date IS NULL THEN 1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND enabled = 1 AND (last_run_date IS NULL OR last_run_date <> ?)
        `).run(stamp.date, schedule.id, stamp.date);
        if (!claimed.changes) continue;
        executions.push(this.execute({ ...schedule, last_run_date: stamp.date }));
      }
      await Promise.allSettled(executions);
    } finally {
      this.ticking = false;
    }
  }

  private async execute(schedule: PromptScheduleRow): Promise<void> {
    this.running.add(schedule.id);
    let chatId: number | null = null;
    try {
      chatId = schedule.mode === "new_chat" ? this.createChat(schedule) : this.requireTargetChat(schedule);
      await this.sessions.sendPrompt(chatId, schedule.prompt, null);
      this.database.prepare("UPDATE prompt_schedules SET last_status = 'success', last_error = NULL, last_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(chatId, schedule.id);
      writeAudit(this.database, null, "prompt_schedule.success", "prompt_schedule", schedule.id, { chatId });
    } catch (error) {
      this.markError(schedule.id, error, chatId);
      log.error("예약 프롬프트 실행 실패", { scheduleId: schedule.id, chatId, error });
    } finally {
      this.running.delete(schedule.id);
    }
  }

  private createChat(schedule: PromptScheduleRow): number {
    if (!schedule.provider) throw new Error("새 채팅 일정의 공급자가 없습니다.");
    const adapter = this.adapters.get(schedule.provider);
    if (!adapter) throw new Error("지원하지 않는 공급자입니다.");
    const project = this.database.prepare("SELECT id FROM projects WHERE id = ? AND active = 1").get(schedule.project_id);
    if (!project) throw new Error("프로젝트가 없거나 비활성 상태입니다.");
    const account = this.accounts.requireForProvider(schedule.provider, schedule.account_id);
    const placeholder = `pending_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = this.database.prepare(`
      INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title, title_source, origin)
      VALUES (?, ?, ?, ?, 'starting', ?, 'manual', 'user')
    `).run(schedule.project_id, schedule.provider, account.id, placeholder, `예약 · ${schedule.name}`.slice(0, 200));
    const chatId = Number(result.lastInsertRowid);
    this.database.prepare("UPDATE chats SET tmux_name = ? WHERE id = ?").run(`web_agent_manager_chat_${chatId}`, chatId);
    this.sessions.start(chatId, false);
    return chatId;
  }

  private requireTargetChat(schedule: PromptScheduleRow): number {
    if (!schedule.chat_id) throw new Error("지정된 기존 채팅이 삭제되었습니다.");
    const chat = this.database.prepare(`
      SELECT c.id FROM chats c JOIN projects p ON p.id = c.project_id
      WHERE c.id = ? AND c.project_id = ? AND p.active = 1
    `).get(schedule.chat_id, schedule.project_id) as { id: number } | undefined;
    if (!chat) throw new Error("지정된 채팅 또는 프로젝트를 사용할 수 없습니다.");
    return chat.id;
  }

  private validate(input: PromptScheduleInput): Required<Omit<PromptScheduleInput, "provider" | "accountId" | "chatId" | "runDate">> & { provider: Provider | null; accountId: number | null; chatId: number | null; runDate: string | null } {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name || name.length > 120) throw new Error("일정 이름은 1자 이상 120자 이하여야 합니다.");
    if (!prompt || prompt.length > 100_000) throw new Error("입력 문구는 1자 이상 100,000자 이하여야 합니다.");
    if (!Number.isInteger(input.projectId) || input.projectId <= 0) throw new Error("프로젝트가 필요합니다.");
    const project = this.database.prepare("SELECT id FROM projects WHERE id = ? AND active = 1").get(input.projectId);
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    if (!(["new_chat", "existing_chat"] as string[]).includes(input.mode)) throw new Error("유효한 실행 방식이 필요합니다.");

    let provider: Provider | null = null;
    let accountId: number | null = null;
    let chatId: number | null = null;
    if (input.mode === "new_chat") {
      if (!input.provider || !this.adapters.has(input.provider)) throw new Error("새 채팅에 사용할 공급자가 필요합니다.");
      provider = input.provider;
      const account = this.accounts.requireForProvider(provider, input.accountId);
      accountId = account.id;
    } else {
      chatId = Number(input.chatId);
      const chat = this.database.prepare("SELECT id FROM chats WHERE id = ? AND project_id = ?").get(chatId, input.projectId);
      if (!chat) throw new Error("선택한 프로젝트의 기존 채팅이 필요합니다.");
    }
    return {
      name,
      projectId: input.projectId,
      mode: input.mode,
      provider,
      accountId,
      chatId,
      prompt,
      dailyTime: assertDailyTime(input.dailyTime),
      timezone: assertTimezone(input.timezone),
      runDate: input.runDate && input.runDate.trim() ? assertRunDate(input.runDate) : null,
      enabled: input.enabled !== false,
    };
  }

  private require(id: number): PromptScheduleRow {
    if (!Number.isInteger(id) || id <= 0) throw new Error("유효한 일정 ID가 필요합니다.");
    const schedule = this.database.prepare("SELECT * FROM prompt_schedules WHERE id = ?").get(id) as PromptScheduleRow | undefined;
    if (!schedule) throw new Error("일정을 찾을 수 없습니다.");
    return schedule;
  }

  private get(id: number): Record<string, unknown> {
    return this.list().find((schedule) => schedule.id === id) ?? this.require(id) as unknown as Record<string, unknown>;
  }

  private markError(id: number, error: unknown, chatId: number | null = null): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    this.database.prepare("UPDATE prompt_schedules SET last_status = 'error', last_error = ?, last_chat_id = COALESCE(?, last_chat_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(message, chatId, id);
    writeAudit(this.database, null, "prompt_schedule.error", "prompt_schedule", id, { chatId, message });
  }
}
