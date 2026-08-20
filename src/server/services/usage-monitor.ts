import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { AppDatabase } from "../core/database";
import type { ModelOptions, ProviderAdapter } from "../providers/provider";
import type { AgentAccountRecord, Provider, UsageRecord, UsageWindow } from "../../shared/types";
import type { RealtimeHub } from "./realtime";
import type { AgentAccountService } from "./agent-accounts";
import { TerminalScreen } from "./terminal-screen";
import { todayResetTime } from "../providers/usage-utils";
import { createLogger } from "../core/logger";
import type { UsageResetNotifier } from "./usage-reset-notifier";
import { parseUsageResetMoment } from "./usage-reset-notifier";
import { consumeCodexResetCredit, readCodexResetCredits, type CodexResetCredits, type CodexResetCreditConsumeResult } from "../providers/codex-rate-limits";
import { USAGE_KEEPALIVE_COOLDOWN_MS, USAGE_KEEPALIVE_PROMPT } from "../../shared/usage-keepalive";

const usageLog = createLogger("usage-check");

// Claude 5시간 세션 창이 리셋 시각을 지난 직후, 실제 대화 없이 상태 조회 전용 PTY만 조용히 /usage를
// 반복 조회하면 "Current session" 블록이 사라지는 게 아니라 리셋 전 마지막 스냅샷을 그대로 계속
// 돌려준다(실측: 화면 자체엔 여전히 session 항목이 있지만 숫자·리셋 시각이 갱신 안 됨). 기존
// isExpiredResetTime 판정이 이걸 "stale"로는 잡아내지만, stale이어도 그 오래된 숫자를 그대로 화면에
// 남겨둬 사실상 안 바뀌는 것처럼 보인다 — 리셋 시각이 지금부터 2분 이상 지났으면 이미 리셋됐다고
// 보고 0% 사용·5시간 뒤 재리셋으로 직접 채워 넣는다(2분 여유는 CLI의 반영 지연을 감안한 것).
const SESSION_RESET_GRACE_MS = 2 * 60_000;
const SESSION_WINDOW_HOURS = 5;
const USAGE_DETAILS_INTERVAL_MS = 24 * 60 * 60_000;

// 마지막 상세 조회 시각을 기준으로 하루 주기의 다음 조회가 필요한지 판정한다.
export function isUsageDetailsDue(lastCheckedAt: number | undefined, now: number): boolean {
  return lastCheckedAt === undefined || now - lastCheckedAt >= USAGE_DETAILS_INTERVAL_MS;
}

function parseWindows(detailsJson: string | null | undefined): UsageWindow[] {
  if (!detailsJson) return [];
  try {
    return (JSON.parse(detailsJson) as { windows?: UsageWindow[] }).windows ?? [];
  } catch {
    return [];
  }
}

// 사용량 상세 JSON에서 유효한 Codex 초기화권 요약만 꺼낸다.
function storedCodexResetCredits(details: Record<string, unknown>): CodexResetCredits | null {
  const value = details.rateLimitResetCredits;
  if (!value || typeof value !== "object") return null;
  const credits = value as Partial<CodexResetCredits>;
  if (!Number.isInteger(credits.availableCount) || Number(credits.availableCount) < 0) return null;
  return { availableCount: Number(credits.availableCount), expiresAt: typeof credits.expiresAt === "string" ? credits.expiresAt : null };
}

// TUI·app-server의 새 값과 직전 캐시를 합치되 같은 개수의 정상 기한은 보존한다.
export function mergeCodexResetCredits(detailsJson: string | null | undefined, credits: CodexResetCredits | null, previousDetailsJson?: string | null): string | null {
  if (!detailsJson) return detailsJson ?? null;
  try {
    const details = JSON.parse(detailsJson) as Record<string, unknown>;
    const screenCredits = storedCodexResetCredits(details);
    let previousCredits: CodexResetCredits | null = null;
    if (previousDetailsJson) {
      try {
        previousCredits = storedCodexResetCredits(JSON.parse(previousDetailsJson) as Record<string, unknown>);
      } catch {
        previousCredits = null;
      }
    }
    let resetCredits = credits ?? screenCredits ?? previousCredits;
    if (resetCredits && !resetCredits.expiresAt) {
      const dated = [screenCredits, previousCredits].find((candidate): candidate is CodexResetCredits & { expiresAt: string } => (
        !!candidate && candidate.availableCount === resetCredits?.availableCount && !!candidate.expiresAt
      ));
      if (dated) resetCredits = { ...resetCredits, expiresAt: dated.expiresAt };
    }
    return JSON.stringify(resetCredits ? { ...details, rateLimitResetCredits: resetCredits } : details);
  } catch {
    return detailsJson;
  }
}

