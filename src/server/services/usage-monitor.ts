import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import type { Notifier } from "./notifier";
import type { UsageResetNotifier } from "./usage-reset-notifier";
import { parseUsageResetMoment } from "./usage-reset-notifier";
import { consumeCodexResetCredit, readCodexResetCredits, type CodexResetCredits, type CodexResetCreditConsumeResult } from "../providers/codex-rate-limits";
import { CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS, USAGE_KEEPALIVE_COOLDOWN_MS, usageKeepaliveHasRemainingAttempts, usageKeepaliveMinimumResponseChars, usageKeepalivePrompt } from "../../shared/usage-keepalive";

const usageLog = createLogger("usage-check");

// Claude 5시간 세션 창이 리셋 시각을 지난 직후, 실제 대화 없이 상태 조회 전용 PTY만 조용히 /usage를
// 반복 조회하면 "Current session" 블록이 사라지는 게 아니라 리셋 전 마지막 스냅샷을 그대로 계속
// 돌려준다(실측: 화면 자체엔 여전히 session 항목이 있지만 숫자·리셋 시각이 갱신 안 됨). 기존
// isExpiredResetTime 판정이 이걸 "stale"로는 잡아내지만, stale이어도 그 오래된 숫자를 그대로 화면에
// 남겨둬 사실상 안 바뀌는 것처럼 보인다 — 리셋 시각이 지금부터 2분 이상 지났으면 이미 리셋됐다고
// 보고 0% 사용·5시간 뒤 재리셋으로 직접 채워 넣는다(2분 여유는 CLI의 반영 지연을 감안한 것).
const SESSION_RESET_GRACE_MS = 2 * 60_000;
const SESSION_WINDOW_HOURS = 5;
// Codex app-server direct 경로는 매 1분 조회마다 초기화권을 함께 받는다. 이 간격은 direct API가
// 실패했을 때만 여는 무거운 `/usage` PTY 상세 메뉴의 상한이다.
const USAGE_DETAILS_INTERVAL_MS = 60 * 60_000;

// 조회 전용 PTY를 오래 켜두면 Claude CLI가 /usage 요청에 프로세스 시작 시점의 캐시를 간헐적으로
// 그대로 돌려준다(실측 #52: 16시간 된 PTY가 최신값 "2pm 13%"와 시작 당시 값 "6pm 89%"를 매분
// 번갈아 반환. 같은 명령으로 새로 띄운 PTY는 6회 조회 6회 모두 최신값이었고, 그 PTY를 재시작하자
// 10분 관찰에서 옛 값이 한 번도 나오지 않았다). CLI 쪽 동작이라 파싱으로는 막을 수 없어, 캐시가
// 묵기 전에 주기적으로 새 프로세스로 갈아탄다.
const MONITOR_PTY_MAX_AGE_MS = 3 * 60 * 60_000;

// 초기화 감지 뒤 고정 메시지를 보내기까지 두는 간격. 이 사이에 조회 PTY를 새로 띄워, CLI가 아직
// 옛 창을 들고 있는 경계 구간을 지나 새 창을 정확히 잡은 상태에서 고정하도록 한다(#57).
const KEEPALIVE_RESTART_DELAY_MS = 60_000;
// 고정용 임시 PTY가 뜨기를 기다리는 한계. Codex는 15초 안에 준비되지 않아 고정이 통째로 실패했다.
const KEEPALIVE_READY_TIMEOUT_MS = 90_000;
// 전송 또는 사후 고정 확인이 실패했을 때 다음 시도까지 한 번의 조회 주기를 둔다. 첫 시도는
// KEEPALIVE_RESTART_DELAY_MS 뒤 그대로 나가고, 실패한 0% 창은 1분 뒤 더 긴 문구로 재시도한다.
const KEEPALIVE_RETRY_INTERVAL_MS = 60_000;
// Codex 응답 뒤 첫 사용량 재확인을 당기는 시간과, 0% reset 시각이 정말 멈췄는지 보는 최소 간격.
const KEEPALIVE_VERIFY_DELAY_MS = 10_000;
// reset 표시는 분 단위라 60초보다 길게 떨어져야, 계속 미끄러지는 창을 같은 문자열로 오인하지 않는다.
const KEEPALIVE_STABLE_RESET_INTERVAL_MS = 75_000;
// 격리된 Codex exec는 정상 실측에서 7~10초에 끝났지만 공급자 지연을 감안해 충분한 한계를 둔다.
const CODEX_KEEPALIVE_EXEC_TIMEOUT_MS = 180_000;
const CODEX_KEEPALIVE_EXEC_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export interface CodexKeepaliveExecSummary {
  responseChars: number;
  usage: Record<string, unknown> | null;
}

// 대화형 TUI 화면은 답변 스트리밍 중에도 빈 composer를 다시 보여 완료로 오인된다. Codex의
// 비대화형 JSON 실행 인자만 사용해 프로젝트 지침·쓰기 권한·MCP 설정을 고정 턴에서 분리한다.
export function codexKeepaliveExecArgs(isolatedDirectory: string, prompt: string): string[] {
  return [
    "exec",
    "-C", isolatedDirectory,
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox", "read-only",
    "--color", "never",
    "--json",
    prompt,
  ];
}

// 정상 종료만으로는 빈 응답도 성공할 수 있으므로 JSON 이벤트에서 완결된 agent_message와
// turn.completed를 함께 요구한다. 일부 스트리밍 텍스트는 item.completed가 아니어서 통과하지 못한다.
export function parseCodexKeepaliveExecOutput(output: string, minimumResponseChars: number): CodexKeepaliveExecSummary {
  let response = "";
  let completed = false;
  let usage: Record<string, unknown> | null = null;
  for (const line of output.split("\n").map((value) => value.trim()).filter(Boolean)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "turn.failed" || type === "error") throw new Error("Codex 세션 유지 턴이 실패했습니다.");
    if (type === "item.completed" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") response = item.text.trim();
      if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(String(item.type))) {
        throw new Error("Codex 세션 유지 턴이 격리 응답 외 도구를 실행했습니다.");
      }
    }
    if (type === "turn.completed") {
      completed = true;
      usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : null;
    }
  }
  if (!completed) throw new Error("Codex 세션 유지 턴 완료 이벤트를 확인하지 못했습니다.");
  const responseChars = Array.from(response).length;
  if (responseChars < minimumResponseChars) {
    throw new Error(`Codex 세션 유지 답변이 너무 짧습니다(${responseChars}/${minimumResponseChars}자).`);
  }
  return { responseChars, usage };
}

// 계정 인증 환경만 전달하고 매 실행마다 빈 임시 cwd를 만든다. 세션 JSONL은 보존해 이후에도 실제
// 질문·답변을 감사할 수 있지만, 정확한 keepalive 문구라 history-sync가 일반 채팅에서는 숨긴다.
export async function runCodexKeepaliveExec(options: {
  command: string;
  env: Record<string, string>;
  prompt: string;
  minimumResponseChars: number;
}): Promise<CodexKeepaliveExecSummary> {
  const isolatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wam-codex-keepalive-"));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(options.command, codexKeepaliveExecArgs(isolatedDirectory, options.prompt), {
        cwd: isolatedDirectory,
        env: options.env,
        encoding: "utf8",
        timeout: CODEX_KEEPALIVE_EXEC_TIMEOUT_MS,
        maxBuffer: CODEX_KEEPALIVE_EXEC_MAX_BUFFER_BYTES,
      }, (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split("\n").slice(-1)[0];
          reject(new Error(`Codex 세션 유지 실행 실패: ${error.message}${detail ? ` (${detail})` : ""}`));
          return;
        }
        resolve(stdout);
      });
      // execFile의 기본 stdin pipe를 열어두면 Codex가 프롬프트 인자를 받았어도 추가 stdin이 올 때까지
      // 기다려 실제 통합 검증에서 60초 timeout됐다. 입력은 인자로 모두 전달했으므로 즉시 EOF를 보낸다.
      child.stdin?.end();
    });
    return parseCodexKeepaliveExecOutput(output, options.minimumResponseChars);
  } finally {
    fs.rmSync(isolatedDirectory, { recursive: true, force: true });
  }
}

// 조회 PTY가 캐시가 묵을 만큼 오래 떠 있었는지 판정한다.
export function isMonitorTerminalAged(startedAt: number | undefined, now: number): boolean {
  return startedAt !== undefined && now - startedAt >= MONITOR_PTY_MAX_AGE_MS;
}

// 마지막 PTY 상세 조회 시각을 기준으로 1시간 주기의 다음 조회가 필요한지 판정한다.
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
  // Direct OAuth usage uses an absolute ISO timestamp. Running that through the date-less TUI
  // clock parser shifts UTC into the server's local day and can fabricate a 17-hour future reset.
  if (/^\d{4}-\d{2}-\d{2}T/i.test(session.resetAt)) {
    const absolute = Date.parse(session.resetAt);
    return Number.isFinite(absolute) && absolute - now.getTime() > SESSION_RESET_PLAUSIBLE_MAX_MS;
  }
  const today = todayResetTime(session.resetAt, now);
  if (!today) return false;
  const next = today.getTime() >= now.getTime() ? today : new Date(today.getTime() + 24 * 60 * 60_000);
  return next.getTime() - now.getTime() > SESSION_RESET_PLAUSIBLE_MAX_MS;
}

