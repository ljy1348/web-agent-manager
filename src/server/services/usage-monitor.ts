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

const usageLog = createLogger("usage-check");

// Claude 5시간 세션 창이 리셋 시각을 지난 직후, 실제 대화 없이 상태 조회 전용 PTY만 조용히 /usage를
// 반복 조회하면 "Current session" 블록이 사라지는 게 아니라 리셋 전 마지막 스냅샷을 그대로 계속
// 돌려준다(실측: 화면 자체엔 여전히 session 항목이 있지만 숫자·리셋 시각이 갱신 안 됨). 기존
// isExpiredResetTime 판정이 이걸 "stale"로는 잡아내지만, stale이어도 그 오래된 숫자를 그대로 화면에
// 남겨둬 사실상 안 바뀌는 것처럼 보인다 — 리셋 시각이 지금부터 2분 이상 지났으면 이미 리셋됐다고
// 보고 0% 사용·5시간 뒤 재리셋으로 직접 채워 넣는다(2분 여유는 CLI의 반영 지연을 감안한 것).
const SESSION_RESET_GRACE_MS = 2 * 60_000;
const SESSION_WINDOW_HOURS = 5;

function parseWindows(detailsJson: string | null | undefined): UsageWindow[] {
  if (!detailsJson) return [];
  try {
    return (JSON.parse(detailsJson) as { windows?: UsageWindow[] }).windows ?? [];
  } catch {
    return [];
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

// 공급자별 경량 전용 PTY에서 실제 슬래시 명령을 1분마다 실행한다.
export class UsageMonitor {
  // 계정마다 조회 PTY가 하나씩이라 "공급자:계정ID"를 키로 쓴다.
  private readonly monitors = new Map<string, MonitorState>();
  private readonly adapters: ProviderAdapter[];
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
        this.monitors.set(key, { adapter, account, screen: new TerminalScreen(), busy: false, commandIndex: 0, failureCount: 0 });
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

  // 현재 저장된 계정별 사용량 상태를 반환한다.
  list(): UsageRecord[] {
    return this.database.prepare("SELECT * FROM usage_status ORDER BY provider, account_id").all() as UsageRecord[];
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

  // 공급자 인터랙티브 CLI를 상태 조회 전용 PTY로 실행한다.
  private startProvider(monitor: MonitorState): void {
    const launch = monitor.adapter.createMonitorLaunch?.(process.cwd()) ?? monitor.adapter.createLaunch(process.cwd());
    this.update(monitor, { monitor_status: "starting", data_status: "unavailable", error_code: null });
    try {
      const terminal = pty.spawn(launch.command, launch.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        // 계정 슬롯의 설정 디렉터리를 지정해야 그 계정의 한도를 조회한다(지정하지 않으면 기본 계정 한도가 나온다).
        env: { ...process.env, ...launch.env, ...this.accounts.environment(monitor.account), TERM: "xterm-256color" } as Record<string, string>,
      });
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
    monitor.screen.reset();
    this.update(monitor, { monitor_status: "refreshing", last_checked_at: new Date().toISOString() });
    this.runNextCommand(monitor);
  }

  // 명령 자동완성을 고려해 입력하고 마지막 명령 뒤 화면을 파싱한다.
  private runNextCommand(monitor: MonitorState): void {
    const command = monitor.adapter.usageCommands[monitor.commandIndex];
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
    const screenText = monitor.screen.text();
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
    const previous = this.database.prepare("SELECT details_json FROM usage_status WHERE provider = ? AND account_id = ?")
      .get(monitor.adapter.id, monitor.account.id) as { details_json: string | null } | undefined;
    // 세션 리셋 시각이 물리적으로 불가능할 만큼 먼 값(5시간짜리 롤링 윈도우인데 8시간 넘게 남음 등)도
    // 옛 스냅샷과 같은 종류의 오검출이라 같은 방식(stale만 남기고 마지막 정상값 유지)으로 처리한다.
    const implausibleSessionReset = monitor.adapter.id === "claude" && success && isImplausibleClaudeSessionReset(parsed.details_json, new Date());
    if (success && (detectUsageRegression(previous?.details_json ?? null, parsed.details_json) || implausibleSessionReset)) {
      this.update(monitor, { monitor_status: "ready", data_status: "stale" });
    } else {
      this.update(monitor, {
        ...parsed,
        monitor_status: success ? "ready" : "error",
        last_success_at: success ? new Date().toISOString() : undefined,
      });
      if (success) this.resetNotifier?.observe(monitor.adapter.id, parsed.details_json);
    }
    monitor.busy = false;
    monitor.terminal?.write("\u001b");
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
