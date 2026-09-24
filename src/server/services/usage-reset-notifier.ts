import type { AppDatabase } from "../core/database";
import type { ProviderAdapter } from "../providers/provider";
import type { Provider, UsageWindow } from "../../shared/types";
import type { RealtimeHub } from "./realtime";
import type { NotificationPresentation, Notifier } from "./notifier";
import { todayResetTime } from "../providers/usage-utils";
import { zonedTimeToUtc } from "./rate-limit-resume";

const SAME_RESET_TOLERANCE_MS = 15 * 60_000;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

interface ResetScheduleRow {
  provider: Provider;
  account_id: number;
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
  // Direct API/RPC collectors normalize absolute reset timestamps to ISO 8601. These must not be
  // reduced to a clock-only value, otherwise a weekly reset can be mistaken for today's reset.
  if (/^\d{4}-\d{2}-\d{2}T/i.test(resetAt)) {
    const absolute = new Date(resetAt);
    if (!Number.isNaN(absolute.getTime())) return absolute;
  }
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

// 알림 중복 차단 키에 쓸 리셋 시각을 같은 창 허용 오차 단위로 내림한다. CLI가 같은 창의 리셋
// 시각을 몇 분씩 다르게 표기하는 게 실측됐는데(#56: "12:34 on 27 Aug"↔"12:43 on 27 Aug"), 분 단위
// 원본을 그대로 키에 쓰면 같은 창인데도 다른 이벤트가 되어 notifier의 중복 차단이 뚫린다.
export function resetEventKey(scheduledResetAt: string): string {
  const time = new Date(scheduledResetAt).getTime();
  if (Number.isNaN(time)) return scheduledResetAt;
  return new Date(Math.floor(time / SAME_RESET_TOLERANCE_MS) * SAME_RESET_TOLERANCE_MS).toISOString();
}

function usageWindowLabel(adapter: ProviderAdapter | undefined, windowId: string): string {
  const configured = adapter?.usageWindowLabels?.[windowId];
  if (configured) return configured;
  if (windowId === "five_hour") return "5시간";
  if (windowId.startsWith("weekly")) return "주간";
  return "세션";
}

// 사용량 초기화는 움직이는 예정 시각이 아니라 정상 사용량 스냅샷에서 확인된 창 전환으로만 알린다.
// 공급자 CLI의 예정 시각은 몇 분씩 흔들리거나 0% 동안 현재 시각을 따라 이동할 수 있으므로, 타이머가
// 직접 알리면 실제 초기화 전 오발송과 반복 발송이 생긴다(#75 운영 재현).
export class UsageResetNotifier {
  private readonly adapters: Map<Provider, ProviderAdapter>;