export function reconcileStaleClaudeSessionWindow(parsed: Partial<UsageRecord>, now: Date, previousDetailsJson?: string | null): Partial<UsageRecord> {
  if (parsed.data_status === "unavailable") return parsed;
  let windows = parseWindows(parsed.details_json);
  let sessionIndex = windows.findIndex((window) => window.id === "session");
  let session = windows[sessionIndex];
  // 새 화면에 세션 Resets가 없으면 직전 저장 창으로만 만료를 본다. 주간은 방금 읽은 값을 유지한다.
  if (!session?.resetAt) {
    const previousWindows = parseWindows(previousDetailsJson);
    const previousSession = previousWindows.find((window) => window.id === "session");
    if (!previousSession?.resetAt) return parsed;
    const weeklyFromParsed = windows.filter((window) => window.id !== "session");
    const previousWeekly = previousWindows.filter((window) => window.id !== "session");
    windows = [{ ...previousSession }, ...(weeklyFromParsed.length ? weeklyFromParsed : previousWeekly)];
    sessionIndex = 0;
    session = windows[0];
  }
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
    error_code: null,
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

// 양수→0% 전환 순간에만 얻을 수 있는 새 창 키는 이후 연속 0% 관측에서 다시 만들 수 없다.
// 같은 keepalive 에피소드가 진행 중이면 키가 있는 pending을 우선해, 60초 정기 폴링이 같은 시각의
// 실행 타이머보다 먼저 돌아도 새 초기화 예약을 null 키·기존 쿨다운 상태로 강등하지 않는다.
function prioritizeUsageKeepaliveTrigger(
  pending: UsageKeepaliveTrigger | undefined,
  observed: UsageKeepaliveTrigger,
): UsageKeepaliveTrigger {
  if (pending?.reason === observed.reason && pending.windowKey && !observed.windowKey) return pending;
  return observed;
}

export interface CodexKeepaliveConfirmation {
  trigger: UsageKeepaliveTrigger;
  sentAt: string;
  targetWindowIds: string[];
  resetSignature?: string;
  resetObservedAt?: number;
}

export type CodexKeepaliveConfirmationResult =
  | { status: "confirmed" }
  | { status: "pending"; confirmation: CodexKeepaliveConfirmation }
  | { status: "retry" };

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

// Codex는 응답 도착만으로 성공 처리하지 않는다. 대상 창이 모두 정수 사용량 1% 이상이면 즉시
// 고정 성공이다. 일부 창이 0%로 반올림되면 대상 전체의 reset 문자열이 충분한 간격의 두 조회에서
// 정확히 같을 때만 보조 성공으로 인정한다. 5시간만 1%가 됐다고 주간 확인을 조기 종료하지 않는다.
export function evaluateCodexKeepaliveConfirmation(
  confirmation: CodexKeepaliveConfirmation,
  detailsJson: string | null | undefined,
  now: Date = new Date(),
): CodexKeepaliveConfirmationResult {
  const targets = parseWindows(detailsJson).filter((window) => confirmation.targetWindowIds.includes(window.id));
  if (!targets.length) return { status: "pending", confirmation };
  if (targets.length === confirmation.targetWindowIds.length
    && targets.every((window) => window.usedPercent !== null && window.usedPercent >= 1)) return { status: "confirmed" };
  if (targets.length !== confirmation.targetWindowIds.length || targets.some((window) => !window.resetAt)) {
    return { status: "pending", confirmation };
  }
  const resetSignature = JSON.stringify(targets
    .map((window) => ({ id: window.id, resetAt: window.resetAt }))
    .sort((left, right) => left.id.localeCompare(right.id)));
  if (!confirmation.resetSignature || confirmation.resetObservedAt === undefined) {
    return { status: "pending", confirmation: { ...confirmation, resetSignature, resetObservedAt: now.getTime() } };
  }
  if (now.getTime() - confirmation.resetObservedAt < KEEPALIVE_STABLE_RESET_INTERVAL_MS) {
    return { status: "pending", confirmation };
  }
  return resetSignature === confirmation.resetSignature ? { status: "confirmed" } : { status: "retry" };
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
  // Grok 주간 한도는 빈 창을 깨울 대상이 아니라서 Codex keepalive 경로에 넣지 않는다.
  if (provider !== "codex") return null;
  // 사용자의 정책에 따라 롤링 5시간과 주간 창 모두 초기화 직후 한 턴으로 활성화한다. 두 창이
  // 동시에 0%여도 exec는 하나만 만들며, 확인 중 재전송 금지가 분 단위 비용 폭주를 막는다.
  const zeroWindows = current.filter((window) => (window.id === "five_hour" || window.id === "weekly") && window.usedPercent === 0);
  if (!zeroWindows.length) return null;
  const previous = parseWindows(previousDetailsJson);
  const resetWindows = zeroWindows.filter((window) => {
    const before = previous.find((candidate) => candidate.id === window.id);
    return before?.usedPercent !== null && before?.usedPercent !== undefined && before.usedPercent > 0;
  });
  // 양수→0% 전환은 직전 keepalive 쿨다운과 무관한 새 초기화다. 이 순간의 키를 예약 작업에
  // 보존해 즉시 처리하고, 이후 계속되는 0% 관측은 null 키로 기존 5시간 중복 방지를 적용한다.
  return {
    reason: "codex_reset_zero",
    windowKey: resetWindows.length ? usageKeepaliveWindowKey(resetWindows, now) : null,
  };
}

// 5시간 창이 이미 1% 이상이면 고정 턴을 더 보내지 않고 현재 창을 성공으로 남긴다.
export function pinnedCodexKeepaliveTrigger(detailsJson: string | null | undefined, now: Date = new Date()): UsageKeepaliveTrigger | null {
  const fiveHour = parseWindows(detailsJson).find((window) => window.id === "five_hour");
  if (fiveHour?.usedPercent === null || fiveHour?.usedPercent === undefined || fiveHour.usedPercent < 1) return null;
  return { reason: "codex_reset_zero", windowKey: usageKeepaliveWindowKey([fiveHour], now) };
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
  // 마지막 정상 반영 이후 연속으로 거부된 fresh 조회 횟수. non-fresh가 끼면 즉시 0으로 돌아간다.
  rejectedStreak: number;
  // 같은 리셋 날짜에서 0%로 떨어진 창을 확정하기 전 연속 관측 횟수와, 이미 PTY를 재시작했는지.
  zeroConfirmStreak?: number;
  zeroConfirmRecycled?: boolean;
  // Claude usage 상세 endpoint가 fallback을 돌려줄 때 매분 다시 두드리지 않도록 다음 자동 조회를
  // 허용할 시각과 연속 fallback 횟수를 기억한다. 사용자가 누른 수동 새로고침은 이 시각을 우회한다.
  usagePollNotBeforeAt?: number;
  usageFallbackStreak?: number;
  // keepalive 타이머가 실행될 때 가장 최근 관측이 fresh였는지 확인한다. false면 보존 DB 숫자를
  // 현재값으로 오인해 비용이 드는 턴을 보내지 않는다.
  usageObservationFresh?: boolean;
  // 숫자는 채택하지 않아도 세션 0%·Resets 없음·세션 블록 누락처럼 현재 화면에서 고정을 봐야 하면 true.
  usageKeepaliveTrusted?: boolean;
  collectUsageDetails: boolean;
  usageDetailsCheckedAt?: number;
  // 조회 PTY를 띄운 시각. 수명이 다하면 CLI 캐시가 묵기 전에 갈아탄다(MONITOR_PTY_MAX_AGE_MS 참고).
  terminalStartedAt?: number;
  // 수명이 다해 우리가 일부러 끊는 중인지. 실패로 오인해 error를 띄우지 않기 위한 표시다.
  recycling?: boolean;
  // 아직 보내지 못한 초기화 고정 요청. 전송에 실패하면 남겨두고 다음 조회 주기에 다시 시도한다.
  // Codex 트리거는 "양수 → 0%" 전환 순간에만 잡혀서, 이게 없으면 한 번 실패한 창은 영영 고정되지
  // 못한다(실측 #57: 준비 시간 초과로 두 번 실패한 뒤 재시도 기회가 없어 그 창이 고정 안 됨).
  pendingKeepalive?: UsageKeepaliveTrigger;
  keepaliveTimer?: NodeJS.Timeout;
  // 첫 감지 뒤 1분 경계와 실패 재시도 간격을 보존한다. 타이머가 사용량 조회 busy와 겹쳐도 이
  // 시각은 사라지지 않아, 조회 완료 직후 같은 pending 작업을 이어서 처리할 수 있다.
  keepaliveNotBeforeAt?: number;
  // 마지막으로 고정 전송을 시도한 시각. 실패가 이어질 때 재시도 간격을 벌리는 데 쓴다.
  lastKeepaliveAttemptAt?: number;
  // Codex는 모델 응답 뒤 1% 이상 사용량 또는 안정된 reset 시각을 다시 관측해야 DB 성공 기록을 남긴다.
  keepaliveConfirmation?: CodexKeepaliveConfirmation;
  keepaliveVerificationTimer?: NodeJS.Timeout;
  keepalivePromptAttempt?: number;
  // exec가 끝나기 전에 재시도 타이머가 또 보내면 긴 답이 겹쳐 한도만 소모한다.
  keepaliveSendInFlight?: boolean;
  // 파싱에 실제로 넘긴 원본 화면 텍스트를 매 조회마다 남겨, 파싱이 왜 실패·이상하게 됐는지 웹에서
  // 직접 확인할 수 있게 한다("숫자만 보지 말고 실제 CLI 화면을 보고 싶다"는 실사용 요청으로 추가함).
  lastSnapshot?: { text: string; capturedAt: string };
}

type UsageCollectionSource = "direct" | "pty";

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
  const absoluteA = /^\d{4}-\d{2}-\d{2}T/i.test(a) ? Date.parse(a) : Number.NaN;
  const absoluteB = /^\d{4}-\d{2}-\d{2}T/i.test(b) ? Date.parse(b) : Number.NaN;
  if (Number.isFinite(absoluteA) || Number.isFinite(absoluteB)) {
    return Number.isFinite(absoluteA) && Number.isFinite(absoluteB)
      && Math.abs(absoluteA - absoluteB) <= SAME_WINDOW_TOLERANCE_MINUTES * 60_000;
  }
  const partsA = resetTimeParts(a);
  const partsB = resetTimeParts(b);
  if (partsA.dateText !== partsB.dateText) return false;
  if (partsA.minutesOfDay === null || partsB.minutesOfDay === null) return false;
  const raw = Math.abs(partsA.minutesOfDay - partsB.minutesOfDay);
  return Math.min(raw, 1440 - raw) <= SAME_WINDOW_TOLERANCE_MINUTES;
}

