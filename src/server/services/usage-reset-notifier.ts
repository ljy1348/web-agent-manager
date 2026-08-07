import type { AppDatabase } from "../core/database";
import type { ProviderAdapter } from "../providers/provider";
import type { Provider, UsageWindow } from "../../shared/types";
import type { RealtimeHub } from "./realtime";
import type { Notifier } from "./notifier";
import { todayResetTime } from "../providers/usage-utils";
import { zonedTimeToUtc } from "./rate-limit-resume";

const NOTIFY_DELAY_MS = 60_000;
const SAME_RESET_TOLERANCE_MS = 15 * 60_000;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

interface ResetScheduleRow {
  provider: Provider;
  window_id: string;
  scheduled_reset_at: string;
  used_percent: number | null;
  notified_at: string | null;
}

// 기준 시각과 가장 가까운 연도·날짜 후보를 골라 연말 경계에서도 실제 초기화 순간을 복원한다.
function nearestDate(candidates: Date[], now: Date): Date | null {
  const valid = candidates.filter((candidate) => !Number.isNaN(candidate.getTime()));
  return valid.sort((a, b) => Math.abs(a.getTime() - now.getTime()) - Math.abs(b.getTime() - now.getTime()))[0] ?? null;
}

// 공급자 사용량 화면의 날짜·타임존 혼합 초기화 문구를 실제 발생 시각으로 변환한다.
export function parseUsageResetMoment(resetAt: string | null | undefined, now: Date): Date | null {
  if (!resetAt) return null;
  const codexDated = resetAt.match(/(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})/i);
  if (codexDated) {
    const month = MONTHS[codexDated[4].toLowerCase()];
    if (month === undefined) return null;
    const year = now.getFullYear();
    return nearestDate([-1, 0, 1].map((offset) => new Date(year + offset, month, Number(codexDated[3]), Number(codexDated[1]), Number(codexDated[2]), 0, 0)), now);
  }
  const claudeDated = resetAt.match(/([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([A-Za-z]+\/[A-Za-z_]+)\))?/i);
  if (claudeDated) {
    const month = MONTHS[claudeDated[1].toLowerCase()];
    if (month === undefined) return null;
    let hour = Number(claudeDated[3]);
    if (claudeDated[5].toLowerCase() === "pm" && hour < 12) hour += 12;
    if (claudeDated[5].toLowerCase() === "am" && hour === 12) hour = 0;
    const minute = Number(claudeDated[4] ?? 0);
    const timeZone = claudeDated[6];
    const year = now.getFullYear();
    const candidates = [-1, 0, 1].map((offset) => timeZone
      ? zonedTimeToUtc(year + offset, month + 1, Number(claudeDated[2]), hour, minute, timeZone)
      : new Date(year + offset, month, Number(claudeDated[2]), hour, minute, 0, 0));
    return nearestDate(candidates, now);
  }
  const today = todayResetTime(resetAt, now);
  if (!today) return null;
  return nearestDate([
    new Date(today.getTime() - 24 * 60 * 60_000),
    today,
    new Date(today.getTime() + 24 * 60 * 60_000),
  ], now);
}

