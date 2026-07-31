import type { AppDatabase } from "../core/database";
import type { Provider } from "../../shared/types";
import type { ProviderAdapter } from "../providers/provider";
import type { RealtimeHub } from "./realtime";
import type { Notifier } from "./notifier";
import type { SessionManager } from "./session-manager";

// 지정 순간이 timeZone에서 어떻게 보이는지를 기준으로, 그 순간과 UTC 사이의 오차(ms)를 구한다.
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - date.getTime();
}

// timeZone 기준 연/월/일 시:분을 실제 UTC Date로 환산한다(외부 라이브러리 없이 표준 Intl만 사용).
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(guess.getTime() - timeZoneOffsetMs(guess, timeZone));
}

const MONTH_ABBREVIATIONS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Codex가 "try again at Jul 13th, 2026 12:14 AM."처럼 시:분뿐 아니라 월·일·연도까지 찍는 형식도
// 실제로 쓰는 게 확인됐다(실사용 재현) — 아래 기존 시:분 전용 파싱은 날짜를 모르니 "오늘이거나
// 지났으면 내일"로 추측하는데, 여기서 CLI가 이미 명시한 날짜를 무시하고 잘못 추측할 수 있다. 기존
// 로직은 그대로 두고, 전체 날짜가 있으면 그 값을 그대로 신뢰하는 파싱을 추가로 먼저 시도한다.
function parseDatedResetTime(resetAt: string): Date | null {
  const match = resetAt.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
  if (!match) return null;
  const month = MONTH_ABBREVIATIONS[match[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  if (match[6].toLowerCase() === "pm" && hour < 12) hour += 12;
  if (match[6].toLowerCase() === "am" && hour === 12) hour = 0;
  const date = new Date(year, month, day, hour, minute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

// usage-monitor.ts가 CLI 화면에서 그대로 뽑아온 "5:39pm (Asia/Seoul)" 또는 "16:45" 같은 리셋 문구를,
// 다음으로 돌아오는 실제 시각으로 해석한다. 시:분만 있고 날짜가 없으므로 이미 지난 시각이면 내일로
// 본다. 타임존이 명시되지 않으면 서버가 도는 로컬 시간대를 그대로 쓴다. 파싱할 수 없으면 null.
export function parseResetTime(resetAt: string | null | undefined, now: Date): Date | null {
  if (!resetAt) return null;
  const dated = parseDatedResetTime(resetAt);
  if (dated) return dated;
  const timeMatch = resetAt.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const timeZone = resetAt.match(/\(([A-Za-z]+\/[A-Za-z_]+)\)/)?.[1];
  if (!timeZone) {
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate < now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }
  const todayParts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string): number => Number(todayParts.find((part) => part.type === type)?.value ?? 0);
  const today = zonedTimeToUtc(get("year"), get("month"), get("day"), hour, minute, timeZone);
  if (today >= now) return today;
  return zonedTimeToUtc(get("year"), get("month"), get("day") + 1, hour, minute, timeZone);
}

// 사용량이 이 퍼센트 이상 남아 있으면 이미 회복된 것으로 본다. reset_at은 "현재 창의 다음 예정
// 리셋"일 뿐이라, 대기가 시작된 뒤 그 창이 자연 롤링 리셋되고 새 창(다음 reset_at)이 이미 시작된
// 경우를 놓친다 — 실제로는 이미 여유가 생겼는데도 "예정 시각이 아직 안 지났다"며 계속 대기하게 된다.
const RECOVERY_REMAINING_PERCENT = 10;

// 예정된 리셋 시각이 지났거나, 이미 사용량이 회복됐으면(위 상수 참고) 재개 대상으로 본다.
export function isRateLimitRecovered(resetAt: string | null | undefined, remainingPercent: number | null | undefined, now: Date): boolean {
  const parsed = parseResetTime(resetAt, now);
  const timeReached = !!parsed && parsed <= now;
  const recovered = remainingPercent != null && remainingPercent >= RECOVERY_REMAINING_PERCENT;
  return timeReached || recovered;
}

// rate_limit_options 화면에서 "재설정까지 대기"를 자동 선택해둔 채팅들을, 실제 사용량이 회복되면
// "계속"을 보내 이어가게 한다. usage-monitor.ts가 60초마다 갱신하는 usage_status를 그대로 폴링
// 기준으로 쓴다 — 별도의 예약 타이머를 두지 않아 서버가 재시작돼도 다음 폴링에서 그대로 이어서
// 판단된다.
export class RateLimitResumeService {
  private timer?: NodeJS.Timeout;
  private readonly adapters: Map<Provider, ProviderAdapter>;

  constructor(
    private readonly database: AppDatabase,
    private readonly sessions: SessionManager,
    private readonly notifications: Notifier,
    private readonly realtime: RealtimeHub,
    adapters: ProviderAdapter[],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const waits = this.database.prepare("SELECT chat_id AS chatId, provider, resume_after AS resumeAfter FROM rate_limit_waits").all() as { chatId: number; provider: Provider; resumeAfter: string | null }[];
    if (!waits.length) return;
    const usageRows = this.database.prepare("SELECT provider, reset_at AS resetAt, remaining_percent AS remainingPercent FROM usage_status").all() as { provider: Provider; resetAt: string | null; remainingPercent: number | null }[];
    const usageByProvider = new Map(usageRows.map((row) => [row.provider, row]));
    const now = new Date();
    for (const wait of waits) {
      if (!wait.resumeAfter || new Date(wait.resumeAfter) > now) continue;
      // CLI가 예고한 "재개 예정 시각"이 지나도, 그 시점에 다시 조회한 실제 사용량이 여전히 한도에
      // 걸려 있으면(=CLI의 시각 예측 자체가 부정확했던 것) 곧바로 재개하지 않는다 — 실제로 Codex가
      // "03:02"를 예고했는데 그 시각이 된 순간 다시 조회해도 remaining 0%였고, 이 검사 없이는
      // "한도 해제됐다"고 알린 뒤 곧바로 다시 한도에 걸리는 일이 반복됐다. usage_status의 최신
      // reset_at으로 대기 시각을 다시 맞춰 다음 폴링(60초 뒤)에 재시도한다.
      const usage = usageByProvider.get(wait.provider);
      if (usage && !isRateLimitRecovered(usage.resetAt, usage.remainingPercent, now)) {
        const nextResumeAfter = parseResetTime(usage.resetAt, now);
        if (nextResumeAfter && nextResumeAfter.toISOString() !== wait.resumeAfter) {
          this.database.prepare("UPDATE rate_limit_waits SET resume_after = ? WHERE chat_id = ?").run(nextResumeAfter.toISOString(), wait.chatId);
        }
        continue;
      }
      if (await this.resumeChat(wait.chatId)) void this.notifyReset(wait.provider, new Date(wait.resumeAfter));
    }
    for (const usage of usageRows) {
      const affected = waits.filter((wait) => wait.provider === usage.provider && !(wait.resumeAfter && new Date(wait.resumeAfter) <= now));
      if (!affected.length) continue;
      if (!isRateLimitRecovered(usage.resetAt, usage.remainingPercent, now)) continue;
      let resumed = false;
      for (const wait of affected) resumed = await this.resumeChat(wait.chatId) || resumed;
      if (resumed) void this.notifyReset(usage.provider, parseResetTime(usage.resetAt, now) ?? now);
    }
  }

  // 대기 목록을 정리하고, 종료·오류·busy 상태가 아닌 실제 실행 중 터미널에만 "계속"을 보낸다.
  private async resumeChat(chatId: number): Promise<boolean> {
    this.database.prepare("DELETE FROM rate_limit_waits WHERE chat_id = ?").run(chatId);
    return this.sessions.sendPromptIfRunning(chatId, "계속", null).catch(() => false);
  }

  // 공급자당 한 번만(알림 채널들은 이벤트 ID로, 웹은 rate_limit_waits가 비면 다음 tick에 대상이 없어져
  // 자연히) 리셋 알림을 보낸다.
  private async notifyReset(provider: Provider, resetAt: Date): Promise<void> {
    const label = this.adapters.get(provider)?.displayLabel ?? provider;
    await this.notifications.notify(
      `rate-limit-reset:${provider}:${resetAt.toISOString()}`,
      "rate_limit_reset",
      `${label} 사용량 한도가 초기화되어, 대기 중이던 작업을 이어갑니다.`,
    );
    this.realtime.broadcast("rate_limit_reset", { provider });
  }
}