// 같은 리셋 창에서 사용량이 줄었는지 한 창만 본다.
function isUsageWindowRegression(before: UsageWindow | undefined, window: UsageWindow): boolean {
  return !!before && before.usedPercent !== null && window.usedPercent !== null
    && !!window.resetAt && !!before.resetAt
    && isSameResetWindow(window.resetAt, before.resetAt)
    && window.usedPercent < before.usedPercent;
}

// 새로 파싱한 사용량에서 같은 창인데 줄어든 구간 id를 모은다.
export function regressedUsageWindowIds(previousDetailsJson: string | null, parsedDetailsJson: string | null | undefined): string[] {
  if (!previousDetailsJson || !parsedDetailsJson) return [];
  let previous: UsageWindow[];
  let parsed: UsageWindow[];
  try {
    previous = (JSON.parse(previousDetailsJson) as { windows?: UsageWindow[] }).windows ?? [];
    parsed = (JSON.parse(parsedDetailsJson) as { windows?: UsageWindow[] }).windows ?? [];
  } catch {
    return [];
  }
  return parsed.filter((window) => isUsageWindowRegression(previous.find((item) => item.id === window.id), window)).map((window) => window.id);
}

// 새로 파싱한 사용량이 직전 저장값보다 "같은 창인데 줄어든" 구간이 있는지 확인한다.
// 사용량 창은 리셋 시각이 지나기 전까지 누적만 되므로, 같은 창에서 퍼센트가 줄었다면 조회 전용
// CLI가 오래된 스냅샷을 돌려준 것이다(실측: 실제 56% 시점에 1시간 전 값 26%를 최신인 척 반환,
// 리셋 시각이 아직 미래라 isExpiredResetTime로는 못 잡음). 리셋 시각이 실질적으로 달라졌으면
// (몇 분 표기 오차 초과 — isSameResetWindow 참고) 창이 넘어간 것이므로 감소를 정상으로 본다.
export function detectUsageRegression(previousDetailsJson: string | null, parsedDetailsJson: string | null | undefined): boolean {
  return regressedUsageWindowIds(previousDetailsJson, parsedDetailsJson).length > 0;
}

export interface ZeroUsageConfirmState {
  streak: number;
  recycled: boolean;
}

export type FreshUsageDecision =
  | { kind: "adopt"; record: Partial<UsageRecord>; zeroConfirm: ZeroUsageConfirmState }
  | { kind: "reject"; zeroConfirm: ZeroUsageConfirmState }
  | { kind: "hold-zero"; record: Partial<UsageRecord>; recycle: boolean; zeroConfirm: ZeroUsageConfirmState };

const ZERO_USAGE_CONFIRM_STREAK = 2;

// 사용량 창 목록으로 대표값·요약을 다시 만든다.
function recordWithWindows(parsed: Partial<UsageRecord>, windows: UsageWindow[], primaryId?: string): Partial<UsageRecord> {
  const primary = windows.find((window) => window.id === primaryId) ?? windows[0];
  let extras: Record<string, unknown> = {};
  try {
    extras = JSON.parse(parsed.details_json ?? "{}") as Record<string, unknown>;
  } catch {
    extras = {};
  }
  return {
    ...parsed,
    used_percent: primary?.usedPercent ?? parsed.used_percent,
    remaining_percent: primary?.remainingPercent ?? parsed.remaining_percent,
    reset_at: primary?.resetAt ?? parsed.reset_at,
    summary: windows.map((window) => `${window.label}: ${window.usedPercent}% used`).join("\n"),
    details_json: JSON.stringify({ ...extras, windows }),
  };
}

// 같은 날짜 0%는 바로 거절하지 않는다. 2회 연속 뒤 PTY를 재시작해 그때도 0%면 확정한다.
export function decideFreshUsageAdoption(
  parsed: Partial<UsageRecord>,
  previousDetailsJson: string | null | undefined,
  primaryWindowId: string | undefined,
  zeroConfirm: ZeroUsageConfirmState,
): FreshUsageDecision {
  const parsedWindows = parseWindows(parsed.details_json);
  const previousWindows = parseWindows(previousDetailsJson);
  const regressedIds = regressedUsageWindowIds(previousDetailsJson ?? null, parsed.details_json);
  const primaryId = primaryWindowId ?? parsedWindows[0]?.id;
  const zeroRegressedIds = regressedIds.filter((id) => parsedWindows.find((window) => window.id === id)?.usedPercent === 0);
  const resetConfirm = { streak: 0, recycled: false };
  if (primaryId && regressedIds.includes(primaryId) && !zeroRegressedIds.includes(primaryId)) {
    return { kind: "reject", zeroConfirm: resetConfirm };
  }
  if (!zeroRegressedIds.length) return { kind: "adopt", record: parsed, zeroConfirm: resetConfirm };
  if (zeroConfirm.recycled) return { kind: "adopt", record: parsed, zeroConfirm: resetConfirm };
  const streak = zeroConfirm.streak + 1;
  const recycle = streak >= ZERO_USAGE_CONFIRM_STREAK;
  const heldWindows = parsedWindows.map((window) => (
    zeroRegressedIds.includes(window.id) ? previousWindows.find((item) => item.id === window.id) ?? window : window
  ));
  return {
    kind: "hold-zero",
    recycle,
    zeroConfirm: { streak, recycled: recycle || zeroConfirm.recycled },
    record: recordWithWindows(parsed, heldWindows, primaryId),
  };
}

// 조회 주기가 60초이므로 약 5분에 해당한다. 이 횟수만큼 같은 감소가 이어져도 최신이라는 증거는
// 아니다. 실제 Claude fallback 1%가 다섯 번 반복돼 이 임계값에서 잘못 채택된 운영 장애가 있었다.
const REJECTED_ADOPT_STREAK = 5;

const CLAUDE_USAGE_BACKOFF_BASE_MS = 2 * 60_000;
const CLAUDE_USAGE_BACKOFF_MAX_MS = 15 * 60_000;

// 사용자 quota와 무관한 /usage 상세 조회 fallback만 자동 폴링 백오프 대상으로 삼는다.
export function isClaudeUsageFallbackError(errorCode: UsageRecord["error_code"] | undefined): boolean {
  return !!errorCode && [
    "usage_seeded_headers_throttled",
    "usage_seeded_persisted_throttled",
    "usage_seeded_headers_refresh_failed",
    "usage_seeded_persisted_refresh_failed",
    "usage_endpoint_throttled",
  ].includes(errorCode);
}

export function claudeUsageBackoffMs(fallbackStreak: number): number {
  return Math.min(CLAUDE_USAGE_BACKOFF_MAX_MS, CLAUDE_USAGE_BACKOFF_BASE_MS * 2 ** Math.max(0, fallbackStreak - 1));
}

// 공급자별 구조화 API/RPC를 1분마다 조회하고 실패한 주기에만 경량 PTY로 폴백한다.
export class UsageMonitor {
  // 계정마다 독립 사용량 상태가 있으므로 "공급자:계정ID"를 키로 쓴다.
  private readonly monitors = new Map<string, MonitorState>();
  private readonly adapters: ProviderAdapter[];
  private readonly resetCreditRedemptions = new Set<string>();
  private runCodexKeepalive = runCodexKeepaliveExec;
  private stopping = false;