// 대표 사용량 창의 초기화를 예정 시각+1분 또는 조기 창 전환 시 한 번만 알린다.
export class UsageResetNotifier {
  private readonly adapters: Map<Provider, ProviderAdapter>;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly database: AppDatabase,
    private readonly notifications: Notifier,
    private readonly realtime: RealtimeHub,
    adapters: ProviderAdapter[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  // 저장된 예약을 복원하고 현재 사용량 스냅샷이 있으면 대표 창을 등록한다.
  start(): void {
    const schedules = this.database.prepare("SELECT provider, window_id, scheduled_reset_at, used_percent, notified_at FROM usage_reset_schedules").all() as ResetScheduleRow[];
    for (const schedule of schedules) if (!schedule.notified_at) this.schedule(schedule.provider, schedule.window_id, new Date(schedule.scheduled_reset_at));
    // TODO(계정별 리셋 알림): usage_reset_schedules가 (provider, window_id) 키라 계정을 구분하지 못한다.
    // 사용량 조회를 전 계정으로 넓히면 행이 계정 수만큼 생겨 서로 덮어쓰고 중복 발송되므로, 지금은
    // 기본 계정의 사용량만 알림 대상으로 삼는다. 스케줄 테이블에 account_id를 추가하면 이 제한을 없앨 수 있다.
    const usageRows = this.database.prepare(`
      SELECT provider, details_json FROM usage_status u
      WHERE data_status = 'fresh' AND details_json IS NOT NULL
        AND account_id = (SELECT id FROM agent_accounts a WHERE a.provider = u.provider AND a.is_default = 1)
    `).all() as Array<{ provider: Provider; details_json: string }>;
    for (const usage of usageRows) this.observe(usage.provider, usage.details_json, this.now());
  }

  // 모든 공급자 초기화 예약 타이머를 종료한다.
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // 정상 반영된 사용량에서 대표 창 전환을 감지하고 다음 초기화 예약을 갱신한다.
  observe(provider: Provider, detailsJson: string | null | undefined, observedAt: Date = this.now()): void {
    const adapter = this.adapters.get(provider);
    if (!adapter || !detailsJson) return;
    let windows: UsageWindow[];
    try {
      windows = (JSON.parse(detailsJson) as { windows?: UsageWindow[] }).windows ?? [];
    } catch {
      return;
    }
    const targetWindowIds = adapter.usageResetWindowIds ?? [adapter.usageWindowId];
    for (const windowId of targetWindowIds) {
      const window = windows.find((item) => item.id === windowId);
      if (window) this.observeWindow(provider, window, observedAt);
    }
  }

  // 사용량 창 하나의 전환 여부와 다음 예약을 독립적으로 갱신한다.
  private observeWindow(provider: Provider, window: UsageWindow, observedAt: Date): void {
    const resetAt = parseUsageResetMoment(window.resetAt, observedAt);
    if (!window || !resetAt) return;
    const previous = this.database.prepare("SELECT provider, window_id, scheduled_reset_at, used_percent, notified_at FROM usage_reset_schedules WHERE provider = ? AND window_id = ?").get(provider, window.id) as ResetScheduleRow | undefined;
    if (!previous) {
      this.saveSchedule(provider, window.id, resetAt, window.usedPercent);
      this.schedule(provider, window.id, resetAt);
      return;
    }
    const previousResetAt = new Date(previous.scheduled_reset_at);
    const difference = resetAt.getTime() - previousResetAt.getTime();
    if (Math.abs(difference) <= SAME_RESET_TOLERANCE_MS) {
      this.database.prepare("UPDATE usage_reset_schedules SET used_percent = ?, updated_at = CURRENT_TIMESTAMP WHERE provider = ? AND window_id = ?").run(window.usedPercent, provider, window.id);
      return;
    }
    if (difference < 0 && resetAt <= observedAt) return;
    if (!previous.notified_at && difference > 0) void this.notify(previous, true);
    this.saveSchedule(provider, window.id, resetAt, window.usedPercent);
    this.schedule(provider, window.id, resetAt);
  }

  // 공급자의 현재 대표 창 예약을 원자적으로 교체한다.
  private saveSchedule(provider: Provider, windowId: string, resetAt: Date, usedPercent: number | null): void {
    this.database.prepare(`
      INSERT INTO usage_reset_schedules(provider, window_id, scheduled_reset_at, used_percent, notified_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(provider, window_id) DO UPDATE SET
        scheduled_reset_at = excluded.scheduled_reset_at, used_percent = excluded.used_percent,
        notified_at = NULL, updated_at = CURRENT_TIMESTAMP
    `).run(provider, windowId, resetAt.toISOString(), usedPercent);
  }

  // 예정 시각 1분 뒤에 사용량 재확인 없이 발송하도록 단일 타이머를 예약한다.
  private schedule(provider: Provider, windowId: string, resetAt: Date): void {
    const timerKey = `${provider}:${windowId}`;
    const existing = this.timers.get(timerKey);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, resetAt.getTime() + NOTIFY_DELAY_MS - this.now().getTime());
    const timer = setTimeout(() => {
      this.timers.delete(timerKey);
      const schedule = this.database.prepare("SELECT provider, window_id, scheduled_reset_at, used_percent, notified_at FROM usage_reset_schedules WHERE provider = ? AND window_id = ?").get(provider, windowId) as ResetScheduleRow | undefined;
      if (schedule && !schedule.notified_at && schedule.scheduled_reset_at === resetAt.toISOString()) void this.notify(schedule, false);
    }, delay);
    timer.unref();
    this.timers.set(timerKey, timer);
  }

  // DB에서 먼저 발송 완료를 선점한 뒤 외부 채널과 브라우저에 초기화 알림을 보낸다.
  private async notify(schedule: ResetScheduleRow, detectedEarly: boolean): Promise<void> {
    const result = this.database.prepare(`
      UPDATE usage_reset_schedules SET notified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE provider = ? AND window_id = ? AND scheduled_reset_at = ? AND notified_at IS NULL
    `).run(schedule.provider, schedule.window_id, schedule.scheduled_reset_at);
    if (result.changes === 0) return;
    const label = this.adapters.get(schedule.provider)?.displayLabel ?? schedule.provider;
    const windowLabel = schedule.window_id.startsWith("weekly") ? "주간" : "세션";
    const eventId = `usage-session-reset:${schedule.provider}:${schedule.window_id}:${schedule.scheduled_reset_at}`;
    const text = detectedEarly
      ? `${label} ${windowLabel} 사용량 초기화가 예정 시각보다 먼저 감지되었습니다.`
      : `${label} ${windowLabel} 사용량이 초기화되었습니다.`;
    await this.notifications.notify(eventId, "usage_session_reset", text);
    this.realtime.broadcast("usage_session_reset", { provider: schedule.provider, label, windowId: schedule.window_id, windowLabel, detectedEarly });
  }
}