// "7:50am (Asia/Seoul)" 형식으로, now 기준 새 리셋 시각을 같은 타임존 표기로 되돌린다.
function formatResetLike(sample: string, resetAt: Date): string {
  const timeZone = sample.match(/\(([A-Za-z]+\/[A-Za-z_]+)\)/)?.[1];
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(resetAt);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase()}`;
  return timeZone ? `${time} (${timeZone})` : time;
}

// 세션 창은 최대 5시간짜리 롤링 윈도우라, 정말 최신 값이면 리셋 시각이 지금부터 5시간(+30분 여유)
// 이내여야 한다. 상태 조회 전용 PTY가 간헐적으로 완전히 동떨어진(몇 시간 더 먼) 리셋 시각의 옛
// 화면을 새 값인 척 그대로 돌려주는 게 실측됐다(실사용 재현: 실제로는 39%·47분 뒤 리셋인데 8초
// 뒤 같은 조회에서 갑자기 0%·리셋 시각이 사실상 8시간 넘게 남은 값으로 나옴 — 원본 파싱 단계부터
// 이미 이런 값이 나와 reconcileStaleClaudeSessionWindow가 손대기도 전 문제임). 이런 값은 최신으로
// 반영하지 않고 stale로만 남겨 마지막 정상값을 지킨다.
const SESSION_RESET_PLAUSIBLE_MAX_MS = (SESSION_WINDOW_HOURS + 0.5) * 60 * 60_000;

export function isImplausibleClaudeSessionReset(detailsJson: string | null | undefined, now: Date): boolean {
  const windows = parseWindows(detailsJson);
  const session = windows.find((window) => window.id === "session");
  if (!session?.resetAt) return false;
  const today = todayResetTime(session.resetAt, now);
  if (!today) return false;
  const next = today.getTime() >= now.getTime() ? today : new Date(today.getTime() + 24 * 60 * 60_000);
  return next.getTime() - now.getTime() > SESSION_RESET_PLAUSIBLE_MAX_MS;
}

export function reconcileStaleClaudeSessionWindow(parsed: Partial<UsageRecord>, now: Date): Partial<UsageRecord> {
  if (parsed.data_status === "unavailable") return parsed;
  const windows = parseWindows(parsed.details_json);
  const sessionIndex = windows.findIndex((window) => window.id === "session");
  const session = windows[sessionIndex];
  if (!session?.resetAt) return parsed;
  const expiredAt = todayResetTime(session.resetAt, now);
  if (!expiredAt || now.getTime() - expiredAt.getTime() < SESSION_RESET_GRACE_MS) return parsed;
  // todayResetTime은 자정을 넘어가는 이른 새벽 시각(예: "12:40am")도 "오늘 자정 직후"로 계산한다 —
  // 지금이 저녁이면 이게 이미 몇 시간~반나절 전에 지난 시각으로 잡혀, 실제로는 오늘 밤 자정을 넘겨
  // 몇 시간 안에 돌아올 미래 시각인데도 "훨씬 전에 지난 옛 스냅샷"으로 오판해 방금 받은 진짜 최신
  // 값(예: 47% 사용, 자정 직후 리셋)을 0%로 덮어썼다(실사용 재현·확인). 진짜 "리셋 지난 지 오래된"
  // 경우라면 그 시각을 24시간 롤포워드했을 때 5시간 롤링 윈도우보다 훨씬 더 멀리 있어야 정상이니,
  // 롤포워드해도 윈도우 안에 들어오면(=자정을 넘겨 해석해야 하는 근미래 시각이면) 보정하지 않는다.
  const rolledForward = new Date(expiredAt.getTime() + 24 * 60 * 60_000);
  if (rolledForward.getTime() - now.getTime() <= SESSION_WINDOW_HOURS * 60 * 60_000) return parsed;
  const nextReset = new Date(expiredAt.getTime() + SESSION_WINDOW_HOURS * 60 * 60_000);
  const freshSession: UsageWindow = { id: "session", label: session.label, usedPercent: 0, remainingPercent: 100, resetAt: formatResetLike(session.resetAt, nextReset) };
  const nextWindows = [...windows];
  nextWindows[sessionIndex] = freshSession;
  const isPrimary = windows[0]?.id === "session";
  return {
    ...parsed,
    data_status: "fresh",
    used_percent: isPrimary ? freshSession.usedPercent : parsed.used_percent,
    remaining_percent: isPrimary ? freshSession.remainingPercent : parsed.remaining_percent,
    reset_at: isPrimary ? freshSession.resetAt : parsed.reset_at,
    summary: nextWindows.map((window) => `${window.label}: ${window.usedPercent}% used`).join("\n"),
    details_json: JSON.stringify({ windows: nextWindows, activity: [] }),
  };
}

export type UsageKeepaliveReason = "claude_session_missing" | "claude_session_zero" | "codex_reset_zero";

export interface UsageKeepaliveTrigger {
  reason: UsageKeepaliveReason;
  windowKey: string | null;
}

interface UsageKeepaliveWindowPart {
  id: string;
  resetAt: string | null;
}

const KEEPALIVE_RESET_TOLERANCE_MS = 15 * 60_000;

// 이미 절대시각인 내부 보정값은 다시 시:분 문구로 해석하지 않고 그대로 사용한다.
function usageKeepaliveResetAt(resetAt: string | null | undefined, now: Date): string | null {
  if (!resetAt) return null;
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(resetAt) ? new Date(resetAt) : null;
  const parsed = iso && !Number.isNaN(iso.getTime()) ? iso : parseUsageResetMoment(resetAt, now);
  return parsed?.toISOString() ?? resetAt;
}

// 사용량 창 목록을 시각 표기 차이에 강한 DB 저장용 키로 직렬화한다.
function usageKeepaliveWindowKey(windows: UsageWindow[], now: Date): string | null {
  if (!windows.length) return null;
  const parts = windows.map((window): UsageKeepaliveWindowPart => ({
    id: window.id,
    resetAt: usageKeepaliveResetAt(window.resetAt, now),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify(parts);
}

// Claude 세션이 화면에서 사라졌으면 직전 리셋을 5시간씩 넘겨 현재 창의 다음 리셋을 복원한다.
function missingClaudeSessionWindow(previousDetailsJson: string | null | undefined, now: Date): UsageWindow[] {
  const previousSession = parseWindows(previousDetailsJson).find((window) => window.id === "session");
  if (!previousSession?.resetAt) return [];
  const parsedReset = parseUsageResetMoment(previousSession.resetAt, now);
  if (!parsedReset) return [previousSession];
  const resetAt = new Date(parsedReset.getTime());
  while (resetAt.getTime() <= now.getTime()) resetAt.setTime(resetAt.getTime() + SESSION_WINDOW_HOURS * 60 * 60_000);
  return [{ ...previousSession, resetAt: resetAt.toISOString() }];
}

// 현재 정상 스냅샷에서 최소 단답 사유와 중복 판정용 초기화 창을 함께 계산한다.
export function detectUsageKeepaliveTrigger(provider: Provider, previousDetailsJson: string | null | undefined, parsedDetailsJson: string | null | undefined, now: Date = new Date()): UsageKeepaliveTrigger | null {
  const current = parseWindows(parsedDetailsJson);
  if (!current.length) return null;
  if (provider === "claude") {
    const session = current.find((window) => window.id === "session");
    if (!session) return {
      reason: "claude_session_missing",
      windowKey: usageKeepaliveWindowKey(missingClaudeSessionWindow(previousDetailsJson, now), now),
    };
    return session.usedPercent === 0
      ? { reason: "claude_session_zero", windowKey: usageKeepaliveWindowKey([session], now) }
      : null;
  }
  const previous = parseWindows(previousDetailsJson);
  const resetWindows = current.filter((window) => window.usedPercent === 0 && (previous.find((item) => item.id === window.id)?.usedPercent ?? 0) > 0);
  return resetWindows.length
    ? { reason: "codex_reset_zero", windowKey: usageKeepaliveWindowKey(resetWindows, now) }
    : null;
}

// 사용량 창이 실제 최소 턴으로 활성화되어야 하는 상태 전환인지 판정한다.
export function detectUsageKeepaliveReason(provider: Provider, previousDetailsJson: string | null | undefined, parsedDetailsJson: string | null | undefined): UsageKeepaliveReason | null {
  return detectUsageKeepaliveTrigger(provider, previousDetailsJson, parsedDetailsJson)?.reason ?? null;
}

// 직렬화된 창 키가 같은 초기화 창인지 15분 이내 시각 표기 오차를 허용해 비교한다.
export function isSameUsageKeepaliveWindow(previousKey: string | null | undefined, currentKey: string | null | undefined): boolean {
  if (!previousKey || !currentKey) return false;
  if (previousKey === currentKey) return true;
  try {
    const previous = JSON.parse(previousKey) as UsageKeepaliveWindowPart[];
    const current = JSON.parse(currentKey) as UsageKeepaliveWindowPart[];
    if (previous.length !== current.length) return false;
    return previous.every((part, index) => {
      const candidate = current[index];
      if (!candidate || part.id !== candidate.id) return false;
      const previousReset = new Date(part.resetAt ?? "").getTime();
      const currentReset = new Date(candidate.resetAt ?? "").getTime();
      if (Number.isNaN(previousReset) || Number.isNaN(currentReset)) return part.resetAt === candidate.resetAt;
      return Math.abs(previousReset - currentReset) <= KEEPALIVE_RESET_TOLERANCE_MS;
    });
  } catch {
    return false;
  }
}

// 창 키가 있으면 새 초기화 창인지 비교하고, 식별 불가 상태에서만 기존 5시간 제한을 사용한다.
export function isUsageKeepaliveDue(lastSentAt: string | null | undefined, previousWindowKey: string | null | undefined, currentWindowKey: string | null | undefined, now: Date): boolean {
  if (!lastSentAt) return true;
  if (currentWindowKey) return !isSameUsageKeepaliveWindow(previousWindowKey, currentWindowKey);
  const sentAt = new Date(lastSentAt).getTime();
  return Number.isNaN(sentAt) || now.getTime() - sentAt >= USAGE_KEEPALIVE_COOLDOWN_MS;
}

// 창 키 도입 전 전송 시각이 현재 Claude 5시간 창 안이면 같은 창의 기존 기록으로 승계한다.
function isLegacyKeepaliveFromCurrentWindow(lastSentAt: string, currentWindowKey: string): boolean {
  try {
    const parts = JSON.parse(currentWindowKey) as UsageKeepaliveWindowPart[];
    if (parts.length !== 1 || parts[0].id !== "session" || !parts[0].resetAt) return false;
    const sentAt = new Date(lastSentAt).getTime();
    const resetAt = new Date(parts[0].resetAt).getTime();
    if (Number.isNaN(sentAt) || Number.isNaN(resetAt)) return false;
    const startedAt = resetAt - SESSION_WINDOW_HOURS * 60 * 60_000;
    return sentAt >= startedAt - KEEPALIVE_RESET_TOLERANCE_MS && sentAt < resetAt;
  } catch {
    return false;
  }
}

interface MonitorState {
  adapter: ProviderAdapter;
  // 이 조회 PTY가 어느 계정 슬롯의 한도를 보는지. 계정마다 설정 디렉터리가 달라 한도도 따로 계산된다.
  account: AgentAccountRecord;
  terminal?: IPty;
  screen: TerminalScreen;
  busy: boolean;
  modelOptions?: ModelOptions;
  timer?: NodeJS.Timeout;
  parseTimer?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  commandIndex: number;
  failureCount: number;
  // 마지막 정상 반영 이후 연속으로 거부된 조회 횟수(shouldAdoptRejectedUsage 참고).
  rejectedStreak: number;
  collectUsageDetails: boolean;
  usageDetailsCheckedAt?: number;
  // 파싱에 실제로 넘긴 원본 화면 텍스트를 매 조회마다 남겨, 파싱이 왜 실패·이상하게 됐는지 웹에서
  // 직접 확인할 수 있게 한다("숫자만 보지 말고 실제 CLI 화면을 보고 싶다"는 실사용 요청으로 추가함).
  lastSnapshot?: { text: string; capturedAt: string };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 공급자와 계정 슬롯을 합쳐 조회 대상을 유일하게 식별한다.
function monitorKey(provider: Provider, accountId: number): string {
  return `${provider}:${accountId}`;
}

// 리셋 문구에서 날짜 부분("Jul 11")과 하루 기준 분 단위 시각을 뽑아 창 식별에 쓴다.
function resetTimeParts(resetAt: string): { dateText: string | null; minutesOfDay: number | null } {
  const dateText = resetAt.match(/\b([A-Za-z]{3}\s+\d{1,2}|\d{1,2}\s+[A-Za-z]{3})\b/)?.[1] ?? null;
  const time = resetAt.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ?? resetAt.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!time) return { dateText, minutesOfDay: null };
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  const meridiem = time[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { dateText, minutesOfDay: null };
  return { dateText, minutesOfDay: hour * 60 + minute };
}

// 두 리셋 문구가 같은 사용량 창을 가리키는지 판정한다. CLI가 같은 창의 리셋 시각을 조회 시점에
// 따라 1분씩 다르게 보여주는 게 실측됐다("2:09pm"↔"2:10pm", "12:59am"↔"1am") — 문자열 완전 일치로
// 비교하면 옛 스냅샷이 1분 다른 표기로 올 때 "다른 창"으로 오판해 후퇴 감지를 통과시킨다.
// 날짜 부분이 같고(둘 다 없어도 같음) 시각 차이가 몇 분 이내면 같은 창으로 본다. 실제 창 전환은
// 세션 5시간·주간 7일 단위라 몇 분 오차와는 확실히 구분된다.
const SAME_WINDOW_TOLERANCE_MINUTES = 15;
function isSameResetWindow(a: string, b: string): boolean {
  if (a === b) return true;
  const partsA = resetTimeParts(a);
  const partsB = resetTimeParts(b);
  if (partsA.dateText !== partsB.dateText) return false;
  if (partsA.minutesOfDay === null || partsB.minutesOfDay === null) return false;
  const raw = Math.abs(partsA.minutesOfDay - partsB.minutesOfDay);
  return Math.min(raw, 1440 - raw) <= SAME_WINDOW_TOLERANCE_MINUTES;
}

// 새로 파싱한 사용량이 직전 저장값보다 "같은 창인데 줄어든" 구간이 있는지 확인한다.
// 사용량 창은 리셋 시각이 지나기 전까지 누적만 되므로, 같은 창에서 퍼센트가 줄었다면 조회 전용
// CLI가 오래된 스냅샷을 돌려준 것이다(실측: 실제 56% 시점에 1시간 전 값 26%를 최신인 척 반환,
// 리셋 시각이 아직 미래라 isExpiredResetTime로는 못 잡음). 리셋 시각이 실질적으로 달라졌으면
// (몇 분 표기 오차 초과 — isSameResetWindow 참고) 창이 넘어간 것이므로 감소를 정상으로 본다.
export function detectUsageRegression(previousDetailsJson: string | null, parsedDetailsJson: string | null | undefined): boolean {
  if (!previousDetailsJson || !parsedDetailsJson) return false;
  let previous: UsageWindow[];
  let parsed: UsageWindow[];
  try {
    previous = (JSON.parse(previousDetailsJson) as { windows?: UsageWindow[] }).windows ?? [];
    parsed = (JSON.parse(parsedDetailsJson) as { windows?: UsageWindow[] }).windows ?? [];
  } catch {
    return false;
  }
  return parsed.some((window) => {
    if (window.usedPercent === null) return false;
    const before = previous.find((item) => item.id === window.id);
    return !!before && before.usedPercent !== null && !!window.resetAt && !!before.resetAt && isSameResetWindow(window.resetAt, before.resetAt) && window.usedPercent < before.usedPercent;
  });
}

// 조회 주기가 60초이므로 약 5분에 해당한다. 옛 스냅샷 오염은 보통 한두 주기면 사라지는 반면,
// 이 횟수만큼 같은 판정이 이어지면 CLI가 계속 그 값을 주고 있다는 뜻이라 실제 최신값으로 본다.
const REJECTED_ADOPT_STREAK = 5;

// 거부가 연속으로 이어질 때 마지막 정상값 보호를 풀고 최신값을 그대로 채택할지 판단한다.
// 거부 처리는 마지막 정상값을 무기한 지키기 때문에 탈출구가 없으면 그대로 굳는다(실측: 이미 지난
// 리셋 시각의 100%가 27분간 유지돼 사용자가 사용량이 갱신되지 않는다고 보고함). 오염값을 잘못
// 채택해도 다음 주기에 진짜 값이 증가 방향으로 들어와 자동 복구되지만, 갇힘은 스스로 풀리지
// 않는다는 비대칭 때문에 일정 횟수 뒤에는 최신값을 택한다.
export function shouldAdoptRejectedUsage(rejectedStreak: number): boolean {
  return rejectedStreak >= REJECTED_ADOPT_STREAK;
}

// 공급자별 경량 전용 PTY에서 실제 슬래시 명령을 1분마다 실행한다.
export class UsageMonitor {
  // 계정마다 조회 PTY가 하나씩이라 "공급자:계정ID"를 키로 쓴다.
  private readonly monitors = new Map<string, MonitorState>();
  private readonly adapters: ProviderAdapter[];
  private readonly resetCreditRedemptions = new Set<string>();
  private stopping = false;

  constructor(
    private readonly database: AppDatabase,
    adapters: ProviderAdapter[],
    private readonly realtime: RealtimeHub,
    private readonly accounts: AgentAccountService,
    private readonly resetNotifier?: UsageResetNotifier,
  ) {
    this.adapters = adapters;
  }

  // 설정된 범위(기본 계정만 / 전 계정)에 맞는 조회 대상을 만든다.
  private buildMonitors(): void {
    for (const adapter of this.adapters) {
      for (const account of this.accounts.monitorTargets(adapter.id)) {
        const key = monitorKey(adapter.id, account.id);
        if (this.monitors.has(key)) continue;
        this.monitors.set(key, { adapter, account, screen: new TerminalScreen(), busy: false, commandIndex: 0, failureCount: 0, rejectedStreak: 0, collectUsageDetails: false });
      }
    }
  }

  // 조회 대상 계정의 상태 조회 PTY를 시작한다.
  start(): void {
    this.stopping = false;
    this.buildMonitors();
    for (const monitor of this.monitors.values()) if (!monitor.terminal) this.startProvider(monitor);
  }

  // 사용량 조회 범위 설정이 바뀌면 대상 목록을 다시 계산해, 빠진 계정의 PTY는 정리하고 새 계정은 띄운다.
  applyScopeChange(): void {
    const wanted = new Set<string>();
    for (const adapter of this.adapters) {
      for (const account of this.accounts.monitorTargets(adapter.id)) wanted.add(monitorKey(adapter.id, account.id));
    }
    for (const [key, monitor] of [...this.monitors]) {
      if (wanted.has(key)) continue;
      this.disposeMonitor(monitor);
      this.monitors.delete(key);
      this.database.prepare("DELETE FROM usage_status WHERE provider = ? AND account_id = ?").run(monitor.adapter.id, monitor.account.id);
    }
    this.start();
    this.realtime.broadcast("usage_updated", { provider: null });
  }

  // 한 모니터의 PTY와 예약 작업을 정리한다.
  private disposeMonitor(monitor: MonitorState): void {
    if (monitor.timer) clearInterval(monitor.timer);
    if (monitor.parseTimer) clearTimeout(monitor.parseTimer);
    if (monitor.retryTimer) clearTimeout(monitor.retryTimer);
    monitor.terminal?.kill();
    monitor.terminal = undefined;
    monitor.screen.dispose();
  }

  // 모든 상태 조회 PTY와 예약 작업을 종료한다.
  stop(): void {
    this.stopping = true;
    for (const monitor of this.monitors.values()) {
      this.disposeMonitor(monitor);
      this.update(monitor, { monitor_status: "stopped" });
    }
  }

  // 계정별 사용량 상태에 마지막 최소 단답 전송 기록을 합쳐 반환한다.
  list(): UsageRecord[] {
    return this.database.prepare(`
      SELECT usage_status.*, usage_keepalive_prompts.sent_at AS keepalive_sent_at,
        usage_keepalive_prompts.reason AS keepalive_reason
      FROM usage_status
      LEFT JOIN usage_keepalive_prompts USING(provider, account_id)
      ORDER BY usage_status.provider, usage_status.account_id
    `).all() as UsageRecord[];
  }

  // 가장 최근 사용량 조회 때 파서에 실제로 넘어간 원본 화면 텍스트를 반환한다(터미널 스냅샷 보기용).
  // 계정을 지정하지 않으면 그 공급자에서 조회 중인 첫 계정(보통 기본 계정) 것을 보여준다.
  snapshot(provider: Provider, accountId?: number): { text: string; capturedAt: string } | null {
    return this.findMonitor(provider, accountId)?.lastSnapshot ?? null;
  }

  // 지정 공급자의 사용량을 즉시 다시 조회한다. 계정을 지정하지 않으면 그 공급자의 모든 조회 대상을 갱신한다.
  refresh(provider: Provider, accountId?: number): void {
    const targets = accountId != null
      ? [this.findMonitor(provider, accountId)].filter((monitor): monitor is MonitorState => !!monitor)
      : [...this.monitors.values()].filter((monitor) => monitor.adapter.id === provider);
    if (!targets.length) throw new Error("지원하지 않는 공급자입니다.");
    for (const monitor of targets) this.requestUsage(monitor);
  }

  // 저장값과 공식 app-server를 모두 확인한 뒤 Codex 초기화권 맨 위 항목 하나를 사용한다.
  async redeemResetCredit(provider: Provider, accountId?: number): Promise<CodexResetCreditConsumeResult> {
    if (provider !== "codex") throw new Error("Codex만 초기화권 사용을 지원합니다.");
    const monitor = this.findMonitor(provider, accountId);
    if (!monitor) throw new Error("Codex 사용량 조회 계정을 찾을 수 없습니다.");
    const key = monitorKey(provider, monitor.account.id);
    if (this.resetCreditRedemptions.has(key)) throw new Error("Codex 초기화권을 이미 사용 중입니다.");
    const row = this.database.prepare("SELECT details_json FROM usage_status WHERE provider = ? AND account_id = ?")
      .get(provider, monitor.account.id) as { details_json: string | null } | undefined;
    let stored: CodexResetCredits | null = null;
    try {
      stored = row?.details_json ? storedCodexResetCredits(JSON.parse(row.details_json) as Record<string, unknown>) : null;
    } catch {
      stored = null;
    }
    if (!stored || stored.availableCount < 1) throw new Error("대시보드에 사용 가능한 Codex 초기화권이 없습니다.");
    this.resetCreditRedemptions.add(key);
    try {
      const result = await consumeCodexResetCredit(this.accounts.environment(monitor.account));
      if (result.outcome === "nothingToReset") throw new Error("현재 사용량은 초기화가 필요하지 않습니다.");
      if (result.outcome === "noCredit") throw new Error("사용 가능한 Codex 초기화권이 없습니다.");
      if (result.outcome !== "reset" && result.outcome !== "alreadyRedeemed") throw new Error("Codex 초기화권을 사용하지 못했습니다.");
      const current = result.after && result.after.availableCount < result.before.availableCount
        ? result.after
        : { availableCount: Math.max(0, result.before.availableCount - 1), expiresAt: null };
      const detailsJson = mergeCodexResetCredits(row?.details_json ?? JSON.stringify({ windows: [] }), current);
      const now = new Date().toISOString();
      monitor.usageDetailsCheckedAt = Date.now();
      this.update(monitor, { details_json: detailsJson, last_checked_at: now, last_success_at: now });
      this.requestUsage(monitor);
      return { ...result, after: current };
    } finally {
      this.resetCreditRedemptions.delete(key);
    }
  }

  // 공급자의 조회 대상 하나를 찾는다. 모델 목록처럼 계정과 무관한 조회는 첫 대상을 그대로 쓴다.
  private findMonitor(provider: Provider, accountId?: number): MonitorState | undefined {
    if (accountId != null) return this.monitors.get(monitorKey(provider, accountId));
    return [...this.monitors.values()].find((monitor) => monitor.adapter.id === provider);
  }

  // 실제 CLI 조회 없이, 마지막으로 캐시된 모델·effort 목록만 반환한다(채팅 화면 진입마다 부르는 용도).
  // 선택 가능한 모델은 계정이 아니라 CLI 버전에 달린 값이라 계정별로 나누지 않는다.
  cachedModelOptions(provider: Provider): ModelOptions | null {
    return this.findMonitor(provider)?.modelOptions ?? null;
  }

  // 서버 시작 직후 딱 한 번 모델 옵션을 조회해 캐시를 채운다. 조회 전용 PTY가 마침 사용량 조회로
  // 바쁘면 잠깐 뒤로 미루되, 무한 재시도로 쌓이지 않도록 시도 횟수를 제한한다.
  private fetchModelOptionsOnce(monitor: MonitorState, attemptsLeft = 5): void {
    if (this.stopping || !monitor.terminal) return;
    if (monitor.busy) {
      if (attemptsLeft <= 0) return;
      const retry = setTimeout(() => this.fetchModelOptionsOnce(monitor, attemptsLeft - 1), 3_000);
      retry.unref();
      return;
    }
    void this.modelOptions(monitor.adapter.id).catch(() => undefined);
  }

  // 상태 조회 전용 PTY에서 /model 메뉴를 열어 현재 선택 가능한 모델·추론 강도 목록을 읽는다.
  async modelOptions(provider: Provider): Promise<ModelOptions> {
    const monitor = this.findMonitor(provider);
    if (!monitor?.terminal) throw new Error("상태 조회 터미널이 준비되지 않았습니다.");
    if (!monitor.adapter.parseModelOptions) throw new Error("이 공급자는 모델 목록 조회를 지원하지 않습니다.");
    if (monitor.busy) {
      if (monitor.modelOptions) return monitor.modelOptions;
      throw new Error("상태 조회 터미널이 사용 중입니다. 잠시 후 다시 시도해주세요.");
    }
    // 메뉴를 열 필요가 없는 공급자는 지금 화면만으로 목록을 만든다. 굳이 `/model`을 보내면 그 공급자에
    // 따라 인자 입력 대기 상태가 남아 다음 사용량 조회 명령까지 망가진다(grok에서 실측).
    if (monitor.adapter.promptQuirks?.modelOptionsWithoutMenu) {
      const options = monitor.adapter.parseModelOptions(monitor.screen.text());
      if (options.models.length) monitor.modelOptions = options;
      return options.models.length || !monitor.modelOptions ? options : monitor.modelOptions;
    }
    monitor.busy = true;
    if (monitor.parseTimer) clearTimeout(monitor.parseTimer);
    try {
      monitor.screen.reset();
      monitor.terminal.write("/model\r");
      let modelScreen = await this.waitForModelScreen(monitor, monitor.adapter.promptQuirks?.modelMenuInitialTimeoutMs ?? 2_000);
      if (monitor.adapter.promptQuirks?.modelMenuConfirmDelayMs && monitor.adapter.parseModelOptions(modelScreen).models.length === 0) {
        monitor.terminal.write("\r");
        await wait(monitor.adapter.promptQuirks.modelMenuConfirmDelayMs);
        modelScreen = monitor.screen.text();
      }
      let options = monitor.adapter.parseModelOptions(modelScreen);
      if (monitor.adapter.promptQuirks?.modelOptionsReadsEffortScreen) {
        // Codex는 모델 선택 뒤 별도 effort 화면을 보여준다. 현재 모델에서 Enter를 한 번만 눌러
        // effort 화면을 읽고 Esc로 빠져나온다. /model 실행 직후의 자동완성 확정 Enter와 섞으면
        // 실제 세션에서 Low가 선택되고 남은 번호가 프롬프트에 찍히는 오입력이 생긴다.
        monitor.terminal.write("\r");
        await wait(1_000);
        options = monitor.adapter.parseModelOptions(`${modelScreen}\n${monitor.screen.text()}`);
        monitor.terminal.write("\u001b");
        await wait(100);
      }
      monitor.terminal.write("\u001b");
      // efforts는 파싱 실패 시에도 기본 목록(CLAUDE_EFFORTS 등)으로 항상 채워져 있어, 캐시 여부는
      // models 실제 파싱 성공 여부로만 판단한다. 그렇지 않으면 화면을 한 번이라도 늦게 잡아 models가
      // 빈 채로 캐시되면 그 뒤로도 계속 그 빈 캐시만 돌아와(efforts는 항상 있어 캐시 조건이 늘 참이었음)
      // 모델 선택창이 영영 안 뜨는 문제가 있었다(조회 전용 세션을 며칠씩 켜둬 컨텍스트가 쌓이고
      // 응답이 느려지면 실제로 재현됨).
      if (options.models.length) monitor.modelOptions = options;
      return options.models.length || !monitor.modelOptions ? options : monitor.modelOptions;
    } finally {
      monitor.busy = false;
      monitor.screen.reset();
    }
  }

  // /model 메뉴의 모델 목록이 실제로 그려질 때까지 짧은 간격으로 재확인한다. 고정 대기시간 한 번만
  // 보고 캡처하면, 조회 전용 세션이 오래 켜져 있어 응답이 평소보다 늦어졌을 때 아직 이전 화면(하단
  // 상태줄의 "effort: high" 같은 문구)만 잡혀 모델 목록 없이 effort만 있는 것처럼 보이는 문제가 있었다.
  private async waitForModelScreen(monitor: MonitorState, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let text = monitor.screen.text();
    while (monitor.adapter.parseModelOptions!(text).models.length === 0 && Date.now() < deadline) {
      await wait(150);
      text = monitor.screen.text();
    }
    return text;
  }

  // 계정 환경을 적용한 공급자 상태 조회용 PTY를 새로 만든다.
  private spawnProviderTerminal(monitor: MonitorState): IPty {
    const launch = monitor.adapter.createMonitorLaunch?.(process.cwd()) ?? monitor.adapter.createLaunch(process.cwd());
    return pty.spawn(launch.command, launch.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env, ...launch.env, ...this.accounts.environment(monitor.account), TERM: "xterm-256color" } as Record<string, string>,
    });
  }

  // 공급자 인터랙티브 CLI를 상태 조회 전용 PTY로 실행한다.
  private startProvider(monitor: MonitorState): void {
    this.update(monitor, { monitor_status: "starting", data_status: "unavailable", error_code: null });
    try {
      const terminal = this.spawnProviderTerminal(monitor);
      monitor.terminal = terminal;
      terminal.onData((data) => monitor.screen.write(data));
      terminal.onExit(() => {
        monitor.terminal = undefined;
        monitor.busy = false;
        if (monitor.timer) clearInterval(monitor.timer);
        if (monitor.parseTimer) clearTimeout(monitor.parseTimer);
        if (this.stopping) return;
        this.update(monitor, { monitor_status: "error", data_status: "stale", error_code: "cli_exited" });
        this.scheduleRestart(monitor);
      });
      const initial = setTimeout(() => this.requestUsage(monitor), 3_000);
      initial.unref();
      monitor.timer = setInterval(() => this.requestUsage(monitor), 60_000);
      monitor.timer.unref();
      // 모델·effort 목록은 서버가 뜰 때 딱 한 번만 조회해 캐시해두고, 그 뒤로는 사용자가 "새로고침"을
      // 눌렀을 때만 다시 조회한다(매 채팅 진입마다 CLI에 /model을 보내지 않기 위함). CLI가 막 떠서
      // 아직 준비 안 됐을 때 바로 보내지 않도록 최초 사용량 조회와 같은 지연을 둔다.
      // 모델 목록은 계정이 아니라 CLI 버전에 달린 값이라, 같은 공급자의 조회 대상이 여럿이어도
      // 대표 하나에서만 읽는다(계정 수만큼 /model 메뉴를 여는 낭비와 조회 충돌을 막는다).
      if (monitor.adapter.parseModelOptions && this.findMonitor(monitor.adapter.id) === monitor) {
        const initialModelFetch = setTimeout(() => this.fetchModelOptionsOnce(monitor), 4_000);
        initialModelFetch.unref();
      }
    } catch {
      this.update(monitor, { monitor_status: "error", data_status: "unavailable", error_code: "cli_exited" });
      this.scheduleRestart(monitor);
    }
  }

  // 연속 실패 횟수에 따라 최대 60초까지 지수 백오프로 재시작한다.
  private scheduleRestart(monitor: MonitorState): void {
    if (this.stopping || monitor.retryTimer) return;
    monitor.failureCount += 1;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.max(0, monitor.failureCount - 1));
    monitor.retryTimer = setTimeout(() => {
      monitor.retryTimer = undefined;
      this.startProvider(monitor);
    }, delay);
    monitor.retryTimer.unref();
  }

  // 중복 실행을 막고 공급자별 실제 슬래시 명령을 순서대로 전달한다.
  private requestUsage(monitor: MonitorState): void {
    if (!monitor.terminal || monitor.busy) return;
    monitor.busy = true;
    monitor.commandIndex = 0;
    const now = Date.now();
    monitor.collectUsageDetails = !!monitor.adapter.usageDetails && isUsageDetailsDue(monitor.usageDetailsCheckedAt, now);
    if (monitor.collectUsageDetails) monitor.usageDetailsCheckedAt = now;
    monitor.screen.reset();
    this.update(monitor, { monitor_status: "refreshing", last_checked_at: new Date().toISOString() });
    this.runNextCommand(monitor);
  }

  // 상세 메뉴가 로딩을 마칠 때까지 짧게 재확인하고, 완료 또는 시간 초과 화면을 파싱한다.
  private waitForUsageDetails(monitor: MonitorState, details: NonNullable<ProviderAdapter["usageDetails"]>, deadline: number): void {
    const screenText = monitor.screen.text();
    if (!details.isReady(screenText) && Date.now() < deadline) {
      monitor.parseTimer = setTimeout(() => this.waitForUsageDetails(monitor, details, deadline), 200);
      monitor.parseTimer.unref();
      return;
    }
    monitor.parseTimer = undefined;
    if (details.closeInput) monitor.terminal?.write(details.closeInput);
    void this.finishUsage(monitor, screenText);
  }

  // 명령 자동완성을 고려해 입력하고 마지막 명령 뒤 화면을 파싱한다.
  private runNextCommand(monitor: MonitorState): void {
    const details = monitor.adapter.usageDetails;
    const commands = monitor.collectUsageDetails && details
      ? [...monitor.adapter.usageCommands, details.command]
      : monitor.adapter.usageCommands;
    const command = commands[monitor.commandIndex];
    if (command) {
      monitor.terminal?.write(`${command}\r`);
      // Codex는 슬래시 명령 자동완성 메뉴를 먼저 확정해야 실제 명령이 실행된다. Enter를 즉시
      // 연달아 보내면 두 번째 Enter가 메뉴가 뜨기 전에 먹혀 /status·/usage가 실행되지 않는 경우가 있어
      // 실제 TUI 검증 스크립트와 같은 짧은 간격을 둔다.
      const confirmDelay = monitor.adapter.promptQuirks?.slashCommandConfirmDelayMs;
      if (confirmDelay) {
        const confirmTimer = setTimeout(() => monitor.terminal?.write("\r"), confirmDelay);
        confirmTimer.unref();
      }
      monitor.commandIndex += 1;
      monitor.parseTimer = setTimeout(() => this.runNextCommand(monitor), monitor.adapter.promptQuirks?.usageCommandDelayMs ?? 6_000);
      monitor.parseTimer.unref();
      return;
    }
    if (monitor.collectUsageDetails && details && monitor.terminal) {
      monitor.terminal.write(details.openInput);
      this.waitForUsageDetails(monitor, details, Date.now() + details.timeoutMs);
      return;
    }
    const screenText = monitor.screen.text();
    // 사용량 화면이 모달로 뜨는 공급자(grok)는 파싱을 마친 뒤 닫아야 다음 주기의 조회 명령이 입력창에
    // 제대로 들어간다. 화면을 읽은 다음에 닫는 순서를 지킨다.
    if (monitor.adapter.usageScreenCloseInput) monitor.terminal?.write(monitor.adapter.usageScreenCloseInput);
    void this.finishUsage(monitor, screenText);
  }

  // 터미널 사용량과 Codex 초기화권을 합친 뒤 마지막 정상값 보호 규칙을 적용한다.
  private async finishUsage(monitor: MonitorState, screenText: string): Promise<void> {
    monitor.lastSnapshot = { text: screenText, capturedAt: new Date().toISOString() };
    const rawParsed = monitor.adapter.parseUsage(screenText);
    // TODO(임시 상세 로그): 사용량 파싱 오판 추적용. 안정화되면 제거하거나 레벨을 낮춘다.
    usageLog.debug("parse", { provider: monitor.adapter.id, out: rawParsed, in: screenText });
    // Claude만 겪는 "리셋 시각이 지나도 예전 스냅샷을 계속 돌려줌" 보정(위 reconcileStaleClaudeSessionWindow 참고).
    const parsed = monitor.adapter.id === "claude" ? reconcileStaleClaudeSessionWindow(rawParsed, new Date()) : rawParsed;
    // "stale"은 파싱 자체는 성공했지만 CLI가 오래된 스냅샷을 돌려준 것으로 의심되는 상태라(위
    // isExpiredResetTime 참고), 연결 자체는 정상이므로 monitor_status를 error로 떨어뜨리지 않는다.
    const success = parsed.data_status !== "unavailable";
    if (success) monitor.failureCount = 0;
    // 같은 리셋 시각의 창에서 사용량이 줄었다면 CLI가 돌려준 옛 스냅샷이므로, 이 값으로 마지막
    // 정상값을 덮어쓰지 않고 stale 표시만 남긴다(detectUsageRegression 참고). 다음 주기에 CLI가
    // 다시 최신 값을 주면 퍼센트가 증가 방향이라 그대로 통과돼 자동 복구된다.
    const previous = this.database.prepare("SELECT details_json, reset_at FROM usage_status WHERE provider = ? AND account_id = ?")
      .get(monitor.adapter.id, monitor.account.id) as { details_json: string | null; reset_at: string | null } | undefined;
    // TODO(임시 상세 로그): 리셋 직후 reset_at 표기가 폴링마다 안정화되기 전까지 계속 바뀌는지
    // 추적하기 위한 로그. 리셋 시각이 실제로 몇 번의 폴링만에 고정되는지 확인되면 제거한다.
    if (success && previous?.reset_at && rawParsed.reset_at && previous.reset_at !== rawParsed.reset_at) {
      usageLog.info("reset_at_changed", { provider: monitor.adapter.id, accountId: monitor.account.id, from: previous.reset_at, to: rawParsed.reset_at });
    }
    if (monitor.adapter.id === "codex" && rawParsed.details_json) {
      const resetCredits = monitor.collectUsageDetails
        ? await readCodexResetCredits(this.accounts.environment(monitor.account))
        : null;
      rawParsed.details_json = mergeCodexResetCredits(rawParsed.details_json, resetCredits, previous?.details_json);
    }
    // 세션 리셋 시각이 물리적으로 불가능할 만큼 먼 값(5시간짜리 롤링 윈도우인데 8시간 넘게 남음 등)도
    // 옛 스냅샷과 같은 종류의 오검출이라 같은 방식(stale만 남기고 마지막 정상값 유지)으로 처리한다.
    const implausibleSessionReset = monitor.adapter.id === "claude" && success && isImplausibleClaudeSessionReset(parsed.details_json, new Date());
    const rejected = success && (detectUsageRegression(previous?.details_json ?? null, parsed.details_json) || implausibleSessionReset);
    monitor.rejectedStreak = rejected ? monitor.rejectedStreak + 1 : 0;
    // 거부가 계속 이어지면 마지막 정상값이 굳어버리므로 임계치를 넘긴 뒤에는 최신값을 채택한다.
    const adoptRejected = rejected && shouldAdoptRejectedUsage(monitor.rejectedStreak);
    if (adoptRejected) {
      usageLog.warn("rejected-adopted", { provider: monitor.adapter.id, accountId: monitor.account.id, streak: monitor.rejectedStreak, out: parsed });
      monitor.rejectedStreak = 0;
    }
    let keepaliveTrigger: UsageKeepaliveTrigger | null = null;
    if (rejected && !adoptRejected) {
      this.update(monitor, { monitor_status: "ready", data_status: "stale" });
    } else {
      this.update(monitor, {
        ...parsed,
        monitor_status: success ? "ready" : "error",
        last_success_at: success ? new Date().toISOString() : undefined,
      });
      if (success) {
        this.resetNotifier?.observe(monitor.adapter.id, parsed.details_json);
        keepaliveTrigger = detectUsageKeepaliveTrigger(monitor.adapter.id, previous?.details_json, parsed.details_json);
      }
    }
    monitor.collectUsageDetails = false;
    monitor.terminal?.write("\u001b");
    if (keepaliveTrigger) await this.maybeSendUsageKeepalive(monitor, keepaliveTrigger);
    monitor.busy = false;
  }

  // 계정별 초기화 창 중복 기록을 DB에서 확인하고 조회 PTY에 최소 단답 턴을 보낸다.
  private async maybeSendUsageKeepalive(monitor: MonitorState, trigger: UsageKeepaliveTrigger): Promise<void> {
    const row = this.database.prepare("SELECT reason, sent_at, window_key FROM usage_keepalive_prompts WHERE provider = ? AND account_id = ?")
      .get(monitor.adapter.id, monitor.account.id) as { reason: UsageKeepaliveReason; sent_at: string; window_key: string | null } | undefined;
    const now = new Date();
    if (!row?.window_key && row?.sent_at && trigger.windowKey && isLegacyKeepaliveFromCurrentWindow(row.sent_at, trigger.windowKey)) {
      this.database.prepare("UPDATE usage_keepalive_prompts SET window_key = ? WHERE provider = ? AND account_id = ? AND window_key IS NULL")
        .run(trigger.windowKey, monitor.adapter.id, monitor.account.id);
      return;
    }
    if (!isUsageKeepaliveDue(row?.sent_at, row?.window_key, trigger.windowKey, now)) return;
    const sentAt = now.toISOString();
    this.database.prepare(`
      INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at, window_key) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_id) DO UPDATE SET reason = excluded.reason, sent_at = excluded.sent_at, window_key = excluded.window_key
    `).run(monitor.adapter.id, monitor.account.id, trigger.reason, sentAt, trigger.windowKey);
    try {
      await this.sendUsageKeepalivePrompt(monitor);
      usageLog.info("keepalive", { provider: monitor.adapter.id, accountId: monitor.account.id, reason: trigger.reason });
      this.realtime.broadcast("usage_updated", { provider: monitor.adapter.id, accountId: monitor.account.id });
    } catch (error) {
      if (row) {
        this.database.prepare("UPDATE usage_keepalive_prompts SET reason = ?, sent_at = ?, window_key = ? WHERE provider = ? AND account_id = ? AND sent_at = ?")
          .run(row.reason, row.sent_at, row.window_key, monitor.adapter.id, monitor.account.id, sentAt);
      } else {
        this.database.prepare("DELETE FROM usage_keepalive_prompts WHERE provider = ? AND account_id = ? AND sent_at = ?")
          .run(monitor.adapter.id, monitor.account.id, sentAt);
      }
      usageLog.warn("keepalive_failed", { provider: monitor.adapter.id, accountId: monitor.account.id, reason: trigger.reason, error });
    }
  }

  // 누적 조회 문맥이 모델 입력에 섞이지 않도록 새 PTY에서 최소 턴만 실행하고 즉시 폐기한다.
  private async sendUsageKeepalivePrompt(monitor: MonitorState): Promise<void> {
    const terminal = this.spawnProviderTerminal(monitor);
    const screen = new TerminalScreen();
    let exited = false;
    terminal.onData((data) => screen.write(data));
    terminal.onExit(() => { exited = true; });
    try {
      const readyDeadline = Date.now() + 15_000;
      while (!exited && !monitor.adapter.isReady(screen.text()) && Date.now() < readyDeadline) await wait(100);
      if (exited || !monitor.adapter.isReady(screen.text())) throw new Error("세션 유지용 터미널이 준비되지 않았습니다.");
      await wait(250);
      screen.reset();
      terminal.write(USAGE_KEEPALIVE_PROMPT);
      await wait(monitor.adapter.promptQuirks?.pasteSubmitDelayMs ?? 160);
      terminal.write("\r");
      const startedAt = Date.now();
      const deadline = startedAt + 15_000;
      let retried = false;
      let sawBusy = false;
      while (!exited && Date.now() < deadline) {
        const snapshot = screen.text();
        const busy = monitor.adapter.isBusy(snapshot);
        if (busy) sawBusy = true;
        const answered = snapshot.split("\n").some((line) => line.trim() === "1");
        if (monitor.adapter.isReady(snapshot) && (sawBusy || answered) && Date.now() - startedAt >= 300) return;
        if (!retried && Date.now() - startedAt >= 1_000 && !busy) {
          terminal.write("\r");
          retried = true;
        }
        await wait(100);
      }
      if (exited) throw new Error("세션 유지용 터미널이 종료되었습니다.");
      throw new Error("세션 유지용 단답 응답을 확인하지 못했습니다.");
    } finally {
      if (!exited) terminal.kill();
      screen.dispose();
    }
  }

  // 사용량 상태의 변경 필드만 upsert하고 웹에 알린다.
  private update(monitor: MonitorState, patch: Partial<UsageRecord>): void {
    this.database.prepare(`
      INSERT INTO usage_status(provider, account_id, monitor_status, data_status, error_code, summary, used_percent, remaining_percent, reset_at, details_json, last_checked_at, last_success_at)
      VALUES (@provider, @account_id, COALESCE(@monitor_status, 'starting'), COALESCE(@data_status, 'unavailable'), @error_code, @summary, @used_percent, @remaining_percent, @reset_at, @details_json, @last_checked_at, @last_success_at)
      ON CONFLICT(provider, account_id) DO UPDATE SET
        monitor_status = COALESCE(@monitor_status, monitor_status),
        data_status = COALESCE(@data_status, data_status),
        error_code = CASE WHEN @clear_error = 1 THEN NULL ELSE COALESCE(@error_code, error_code) END,
        summary = COALESCE(@summary, summary),
        used_percent = COALESCE(@used_percent, used_percent),
        remaining_percent = COALESCE(@remaining_percent, remaining_percent),
        reset_at = COALESCE(@reset_at, reset_at),
        details_json = COALESCE(@details_json, details_json),
        last_checked_at = COALESCE(@last_checked_at, last_checked_at),
        last_success_at = COALESCE(@last_success_at, last_success_at)
    `).run({
      provider: monitor.adapter.id,
      account_id: monitor.account.id,
      monitor_status: patch.monitor_status ?? null,
      data_status: patch.data_status ?? null,
      error_code: patch.error_code ?? null,
      clear_error: patch.error_code === null ? 1 : 0,
      summary: patch.summary ?? null,
      used_percent: patch.used_percent ?? null,
      remaining_percent: patch.remaining_percent ?? null,
      reset_at: patch.reset_at ?? null,
      details_json: patch.details_json ?? null,
      last_checked_at: patch.last_checked_at ?? null,
      last_success_at: patch.last_success_at ?? null,
    });
    this.realtime.broadcast("usage_updated", { provider: monitor.adapter.id, accountId: monitor.account.id });
  }
}