  constructor(
    private readonly database: AppDatabase,
    adapters: ProviderAdapter[],
    private readonly realtime: RealtimeHub,
    private readonly accounts: AgentAccountService,
    private readonly resetNotifier?: UsageResetNotifier,
    // 인증 안 된 계정을 무작정 폴링하면 codex·claude 모두 로그인·온보딩 화면에 계속 걸리는
    // 문제가 있었다(실사용 보고). 없으면(테스트 등) 항상 인증된 것으로 보고 기존처럼 동작한다.
    private readonly isAuthenticated?: (provider: Provider, accountId: number) => boolean,
    private readonly notifications?: Notifier,
  ) {
    this.adapters = adapters;
  }

  // 설정된 범위(기본 계정만 / 전 계정)에 맞는 조회 대상을 만든다.
  private buildMonitors(): void {
    for (const adapter of this.adapters) {
      for (const account of this.accounts.monitorTargets(adapter.id)) {
        const key = monitorKey(adapter.id, account.id);
        if (this.monitors.has(key)) continue;
        this.monitors.set(key, { adapter, account, screen: new TerminalScreen(), busy: false, commandIndex: 0, failureCount: 0, rejectedStreak: 0, zeroConfirmStreak: 0, collectUsageDetails: false });
      }
    }
  }