  constructor(
    private readonly database: AppDatabase,
    private readonly notifications: Notifier,
    private readonly realtime: RealtimeHub,
    adapters: ProviderAdapter[],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  // 현재 정상 사용량을 기준선으로 복원한다. 발송 타이머는 두지 않고 이후 60초 사용량 조회가 실제
  // 창 전환을 확인할 때만 알린다.
  start(): void {
    const usageRows = this.database.prepare(`
      SELECT provider, account_id, details_json FROM usage_status
      WHERE data_status = 'fresh' AND details_json IS NOT NULL
    `).all() as Array<{ provider: Provider; account_id: number; details_json: string }>;
    for (const usage of usageRows) this.observe(usage.provider, usage.details_json, this.now(), usage.account_id);
  }

  stop(): void {}

  // 정상 반영된 사용량에서 대표 창 전환을 감지하고 다음 초기화 예약을 갱신한다.
  // 예약 키가 (provider, window_id)뿐이라 계정을 구분하지 못하므로, 호출부는 기본 계정 스냅샷만 넘겨야 한다.
  observe(provider: Provider, detailsJson: string | null | undefined, observedAt: Date = this.now(), accountId?: number): void {
    const adapter = this.adapters.get(provider);
    if (!adapter || !detailsJson) return;
    const resolvedAccountId = accountId ?? (this.database.prepare("SELECT id FROM agent_accounts WHERE provider = ? AND is_default = 1").get(provider) as { id: number } | undefined)?.id;
    if (!resolvedAccountId) return;
    let windows: UsageWindow[];
    try {
      windows = (JSON.parse(detailsJson) as { windows?: UsageWindow[] }).windows ?? [];
    } catch {
      return;
    }
    const targetWindowIds = adapter.usageResetWindowIds ?? [adapter.usageWindowId];
    for (const windowId of targetWindowIds) {
      const window = windows.find((item) => item.id === windowId);
      if (window) this.observeWindow(provider, resolvedAccountId, window, observedAt);
      else if (adapter.transientUsageResetWindowIds?.includes(windowId)) this.observeMissingWindow(provider, resolvedAccountId, windowId, observedAt);
      else this.forgetWindow(provider, resolvedAccountId, windowId);
    }
  }

  // Claude session처럼 초기화 직후 첫 대화 전까지 통째로 사라지는 창은, 이전 양수 사용량의
  // 예약 경계를 지난 누락 자체가 새 창의 0%와 같은 증거다. 사용률을 0으로 원자 선점해 매분
  // 누락과 이후 0% 재등장이 같은 초기화를 중복 발송하지 못하게 한다.
  private observeMissingWindow(provider: Provider, accountId: number, windowId: string, observedAt: Date): void {
    const previous = this.database.prepare(`
      SELECT provider, account_id, window_id, scheduled_reset_at, used_percent, notified_at
      FROM usage_reset_schedules WHERE provider = ? AND account_id = ? AND window_id = ?
    `).get(provider, accountId, windowId) as ResetScheduleRow | undefined;
    if (!previous || (previous.used_percent ?? 0) <= 0) return;
    const previousResetAt = new Date(previous.scheduled_reset_at);
    if (Number.isNaN(previousResetAt.getTime()) || observedAt.getTime() < previousResetAt.getTime()) return;

    const claimed = this.database.prepare(`
      UPDATE usage_reset_schedules
      SET used_percent = 0, notified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE provider = ? AND account_id = ? AND window_id = ?
        AND scheduled_reset_at = ? AND used_percent > 0
    `).run(provider, accountId, windowId, previous.scheduled_reset_at);
    if (claimed.changes > 0) void this.notify(previous, false);
  }

  // 공급자가 더 이상 내리지 않는 창은 예전 예약으로 알리지 않는다. Codex 5시간 창처럼 정책에 따라
  // 나타났다 사라질 수 있는 창은, 사라진 순간 주간 창으로 폴백하고 타이머도 함께 없애야 한다.
  private forgetWindow(provider: Provider, accountId: number, windowId: string): void {
    this.database.prepare("DELETE FROM usage_reset_schedules WHERE provider = ? AND account_id = ? AND window_id = ?").run(provider, accountId, windowId);
  }

  // 사용량 창 하나의 전환 여부와 다음 예약을 독립적으로 갱신한다.
  private observeWindow(provider: Provider, accountId: number, window: UsageWindow, observedAt: Date): void {
    const resetAt = parseUsageResetMoment(window.resetAt, observedAt);
    if (!resetAt) return;
    const previous = this.database.prepare(`
      SELECT provider, account_id, window_id, scheduled_reset_at, used_percent, notified_at
      FROM usage_reset_schedules WHERE provider = ? AND account_id = ? AND window_id = ?
    `).get(provider, accountId, window.id) as ResetScheduleRow | undefined;
    if (!previous) {
      this.database.prepare(`
        INSERT INTO usage_reset_schedules(provider, account_id, window_id, scheduled_reset_at, used_percent, notified_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
      `).run(provider, accountId, window.id, resetAt.toISOString(), window.usedPercent);
      return;
    }
    const previousResetAt = new Date(previous.scheduled_reset_at);
    const difference = resetAt.getTime() - previousResetAt.getTime();
    // 리셋 시각이 허용 오차 밖으로 후퇴하면 CLI가 옛 스냅샷을 돌려준 것으로 본다(#52와 같은 뿌리).
    // 그 값을 예약에 저장하면 다음 조회의 최신 값이 다시 "새 창 전환"으로 보여 초기화 알림이 한 번
    // 더 나간다 — 실측 #56: Codex 주간 초기화 순간 27 Aug ↔ 29 Aug가 교차해 알림이 2회 발송됐다.
    // 예약을 그대로 두면 되돌아온 최신 값이 같은 창(오차 이내)으로 처리돼 중복이 사라진다.
    if (difference < -SAME_RESET_TOLERANCE_MS) return;

    const previousUsed = previous.used_percent;
    const resetAdvanced = difference > SAME_RESET_TOLERANCE_MS;
    const usageDropped = previousUsed !== null && window.usedPercent !== null && window.usedPercent < previousUsed;
    const scheduledBoundaryReached = observedAt.getTime() >= previousResetAt.getTime();
    // 다음 리셋 시각이 충분히 전진했고 직전 창에 실제 사용량이 있었으며, 사용률 하락 또는 예정 경계
    // 통과라는 추가 증거가 있을 때만 새 창으로 확정한다. 직전 값이 이미 0%면 13:50→13:51처럼
    // 계속 움직여도 같은 빈 창이므로 절대 새 초기화로 다시 열지 않는다.
    const resetConfirmed = window.usedPercent !== null && resetAdvanced && (previousUsed ?? 0) > 0 && (usageDropped || scheduledBoundaryReached);
    if (resetConfirmed) {
      const claimed = this.database.prepare(`
        UPDATE usage_reset_schedules
        SET scheduled_reset_at = ?, used_percent = ?, notified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE provider = ? AND account_id = ? AND window_id = ? AND scheduled_reset_at = ?
      `).run(resetAt.toISOString(), window.usedPercent, provider, accountId, window.id, previous.scheduled_reset_at);
      if (claimed.changes > 0) void this.notify(previous, observedAt < previousResetAt);
      return;
    }

    // 같은 창 안의 최신 관측은 시각과 사용률을 함께 갱신한다. 타이머가 없으므로 이 값이 조금
    // 움직여도 알림을 만들지 않으며, 0% 구간의 미끄러짐도 다음 양수 관측까지 한 에피소드로 남는다.
    this.database.prepare(`
      UPDATE usage_reset_schedules SET scheduled_reset_at = ?, used_percent = ?, updated_at = CURRENT_TIMESTAMP
      WHERE provider = ? AND account_id = ? AND window_id = ?
    `).run(resetAt.toISOString(), window.usedPercent, provider, accountId, window.id);
  }

  // DB 상태 전환을 먼저 선점한 호출만 외부 채널과 브라우저에 같은 제목·본문을 보낸다.
  private async notify(schedule: ResetScheduleRow, detectedEarly: boolean): Promise<void> {
    const adapter = this.adapters.get(schedule.provider);
    const label = adapter?.displayLabel ?? schedule.provider;
    const windowLabel = usageWindowLabel(adapter, schedule.window_id);
    const title = `${label} ${windowLabel} 사용량 초기화`;
    const body = `${label} ${windowLabel} 사용량 초기화가 확인되었습니다.`;
    const eventId = `usage-reset:${schedule.provider}:${schedule.account_id}:${schedule.window_id}:${resetEventKey(schedule.scheduled_reset_at)}`;
    const presentation: NotificationPresentation = { title };
    await this.notifications.notify(eventId, "usage_session_reset", body, presentation);
    this.realtime.broadcast("usage_session_reset", {
      provider: schedule.provider,
      accountId: schedule.account_id,
      label,
      windowId: schedule.window_id,
      windowLabel,
      detectedEarly,
      title,
      body,
    });
  }
}
