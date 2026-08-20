import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface CodexResetCredits {
  availableCount: number;
  expiresAt: string | null;
}

interface CodexRateLimitMessage {
  id?: number;
  error?: unknown;
  result?: {
    rateLimitResetCredits?: {
      availableCount?: unknown;
      credits?: unknown;
    } | null;
    outcome?: unknown;
  };
}

export type CodexResetCreditConsumeOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface CodexResetCreditConsumeResult {
  outcome: CodexResetCreditConsumeOutcome;
  before: CodexResetCredits;
  after: CodexResetCredits | null;
}

interface CodexResetCreditSelection {
  credits: CodexResetCredits;
  creditId: string | null;
}

type CodexAppServerRequest = (method: string, params: Record<string, unknown>) => Promise<CodexRateLimitMessage | null>;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// 실행 루트 package.json의 버전을 Codex app-server clientInfo에 사용한다.
export function codexAppServerClientVersion(rootDir = process.cwd()): string {
  const value = (JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown }).version;
  if (typeof value !== "string" || !value.trim()) throw new Error("package.json 버전을 확인할 수 없습니다.");
  return value;
}

// Codex `/usage` 초기화권 상세 화면에서 개수와 Full reset 기한을 추출한다.
export function parseCodexResetCreditsScreen(screen: string): CodexResetCredits | null {
  const countMatch = screen.match(/(\d+)\s+usage limit resets?\s+available/i);
  if (!countMatch) return null;
  const availableCount = Number(countMatch[1]);
  const expiry = screen.match(/Full reset\s+Expires\s+(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i);
  if (!expiry) return { availableCount, expiresAt: null };
  const month = MONTHS[expiry[4].toLowerCase()];
  if (month === undefined) return { availableCount, expiresAt: null };
  const year = Number(expiry[5]);
  const day = Number(expiry[3]);
  const hour = Number(expiry[1]);
  const minute = Number(expiry[2]);
  const expiresAt = new Date(year, month, day, hour, minute, 0, 0);
  const valid = expiresAt.getFullYear() === year && expiresAt.getMonth() === month && expiresAt.getDate() === day
    && expiresAt.getHours() === hour && expiresAt.getMinutes() === minute;
  return { availableCount, expiresAt: valid ? expiresAt.toISOString() : null };
}

// 초기화권 상세가 로딩을 끝내고 기한 또는 0개 결과까지 그려졌는지 확인한다.
export function isCodexResetCreditsScreenReady(screen: string): boolean {
  const parsed = parseCodexResetCreditsScreen(screen);
  return !!parsed && (parsed.availableCount === 0 || !!parsed.expiresAt);
}

// app-server 응답에서 초기화권 개수와 가장 이른 만료 시각만 안전하게 추린다.
export function parseCodexResetCredits(message: unknown): CodexResetCredits | null {
  if (!message || typeof message !== "object") return null;
  const payload = message as CodexRateLimitMessage;
  const resetCredits = payload.result?.rateLimitResetCredits;
  if (!resetCredits || !Number.isInteger(resetCredits.availableCount) || Number(resetCredits.availableCount) < 0) return null;
  const credits = Array.isArray(resetCredits.credits) ? resetCredits.credits : [];
  const expirations = credits
    .filter((credit): credit is Record<string, unknown> => !!credit && typeof credit === "object" && (credit as Record<string, unknown>).status === "available")
    .map((credit) => Number(credit.expiresAt))
    .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > 0)
    .sort((a, b) => a - b);
  return {
    availableCount: Number(resetCredits.availableCount),
    expiresAt: expirations.length ? new Date(expirations[0] * 1_000).toISOString() : null,
  };
}

// app-server 응답 순서에서 맨 위의 사용 가능한 초기화권 ID를 고른다.
export function selectCodexResetCredit(message: unknown): CodexResetCreditSelection | null {
  const credits = parseCodexResetCredits(message);
  if (!credits) return null;
  const payload = message as CodexRateLimitMessage;
  const rows = payload.result?.rateLimitResetCredits?.credits;
  const first = Array.isArray(rows)
    ? rows.find((row) => !!row && typeof row === "object" && (row as Record<string, unknown>).status === "available") as Record<string, unknown> | undefined
    : undefined;
  return { credits, creditId: typeof first?.id === "string" && first.id ? first.id : null };
}

// app-server 초기화권 사용 응답의 확정 결과만 허용 목록으로 파싱한다.
export function parseCodexResetCreditConsumeOutcome(message: unknown): CodexResetCreditConsumeOutcome | null {
  if (!message || typeof message !== "object") return null;
  const outcome = (message as CodexRateLimitMessage).result?.outcome;
  return outcome === "reset" || outcome === "nothingToReset" || outcome === "noCredit" || outcome === "alreadyRedeemed" ? outcome : null;
}

// app-server 요청 하나를 초기화부터 응답 수신까지 수행하고 프로세스를 즉시 정리한다.
function requestCodexAppServer(environment: Record<string, string>, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<CodexRateLimitMessage | null> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server"], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffered = "";
    const finish = (result: CodexRateLimitMessage | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    child.stdin.once("error", () => finish(null));
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as CodexRateLimitMessage;
          if (message.id === 1) finish(message.error ? null : message);
        } catch {
          // app-server의 비 JSON 진단 행은 무시하고 요청 응답만 기다린다.
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 0, params: { clientInfo: { name: "web_agent_manager", title: "web-agent-manager", version: codexAppServerClientVersion() } } })}\n${JSON.stringify({ method: "initialized", params: {} })}\n${JSON.stringify({ method, id: 1, params })}\n`);
  });
}

// 현재 Codex 계정의 구조화된 한도 정보를 읽는다.
export async function readCodexResetCredits(environment: Record<string, string>, timeoutMs = 5_000): Promise<CodexResetCredits | null> {
  return parseCodexResetCredits(await requestCodexAppServer(environment, "account/rateLimits/read", {}, timeoutMs));
}

// 맨 위의 사용 가능한 초기화권 하나를 공식 app-server 메서드로 사용하고 잔여량을 다시 읽는다.
export async function consumeCodexResetCredit(environment: Record<string, string>, requester?: CodexAppServerRequest): Promise<CodexResetCreditConsumeResult> {
  const request = requester ?? ((method, params) => requestCodexAppServer(environment, method, params, 10_000));
  const selection = selectCodexResetCredit(await request("account/rateLimits/read", {}));
  if (!selection) throw new Error("Codex 초기화권 정보를 확인할 수 없습니다.");
  if (selection.credits.availableCount < 1) throw new Error("사용 가능한 Codex 초기화권이 없습니다.");
  const params: Record<string, unknown> = { idempotencyKey: randomUUID() };
  if (selection.creditId) params.creditId = selection.creditId;
  const consumeResponse = await request("account/rateLimitResetCredit/consume", params);
  let outcome = parseCodexResetCreditConsumeOutcome(consumeResponse);
  const after = parseCodexResetCredits(await request("account/rateLimits/read", {}));
  // 사용 응답만 시간 초과됐더라도 잔여량이 실제 감소했다면 같은 요청의 성공으로 복구한다.
  if (!outcome && after && after.availableCount < selection.credits.availableCount) outcome = "reset";
  if (!outcome) throw new Error("Codex 초기화권 사용 결과를 확인할 수 없습니다.");
  return { outcome, before: selection.credits, after };
}