  // 조회 대상 계정의 direct poller를 시작한다. PTY는 direct 실패나 모델 목록 요청 때만 지연 생성한다.
  start(): void {
    this.stopping = false;
    this.buildMonitors();
    for (const monitor of this.monitors.values()) if (!monitor.timer) this.startProvider(monitor);
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
    if (monitor.keepaliveTimer) clearTimeout(monitor.keepaliveTimer);
    if (monitor.keepaliveVerificationTimer) clearTimeout(monitor.keepaliveVerificationTimer);
    if (monitor.terminal) {
      monitor.recycling = true;
      monitor.terminal.kill();
    }
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

  // CliAuthManager가 로그인 완료를 감지하면 인증 때문에 시작하지 못했던 direct poller를 시작한다.
  notifyAuthenticated(provider: string, accountId: number | null): void {
    if (accountId == null) return;
    const monitor = this.monitors.get(monitorKey(provider as Provider, accountId));
    if (monitor && !monitor.timer) this.startProvider(monitor);
  }

  // 지정 공급자의 사용량을 즉시 다시 조회한다. 계정을 지정하지 않으면 그 공급자의 모든 조회 대상을 갱신한다.
  refresh(provider: Provider, accountId?: number): void {
    const targets = accountId != null
      ? [this.findMonitor(provider, accountId)].filter((monitor): monitor is MonitorState => !!monitor)
      : [...this.monitors.values()].filter((monitor) => monitor.adapter.id === provider);
    if (!targets.length) throw new Error("지원하지 않는 공급자입니다.");
    for (const monitor of targets) this.requestUsage(monitor, true);
  }

  // CLI 업데이트 뒤 남아 있는 폴백 PTY를 닫고 구버전 모델 캐시를 비운 뒤 direct 조회를 당긴다.
  // API 이름은 기존 클라이언트 호환을 위해 유지한다.
  restartProviderTerminals(provider: Provider): number {
    const targets = [...this.monitors.values()].filter((monitor) => monitor.adapter.id === provider);
    for (const monitor of targets) {
      monitor.modelOptions = undefined;
      monitor.failureCount = 0;
      monitor.usagePollNotBeforeAt = undefined;
      monitor.usageFallbackStreak = 0;
      if (monitor.terminal) this.recycleTerminal(monitor);
      this.requestUsage(monitor, true);
    }
    return targets.length;
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
      this.requestUsage(monitor, true);
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

  // 서버 시작 직후 딱 한 번 direct 모델 옵션을 조회해 캐시를 채운다. 실패할 때만 여는 조회 전용
  // PTY가 마침 사용량 조회로 바쁘면 잠깐 뒤로 미루되, 무한 재시도로 쌓이지 않도록 제한한다.
  private fetchModelOptionsOnce(monitor: MonitorState, attemptsLeft = 5): void {
    if (this.stopping) return;
    if (monitor.busy) {
      if (attemptsLeft <= 0) return;
      const retry = setTimeout(() => this.fetchModelOptionsOnce(monitor, attemptsLeft - 1), 3_000);
      retry.unref();
      return;
    }
    void this.modelOptions(monitor.adapter.id).catch(() => undefined);
  }

  // 공급자 direct catalog를 우선 읽고 실패할 때만 상태 조회 PTY의 /model 메뉴를 파싱한다.
  async modelOptions(provider: Provider): Promise<ModelOptions> {
    const monitor = this.findMonitor(provider);
    if (!monitor) throw new Error("상태 조회 대상을 찾을 수 없습니다.");
    if (!monitor.adapter.parseModelOptions) throw new Error("이 공급자는 모델 목록 조회를 지원하지 않습니다.");
    if (monitor.busy) {
      if (monitor.modelOptions) return monitor.modelOptions;
      throw new Error("상태 조회 터미널이 사용 중입니다. 잠시 후 다시 시도해주세요.");
    }
    monitor.busy = true;
    if (monitor.parseTimer) clearTimeout(monitor.parseTimer);
    try {
      if (monitor.adapter.collectModelOptions) {
        try {
          const options = await monitor.adapter.collectModelOptions({
            environment: this.accounts.environment(monitor.account),
            command: monitor.adapter.cliVersionCommand.command,
          });
          if (!options.models.length) throw new Error("direct model catalog is empty");
          monitor.modelOptions = options;
          return options;
        } catch (error) {
          usageLog.warn("direct_models_failed_pty_fallback", {
            provider: monitor.adapter.id,
            accountId: monitor.account.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await this.ensureProviderTerminal(monitor);
      if (!monitor.terminal) throw new Error("상태 조회 터미널이 준비되지 않았습니다.");
      // 메뉴를 열 필요가 없는 공급자는 준비 화면만으로 목록을 만든다. 굳이 `/model`을 보내면 그
      // 공급자에 따라 인자 입력 대기 상태가 남는다(grok에서 실측).
      if (monitor.adapter.promptQuirks?.modelOptionsWithoutMenu) {
        const options = monitor.adapter.parseModelOptions(monitor.screen.text());
        if (options.models.length) monitor.modelOptions = options;
        return options.models.length || !monitor.modelOptions ? options : monitor.modelOptions;
      }
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
      this.closeProviderTerminal(monitor);
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

  // direct 실패나 모델 목록 요청 시에만 공급자 TUI를 만들고 입력 가능한 화면까지 기다린다.
  private async ensureProviderTerminal(monitor: MonitorState): Promise<void> {
    if (!monitor.terminal) {
      monitor.screen.reset();
      const terminal = this.spawnProviderTerminal(monitor);
      monitor.terminal = terminal;
      monitor.terminalStartedAt = Date.now();
      terminal.onData((data) => monitor.screen.write(data));
      terminal.onExit(() => {
        if (monitor.terminal === terminal) monitor.terminal = undefined;
        monitor.terminalStartedAt = undefined;
        monitor.screen.reset();
        const expected = !!monitor.recycling;
        monitor.recycling = false;
        if (!expected && !this.stopping && monitor.busy) {
          monitor.busy = false;
          this.update(monitor, { monitor_status: "error", data_status: "stale", error_code: "cli_exited" });
          this.scheduleRestart(monitor);
        }
      });
    }
    const deadline = Date.now() + 90_000;
    while (monitor.terminal && !monitor.adapter.isReady(monitor.screen.text()) && Date.now() < deadline) await wait(100);
    if (!monitor.terminal || !monitor.adapter.isReady(monitor.screen.text())) {
      this.closeProviderTerminal(monitor);
      throw new Error("상태 조회 터미널이 준비되지 않았습니다.");
    }
  }

  // 평상시에는 조회 TUI 프로세스를 남기지 않는다. 종료 callback은 recycling을 보고 실패로 세지 않는다.
  private closeProviderTerminal(monitor: MonitorState): void {
    if (!monitor.terminal || monitor.recycling) return;
    monitor.recycling = true;
    monitor.terminal.kill();
  }

  // 인증된 계정의 direct poll timer만 시작한다. 아직 인증 안 된 계정은 네트워크·PTY를 모두 건너뛴다.
  private startProvider(monitor: MonitorState, options: { keepLastValue?: boolean } = {}): void {
    if (this.isAuthenticated && !this.isAuthenticated(monitor.adapter.id, monitor.account.id)) {
      this.update(monitor, { monitor_status: "error", data_status: "unavailable", error_code: "auth_required" });
      return;
    }
    this.update(monitor, options.keepLastValue
      ? { monitor_status: "starting", error_code: null }
      : { monitor_status: "starting", data_status: "unavailable", error_code: null });
    const initial = setTimeout(() => this.requestUsage(monitor), 3_000);
    initial.unref();
    if (!monitor.timer) {
      monitor.timer = setInterval(() => this.requestUsage(monitor), 60_000);
      monitor.timer.unref();
    }
    // 모델 목록은 대표 계정에서 direct-first로 한 번 읽고, 실패해 열린 PTY도 즉시 닫는다.
    if (monitor.adapter.parseModelOptions && this.findMonitor(monitor.adapter.id) === monitor) {
      const initialModelFetch = setTimeout(() => this.fetchModelOptionsOnce(monitor), 4_000);
      initialModelFetch.unref();
    }
  }

  // PTY 폴백 자체가 실패하면 direct 조회를 지수 백오프로 다시 당긴다.
  private scheduleRestart(monitor: MonitorState): void {
    if (this.stopping || monitor.retryTimer) return;
    monitor.failureCount += 1;
    const delay = Math.min(60_000, 5_000 * 2 ** Math.max(0, monitor.failureCount - 1));
    monitor.retryTimer = setTimeout(() => {
      monitor.retryTimer = undefined;
      this.requestUsage(monitor, true);
    }, delay);
    monitor.retryTimer.unref();
  }

  // 초기화 고정을 "1분 뒤 조회 PTY 재시작 → 그 뒤 고정 메시지" 순서로 예약한다.
  // 감지 즉시 보내면 CLI가 아직 옛 창을 들고 있는 경계 구간(#52·#56에서 실측)에 걸려, 고정하려는
  // 창과 CLI가 인식하는 창이 어긋날 수 있다. 재시작으로 새 창을 잡은 뒤 보낸다.
  private scheduleKeepaliveAfterRestart(monitor: MonitorState, trigger: UsageKeepaliveTrigger): void {
    monitor.pendingKeepalive = prioritizeUsageKeepaliveTrigger(monitor.pendingKeepalive, trigger);
    monitor.keepaliveNotBeforeAt ??= Date.now() + KEEPALIVE_RESTART_DELAY_MS;
    if (monitor.keepaliveTimer) return;
    const retryAt = monitor.lastKeepaliveAttemptAt ? monitor.lastKeepaliveAttemptAt + KEEPALIVE_RETRY_INTERVAL_MS : 0;
    const delay = Math.max(0, Math.max(monitor.keepaliveNotBeforeAt, retryAt) - Date.now());
    monitor.keepaliveTimer = setTimeout(() => {
      monitor.keepaliveTimer = undefined;
      void this.restartThenSendKeepalive(monitor);
    }, delay);
    monitor.keepaliveTimer.unref();
  }

  // 같은 0% 에피소드의 성공 기록이 있으면 쿨다운 동안 PTY 재시작 자체를 예약하지 않는다.
  private isStoredUsageKeepaliveDue(monitor: MonitorState, trigger: UsageKeepaliveTrigger): boolean {
    const row = this.database.prepare("SELECT sent_at, window_key FROM usage_keepalive_prompts WHERE provider = ? AND account_id = ?")
      .get(monitor.adapter.id, monitor.account.id) as { sent_at: string; window_key: string | null } | undefined;
    return isUsageKeepaliveDue(row?.sent_at, row?.window_key, trigger.windowKey, new Date());
  }

  // 최신 정상 조회가 끝난 시점에 pending 작업을 조정한다. 실제 사용량이 이미 양수면 늦은 단답을
  // 취소하고, 타이머가 busy에 막힌 뒤라면 새 1분을 기다리지 않고 즉시 이어서 처리한다.
  private async reconcileKeepaliveAfterUsage(monitor: MonitorState, trigger: UsageKeepaliveTrigger | null): Promise<void> {
    if (monitor.keepaliveConfirmation) {
      const latest = this.database.prepare("SELECT details_json FROM usage_status WHERE provider = ? AND account_id = ? AND data_status = 'fresh'")
        .get(monitor.adapter.id, monitor.account.id) as { details_json: string | null } | undefined;
      const result = evaluateCodexKeepaliveConfirmation(monitor.keepaliveConfirmation, latest?.details_json);
      if (result.status === "confirmed") {
        this.confirmCodexUsageKeepalive(monitor, monitor.keepaliveConfirmation);
        return;
      }
      if (result.status === "retry") {
        usageLog.warn("keepalive_unconfirmed", { provider: monitor.adapter.id, accountId: monitor.account.id, reason: monitor.keepaliveConfirmation.trigger.reason });
        const confirmation = monitor.keepaliveConfirmation;
        monitor.keepaliveConfirmation = undefined;
        this.continueOrFinishCodexKeepalive(monitor, trigger, confirmation);
        return;
      }
      monitor.keepaliveConfirmation = result.confirmation;
      return;
    }
    const latestDetails = this.database.prepare("SELECT details_json FROM usage_status WHERE provider = ? AND account_id = ? AND data_status = 'fresh'")
      .get(monitor.adapter.id, monitor.account.id) as { details_json: string | null } | undefined;
    const pinned = monitor.adapter.id === "codex" ? pinnedCodexKeepaliveTrigger(latestDetails?.details_json) : null;
    if (pinned) {
      if (this.isStoredUsageKeepaliveDue(monitor, pinned)) {
        const sentAt = monitor.lastKeepaliveAttemptAt ? new Date(monitor.lastKeepaliveAttemptAt).toISOString() : new Date().toISOString();
        this.confirmCodexUsageKeepalive(monitor, { trigger: pinned, sentAt, targetWindowIds: ["five_hour"] });
      } else {
        if (monitor.keepaliveTimer) clearTimeout(monitor.keepaliveTimer);
        monitor.keepaliveTimer = undefined;
        monitor.pendingKeepalive = undefined;
        monitor.keepaliveNotBeforeAt = undefined;
        monitor.keepalivePromptAttempt = undefined;
      }
      return;
    }
    if (!trigger) {
      if (monitor.keepaliveTimer) clearTimeout(monitor.keepaliveTimer);
      monitor.keepaliveTimer = undefined;
      monitor.pendingKeepalive = undefined;
      monitor.keepaliveNotBeforeAt = undefined;
      monitor.keepalivePromptAttempt = undefined;
      return;
    }
    // 새 초기화의 keyed pending은 같은 0% 에피소드의 후속 폴링이 null 키만 돌려줘도 우선한다.
    // null 키로 DB 쿨다운을 먼저 검사하면 60초 폴링이 1분 실행 타이머를 지우는 운영 장애가 난다.
    const prioritizedTrigger = prioritizeUsageKeepaliveTrigger(monitor.pendingKeepalive, trigger);
    if (!this.isStoredUsageKeepaliveDue(monitor, prioritizedTrigger)) {
      if (monitor.keepaliveTimer) clearTimeout(monitor.keepaliveTimer);
      monitor.keepaliveTimer = undefined;
      monitor.pendingKeepalive = undefined;
      monitor.keepaliveNotBeforeAt = undefined;
      monitor.keepalivePromptAttempt = undefined;
      return;
    }
    monitor.pendingKeepalive = prioritizedTrigger;
    if (monitor.keepaliveNotBeforeAt === undefined) {
      this.scheduleKeepaliveAfterRestart(monitor, prioritizedTrigger);
      return;
    }
    const retryAt = monitor.lastKeepaliveAttemptAt ? monitor.lastKeepaliveAttemptAt + KEEPALIVE_RETRY_INTERVAL_MS : 0;
    if (!monitor.keepaliveTimer && Date.now() >= Math.max(monitor.keepaliveNotBeforeAt, retryAt)) {
      await this.restartThenSendKeepalive(monitor);
      return;
    }
    this.scheduleKeepaliveAfterRestart(monitor, prioritizedTrigger);
  }

  // 조회 PTY를 새로 띄운 뒤 고정 메시지를 보낸다. 실패하면 예약을 남겨 다음 조회 주기에 다시 시도한다.
  private async restartThenSendKeepalive(monitor: MonitorState): Promise<void> {
    // 응답 뒤 reset 안정성을 확인하는 동안에는 새 요청을 보내지 않는다. 안정 판정은 75초가
    // 필요한데 재시도 타이머는 60초라, 여기서 확인을 폐기하면 성공 판정 전에 매분 다시 보내게 된다.
    if (monitor.keepaliveConfirmation) {
      this.requestUsage(monitor);
      return;
    }
    if (monitor.keepaliveSendInFlight) return;
    let trigger = monitor.pendingKeepalive;
    if (!trigger) return;
    // 조회가 진행 중이면 끊지 않는다. finishUsage가 busy를 내린 직후 위 조정 함수를 호출해, 이미
    // 지난 not-before 시각의 같은 작업을 즉시 이어서 처리한다.
    if (monitor.busy) return;
    // fallback·로딩의 보존 숫자로 고정을 보내면 안 되지만, 세션 0%·Resets 없음처럼
    // 현재 화면에서 잡은 고정 사유는 fresh가 아니어도 보낸다.
    if (monitor.usageObservationFresh === false && !monitor.usageKeepaliveTrusted) return;
    const latest = this.database.prepare("SELECT details_json FROM usage_status WHERE provider = ? AND account_id = ? AND data_status = 'fresh'")
      .get(monitor.adapter.id, monitor.account.id) as { details_json: string | null } | undefined;
    // 마지막 조회가 fallback·로딩·파싱 실패라면 보존된 숫자가 양수인지 0%인지 현재 상태를 확정할
    // 수 없다. pending은 지우지 않되 비용이 드는 턴도 보내지 않고 다음 fresh 관측이 재개하게 한다.
    if (latest) {
      const latestTrigger = detectUsageKeepaliveTrigger(monitor.adapter.id, latest.details_json, latest.details_json, new Date());
      if (!latestTrigger) {
        monitor.pendingKeepalive = undefined;
        monitor.keepaliveNotBeforeAt = undefined;
        return;
      }
      // 최초 양수→0% 전환에서 만든 새 창 키는 latest/latest 재검사로는 다시 만들 수 없다. 예약된
      // 키를 유지해야 직전 5시간 쿨다운이 이번 새 초기화까지 막지 않는다.
      trigger = trigger.windowKey && !latestTrigger.windowKey
        ? { ...latestTrigger, windowKey: trigger.windowKey }
        : latestTrigger;
      monitor.pendingKeepalive = trigger;
    }
    if ((monitor.keepalivePromptAttempt ?? 0) >= CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS) {
      this.continueOrFinishCodexKeepalive(monitor, trigger);
      return;
    }
    monitor.keepaliveSendInFlight = true;
    monitor.lastKeepaliveAttemptAt = Date.now();
    this.recycleTerminal(monitor);
    // 새 PTY가 준비될 시간을 준다. 고정 메시지는 별도 임시 PTY로 나가므로 여기서 엄밀히 기다릴
    // 필요는 없고, 조회 PTY가 새 창을 읽기 시작하는 것만 보장하면 된다.
    try {
      await wait(5_000);
      // 실패하면 예약을 남겨 다음 조회 주기에 다시 시도한다(로그·DB 롤백은 그쪽에서 처리한다).
      const result = await this.maybeSendUsageKeepalive(monitor, trigger);
      if (result === true) {
        monitor.pendingKeepalive = undefined;
        monitor.keepaliveNotBeforeAt = undefined;
        monitor.keepalivePromptAttempt = undefined;
      } else if (result === false) {
        if (monitor.adapter.id === "codex") {
          this.continueOrFinishCodexKeepalive(monitor, trigger);
          return;
        }
        monitor.keepaliveNotBeforeAt = Date.now() + KEEPALIVE_RETRY_INTERVAL_MS;
        this.scheduleKeepaliveAfterRestart(monitor, trigger);
      } else {
        // 응답은 왔지만 사용량 사후 확인 전이다. 10초 뒤 조회만 당기며, 확인 결과가 명시적으로
        // retry일 때에만 1분 뒤 긴 문구를 보낸다. 확인 중에는 비용이 드는 exec를 예약하지 않는다.
        monitor.keepaliveNotBeforeAt = undefined;
        if (monitor.keepaliveVerificationTimer) clearTimeout(monitor.keepaliveVerificationTimer);
        monitor.keepaliveVerificationTimer = setTimeout(() => {
          monitor.keepaliveVerificationTimer = undefined;
          this.requestUsage(monitor);
        }, KEEPALIVE_VERIFY_DELAY_MS);
        monitor.keepaliveVerificationTimer.unref();
      }
    } finally {
      monitor.keepaliveSendInFlight = false;
    }
  }

  // 확인 실패 뒤 다음 시도가 남아 있으면 1분 뒤 재시도하고, 10회를 다 쓰면 현재 창을 기록하고 멈춘다.
  private continueOrFinishCodexKeepalive(
    monitor: MonitorState,
    trigger: UsageKeepaliveTrigger | null | undefined,
    confirmation?: CodexKeepaliveConfirmation,
  ): void {
    const completedAttempt = monitor.keepalivePromptAttempt ?? 0;
    if (!usageKeepaliveHasRemainingAttempts(monitor.adapter.id, completedAttempt)) {
      const finished = confirmation ?? (trigger ? {
        trigger,
        sentAt: monitor.lastKeepaliveAttemptAt ? new Date(monitor.lastKeepaliveAttemptAt).toISOString() : new Date().toISOString(),
        targetWindowIds: [],
      } : null);
      if (finished) {
        this.confirmCodexUsageKeepalive(monitor, finished);
        this.notifyCodexKeepaliveExhausted(monitor, finished);
      } else {
        monitor.pendingKeepalive = undefined;
        monitor.keepaliveNotBeforeAt = undefined;
        monitor.keepalivePromptAttempt = undefined;
      }
      return;
    }
    monitor.keepalivePromptAttempt = completedAttempt + 1;
    monitor.keepaliveNotBeforeAt = Date.now() + KEEPALIVE_RETRY_INTERVAL_MS;
    if (trigger) this.scheduleKeepaliveAfterRestart(monitor, trigger);
  }

  // 10회를 다 썼는데도 창이 안 고정되면 기존 운영 알림 채널로 알린다.
  private notifyCodexKeepaliveExhausted(monitor: MonitorState, confirmation: CodexKeepaliveConfirmation): void {
    const label = monitor.adapter.displayLabel ?? "Codex";
    const title = `${label} 세션 유지 실패`;
    const body = `${label} keepalive를 ${CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS}회 보냈지만 5시간 창이 확정되지 않았습니다.`;
    const eventId = `usage-keepalive-exhausted:${monitor.adapter.id}:${monitor.account.id}:${confirmation.trigger.windowKey ?? confirmation.sentAt}`;
    usageLog.warn("keepalive_attempts_exhausted", {
      provider: monitor.adapter.id,
      accountId: monitor.account.id,
      attempts: CODEX_USAGE_KEEPALIVE_MAX_ATTEMPTS,
    });
    void this.notifications?.notify(eventId, "usage_keepalive_exhausted", body, { title });
    this.realtime.broadcast("usage_keepalive_exhausted", {
      provider: monitor.adapter.id,
      accountId: monitor.account.id,
      title,
      body,
    });
  }

  private confirmCodexUsageKeepalive(monitor: MonitorState, confirmation: CodexKeepaliveConfirmation): void {
    this.database.prepare(`
      INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at, window_key) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_id) DO UPDATE SET reason = excluded.reason, sent_at = excluded.sent_at, window_key = excluded.window_key
    `).run(monitor.adapter.id, monitor.account.id, confirmation.trigger.reason, confirmation.sentAt, confirmation.trigger.windowKey);
    if (monitor.keepaliveTimer) clearTimeout(monitor.keepaliveTimer);
    if (monitor.keepaliveVerificationTimer) clearTimeout(monitor.keepaliveVerificationTimer);
    monitor.keepaliveTimer = undefined;
    monitor.keepaliveVerificationTimer = undefined;
    monitor.pendingKeepalive = undefined;
    monitor.keepaliveConfirmation = undefined;
    monitor.keepaliveNotBeforeAt = undefined;
    monitor.keepalivePromptAttempt = undefined;
    monitor.keepaliveSendInFlight = undefined;
    usageLog.info("keepalive_confirmed", { provider: monitor.adapter.id, accountId: monitor.account.id, reason: confirmation.trigger.reason });
    this.realtime.broadcast("usage_updated", { provider: monitor.adapter.id, accountId: monitor.account.id });
  }

  // 조회 PTY를 지금 끊어 새 프로세스로 갈아탄다. onExit이 recycling을 보고 곧바로 다시 띄운다.
  private recycleTerminal(monitor: MonitorState): void {
    if (monitor.recycling || !monitor.terminal) return;
    monitor.recycling = true;
    monitor.terminal.kill();
  }

  // 조회 PTY 수명이 다했으면 이번 주기를 건너뛰고 새 프로세스로 갈아탄다(MONITOR_PTY_MAX_AGE_MS 참고).
  // 조회 중(busy)에는 건드리지 않고 다음 주기에 처리해, 진행 중인 파싱을 끊지 않는다.
  private recycleTerminalIfAged(monitor: MonitorState): boolean {
    const now = Date.now();
    if (monitor.recycling || !isMonitorTerminalAged(monitor.terminalStartedAt, now)) return false;
    usageLog.info("pty_recycled", { provider: monitor.adapter.id, accountId: monitor.account.id, ageMinutes: Math.round((now - monitor.terminalStartedAt!) / 60_000) });
    this.recycleTerminal(monitor);
    return true;
  }

  // 중복 실행을 막고 공급자별 실제 슬래시 명령을 순서대로 전달한다.
  private requestUsage(monitor: MonitorState, force = false): void {
    if (monitor.busy) return;
    if (!force && monitor.usagePollNotBeforeAt && Date.now() < monitor.usagePollNotBeforeAt) return;
    if (monitor.terminal && this.recycleTerminalIfAged(monitor)) return;
    monitor.busy = true;
    monitor.commandIndex = 0;
    monitor.collectUsageDetails = false;
    this.update(monitor, { monitor_status: "refreshing", last_checked_at: new Date().toISOString() });
    if (monitor.adapter.collectUsage) {
      void monitor.adapter.collectUsage({ environment: this.accounts.environment(monitor.account) }).then(
        (collection) => this.finishUsageRecord(monitor, collection.record, collection.snapshot, "direct"),
        (error) => {
          usageLog.warn("direct_failed_pty_fallback", {
            provider: monitor.adapter.id,
            accountId: monitor.account.id,
            error: error instanceof Error ? error.message : String(error),
          });
          this.beginPtyUsageFallback(monitor);
        },
      );
      return;
    }
    this.beginPtyUsageFallback(monitor);
  }

  // 직접 API/RPC가 실패한 경우에만 기존 slash-command TUI 수집기로 내려간다. Codex의 초기화권
  // 상세 메뉴는 이 폴백 경로에서만 1시간 제한을 적용한다.
  private beginPtyUsageFallback(monitor: MonitorState): void {
    void this.ensureProviderTerminal(monitor).then(() => {
      const now = Date.now();
      monitor.commandIndex = 0;
      monitor.collectUsageDetails = !!monitor.adapter.usageDetails && isUsageDetailsDue(monitor.usageDetailsCheckedAt, now);
      if (monitor.collectUsageDetails) monitor.usageDetailsCheckedAt = now;
      monitor.screen.reset();
      this.runNextCommand(monitor);
    }).catch((error) => {
      monitor.busy = false;
      usageLog.warn("pty_fallback_failed", {
        provider: monitor.adapter.id,
        accountId: monitor.account.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.update(monitor, { monitor_status: "error", data_status: "stale", error_code: "cli_exited" });
      this.scheduleRestart(monitor);
    });
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
    const rawParsed = monitor.adapter.parseUsage(screenText);
    // TODO(임시 상세 로그): 사용량 파싱 오판 추적용. 안정화되면 제거하거나 레벨을 낮춘다.
    usageLog.debug("parse", { provider: monitor.adapter.id, out: rawParsed, in: screenText });
    await this.finishUsageRecord(monitor, rawParsed, screenText, "pty");
  }

  // 구조화 direct 결과와 PTY parser 결과에 동일한 stale 보호·DB·알림·keepalive 정책을 적용한다.
  private async finishUsageRecord(
    monitor: MonitorState,
    rawParsed: Partial<UsageRecord>,
    snapshotText: string,
    source: UsageCollectionSource,
  ): Promise<void> {
    monitor.lastSnapshot = { text: snapshotText, capturedAt: new Date().toISOString() };
    // 같은 리셋 시각의 창에서 사용량이 줄었다면 CLI가 돌려준 옛 스냅샷이므로, 이 값으로 마지막
    // 정상값을 덮어쓰지 않고 stale 표시만 남긴다(detectUsageRegression 참고). 다음 주기에 CLI가
    // 다시 최신 값을 주면 퍼센트가 증가 방향이라 그대로 통과돼 자동 복구된다.
    const previous = this.database.prepare("SELECT details_json, reset_at FROM usage_status WHERE provider = ? AND account_id = ?")
      .get(monitor.adapter.id, monitor.account.id) as { details_json: string | null; reset_at: string | null } | undefined;
    // Claude TUI만 겪는 "리셋 시각이 지나도 예전 스냅샷을 계속 돌려줌" 보정이다. OAuth API가
    // 돌려준 절대 ISO 시각에는 날짜 없는 화면용 오늘/내일 추측을 적용하지 않는다.
    let parsed = monitor.adapter.id === "claude" && source === "pty"
      ? reconcileStaleClaudeSessionWindow(rawParsed, new Date(), previous?.details_json)
      : rawParsed;
    // 오직 오류 코드 없는 fresh만 권위 있는 직접 관측이다. stale/unavailable 화면에 정상 모양 숫자가
    // 있어도 DB·알림·keepalive에 절대 채택하지 않는 공급자 공통 불변조건으로 둔다.
    const authoritativeFresh = parsed.data_status === "fresh" && parsed.error_code == null;
    monitor.usageObservationFresh = authoritativeFresh;
    monitor.usageKeepaliveTrusted = authoritativeFresh;
    if (authoritativeFresh) {
      monitor.failureCount = 0;
      monitor.usageFallbackStreak = 0;
      monitor.usagePollNotBeforeAt = undefined;
    }
    // TODO(임시 상세 로그): 리셋 직후 reset_at 표기가 폴링마다 안정화되기 전까지 계속 바뀌는지
    // 추적하기 위한 로그. 리셋 시각이 실제로 몇 번의 폴링만에 고정되는지 확인되면 제거한다.
    if (authoritativeFresh && previous?.reset_at && rawParsed.reset_at && previous.reset_at !== rawParsed.reset_at) {
      usageLog.info("reset_at_changed", { provider: monitor.adapter.id, accountId: monitor.account.id, from: previous.reset_at, to: rawParsed.reset_at });
    }
    if (monitor.adapter.id === "codex" && rawParsed.details_json) {
      const resetCredits = source === "pty" && monitor.collectUsageDetails
        ? await readCodexResetCredits(this.accounts.environment(monitor.account))
        : null;
      rawParsed.details_json = mergeCodexResetCredits(rawParsed.details_json, resetCredits, previous?.details_json);
    }
    let keepaliveTrigger: UsageKeepaliveTrigger | null = null;
    let keepaliveObservationAccepted = false;
    if (!authoritativeFresh) {
      // non-fresh가 사이에 끼면 감소 거부는 연속이 아니다. 과거처럼 streak 4가 남아 다음 한 번의
      // 낮은 값에서 강제 채택되는 경로를 없앤다.
      monitor.rejectedStreak = 0;
      if (monitor.adapter.id === "claude" && isClaudeUsageFallbackError(parsed.error_code)) {
        monitor.usageFallbackStreak = (monitor.usageFallbackStreak ?? 0) + 1;
        monitor.usagePollNotBeforeAt = Date.now() + claudeUsageBackoffMs(monitor.usageFallbackStreak);
      }
      this.update(monitor, {
        monitor_status: parsed.data_status === "unavailable" ? "error" : "ready",
        data_status: previous?.details_json ? "stale" : parsed.data_status,
        error_code: parsed.error_code ?? null,
      });
      // 세션 블록 누락이나 0%·Resets 없음은 숫자를 덮지 않지만, 초기화 고정은 현재 화면으로 계산한다.
      if (monitor.adapter.id === "claude" && parsed.details_json && !isClaudeUsageFallbackError(parsed.error_code) && parsed.error_code !== "usage_refreshing") {
        keepaliveTrigger = detectUsageKeepaliveTrigger(monitor.adapter.id, previous?.details_json, parsed.details_json);
        keepaliveObservationAccepted = !!keepaliveTrigger;
        if (keepaliveTrigger) monitor.usageKeepaliveTrusted = true;
      }
    } else {
      // 세션 리셋 시각이 물리적으로 불가능할 만큼 먼 값(5시간짜리 롤링 윈도우인데 8시간 넘게 남음 등)도
      // 옛 스냅샷과 같은 종류의 오검출이라 같은 방식(stale만 남기고 마지막 정상값 유지)으로 처리한다.
      const implausibleSessionReset = monitor.adapter.id === "claude" && isImplausibleClaudeSessionReset(parsed.details_json, new Date());
      const decision = implausibleSessionReset
        ? { kind: "reject" as const, zeroConfirm: { streak: 0, recycled: false } }
        : decideFreshUsageAdoption(parsed, previous?.details_json, monitor.adapter.usageWindowId, {
          streak: monitor.zeroConfirmStreak ?? 0,
          recycled: !!monitor.zeroConfirmRecycled,
        });
      monitor.zeroConfirmStreak = decision.zeroConfirm.streak;
      monitor.zeroConfirmRecycled = decision.zeroConfirm.recycled;
      if (decision.kind === "reject") {
        monitor.rejectedStreak += 1;
        if (monitor.rejectedStreak >= REJECTED_ADOPT_STREAK) {
          usageLog.warn("rejected-recheck", { provider: monitor.adapter.id, accountId: monitor.account.id, streak: monitor.rejectedStreak, out: parsed });
          monitor.rejectedStreak = 0;
          this.recycleTerminal(monitor);
        }
        this.update(monitor, { monitor_status: "ready", data_status: "stale", error_code: null });
      } else {
        monitor.rejectedStreak = 0;
        parsed = decision.record;
        if (decision.kind === "hold-zero" && decision.recycle) {
          usageLog.info("zero-confirm-recheck", { provider: monitor.adapter.id, accountId: monitor.account.id, streak: decision.zeroConfirm.streak });
          this.recycleTerminal(monitor);
        }
        this.update(monitor, {
          ...parsed,
          monitor_status: "ready",
          last_success_at: new Date().toISOString(),
        });
        if (monitor.adapter.id === "codex" && source === "direct") {
          this.notifyCodexResetCreditsChanged(monitor, previous?.details_json, parsed.details_json);
        }
        this.resetNotifier?.observe(monitor.adapter.id, parsed.details_json, new Date(), monitor.account.id);
        keepaliveTrigger = detectUsageKeepaliveTrigger(monitor.adapter.id, previous?.details_json, parsed.details_json);
        keepaliveObservationAccepted = true;
      }
    }
    monitor.collectUsageDetails = false;
    if (!monitor.recycling) monitor.terminal?.write("\u001b");
    monitor.busy = false;
    if (source === "pty") this.closeProviderTerminal(monitor);
    if (keepaliveObservationAccepted) await this.reconcileKeepaliveAfterUsage(monitor, keepaliveTrigger);
  }

  // 첫 관측은 기준선만 만들고, 이후 direct app-server의 개수 또는 가장 이른 만료가 실제로 달라진
  // 경우에만 외부 알림과 브라우저 이벤트를 보낸다. PTY fallback의 불완전 값은 알림 근거로 쓰지 않는다.
  private notifyCodexResetCreditsChanged(
    monitor: MonitorState,
    previousDetailsJson: string | null | undefined,
    currentDetailsJson: string | null | undefined,
  ): void {
    let previous: CodexResetCredits | null = null;
    let current: CodexResetCredits | null = null;
    try {
      previous = previousDetailsJson ? storedCodexResetCredits(JSON.parse(previousDetailsJson) as Record<string, unknown>) : null;
      current = currentDetailsJson ? storedCodexResetCredits(JSON.parse(currentDetailsJson) as Record<string, unknown>) : null;
    } catch {
      return;
    }
    if (!previous || !current) return;
    if (previous.availableCount === current.availableCount && previous.expiresAt === current.expiresAt) return;
    const title = "Codex 초기화권 변경";
    const expiry = current.expiresAt ? ` · 가장 이른 만료 ${current.expiresAt}` : "";
    const body = `Codex 초기화권이 ${previous.availableCount}개에서 ${current.availableCount}개로 변경되었습니다${expiry}.`;
    const eventId = `codex-reset-credits:${monitor.account.id}:${current.availableCount}:${current.expiresAt ?? "none"}`;
    void this.notifications?.notify(eventId, "codex_reset_credits_changed", body, { title });
    this.realtime.broadcast("codex_reset_credits_changed", {
      provider: "codex",
      accountId: monitor.account.id,
      previous,
      current,
      title,
      body,
    });
  }

  // 계정별 초기화 창 중복 기록을 DB에서 확인하고 조회 PTY에 최소 단답 턴을 보낸다.
  // 실제로 보냈거나 보낼 필요가 없으면 true, 실패면 false, Codex 사후 확인 중이면 별도 상태를 돌려준다.
  private async maybeSendUsageKeepalive(monitor: MonitorState, trigger: UsageKeepaliveTrigger): Promise<boolean | "awaiting_confirmation"> {
    const row = this.database.prepare("SELECT reason, sent_at, window_key FROM usage_keepalive_prompts WHERE provider = ? AND account_id = ?")
      .get(monitor.adapter.id, monitor.account.id) as { reason: UsageKeepaliveReason; sent_at: string; window_key: string | null } | undefined;
    const now = new Date();
    if (!row?.window_key && row?.sent_at && trigger.windowKey && isLegacyKeepaliveFromCurrentWindow(row.sent_at, trigger.windowKey)) {
      this.database.prepare("UPDATE usage_keepalive_prompts SET window_key = ? WHERE provider = ? AND account_id = ? AND window_key IS NULL")
        .run(trigger.windowKey, monitor.adapter.id, monitor.account.id);
      return true;
    }
    if (!isUsageKeepaliveDue(row?.sent_at, row?.window_key, trigger.windowKey, now)) return true;
    const sentAt = now.toISOString();
    try {
      await this.sendUsageKeepalivePrompt(monitor, monitor.keepalivePromptAttempt ?? 0);
      if (monitor.adapter.id === "codex") {
        const latest = this.database.prepare("SELECT details_json FROM usage_status WHERE provider = ? AND account_id = ? AND data_status = 'fresh'")
          .get(monitor.adapter.id, monitor.account.id) as { details_json: string | null } | undefined;
        const targetWindowIds = parseWindows(latest?.details_json)
          .filter((window) => (window.id === "five_hour" || window.id === "weekly") && window.usedPercent === 0)
          .map((window) => window.id);
        const confirmation = { trigger, sentAt, targetWindowIds };
        // 전송을 마치는 사이 실제 대화가 먼저 창을 1% 이상으로 올렸다면 확인할 0% 대상이 없다.
        // 방금 보낸 기록은 남기되 불필요한 확인·재시도는 만들지 않는다.
        if (!targetWindowIds.length) {
          this.confirmCodexUsageKeepalive(monitor, confirmation);
          return true;
        }
        monitor.keepaliveConfirmation = confirmation;
        usageLog.info("keepalive_awaiting_confirmation", { provider: monitor.adapter.id, accountId: monitor.account.id, reason: trigger.reason, targetWindowIds });
        return "awaiting_confirmation";
      }
      this.database.prepare(`
        INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at, window_key) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, account_id) DO UPDATE SET reason = excluded.reason, sent_at = excluded.sent_at, window_key = excluded.window_key
      `).run(monitor.adapter.id, monitor.account.id, trigger.reason, sentAt, trigger.windowKey);
      usageLog.info("keepalive", { provider: monitor.adapter.id, accountId: monitor.account.id, reason: trigger.reason });
      this.realtime.broadcast("usage_updated", { provider: monitor.adapter.id, accountId: monitor.account.id });
      return true;
    } catch (error) {
      usageLog.warn("keepalive_failed", { provider: monitor.adapter.id, accountId: monitor.account.id, reason: trigger.reason, error });
      return false;
    }
  }

  // Codex 고정 턴은 격리 exec로 보낸다. 대화형 TUI는 스레드만 열고 모델 턴을 제출하지 못했다.
  private async sendUsageKeepalivePrompt(monitor: MonitorState, retryOrAttempt: boolean | number = false): Promise<void> {
    const attempt = typeof retryOrAttempt === "number" ? retryOrAttempt : (retryOrAttempt ? Math.max(1, monitor.keepalivePromptAttempt ?? 1) : (monitor.keepalivePromptAttempt ?? 0));
    if (monitor.adapter.id === "codex") {
      const startedAt = Date.now();
      const summary = await this.runCodexKeepalive({
        command: monitor.adapter.createLaunch(os.tmpdir()).command,
        env: { ...process.env, ...this.accounts.environment(monitor.account) } as Record<string, string>,
        prompt: usageKeepalivePrompt(monitor.adapter.id, attempt),
        minimumResponseChars: usageKeepaliveMinimumResponseChars(monitor.adapter.id, attempt),
      });
      usageLog.info("keepalive_exec_completed", {
        provider: monitor.adapter.id,
        accountId: monitor.account.id,
        attempt,
        elapsedMs: Date.now() - startedAt,
        responseChars: summary.responseChars,
      });
      return;
    }
    const terminal = this.spawnProviderTerminal(monitor);
    const screen = new TerminalScreen();
    let exited = false;
    terminal.onData((data) => screen.write(data));
    terminal.onExit(() => { exited = true; });
    try {
      // 15초로는 Codex가 뜨기 전에 포기해 초기화 고정이 통째로 실패했다(실측 #57: keepalive_failed
      // "세션 유지용 터미널이 준비되지 않았습니다"가 반복되고 그 창은 끝내 고정되지 못함).
      // 초기화 창마다 한 번뿐인 동작이라 넉넉히 기다리는 편이 비용이 훨씬 싸다.
      const readyDeadline = Date.now() + KEEPALIVE_READY_TIMEOUT_MS;
      while (!exited && !monitor.adapter.isReady(screen.text()) && Date.now() < readyDeadline) await wait(100);
      if (exited || !monitor.adapter.isReady(screen.text())) throw new Error("세션 유지용 터미널이 준비되지 않았습니다.");
      await wait(250);
      screen.reset();
      terminal.write(usageKeepalivePrompt(monitor.adapter.id, attempt));
      await wait(monitor.adapter.promptQuirks?.pasteSubmitDelayMs ?? 160);
      // Enter를 누르기 전, 프롬프트 에코만 있는 상태를 기준선으로 잡는다. Enter 뒤에 잡으면 에코가
      // 그대로 "응답이 왔다"로 읽히고, 반대로 응답이 아주 빨리 끝나면 기준선에 응답까지 들어가
      // 증가가 안 보인다.
      const baseline = screen.text().trim();
      terminal.write("\r");
      const startedAt = Date.now();
      const deadline = startedAt + 30_000;
      let retried = false;
      let sawBusy = false;
      while (!exited && Date.now() < deadline) {
        const snapshot = screen.text();
        const busy = monitor.adapter.isBusy(snapshot);
        if (busy) sawBusy = true;
        // 예전에는 고정 프롬프트에 맞춰 정확히 "1"인 줄을 찾았는데, 프롬프트가 바뀌면 그대로 깨진다.
        // 무엇을 물었든 모델이 턴을 돌면 기준선(프롬프트 에코만 있는 화면)보다 내용이 늘어나므로
        // 그것으로 판정한다(#57). 조기 판정은 아래 300ms 하한이 막는다.
        const answered = screen.text().trim().length > baseline.length;
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
