import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "./auth";
import { readProductEnv } from "./config";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];
// 디버그 레벨에서는 조회 화면 전체가 매분 쌓여 하루 수백 MB까지 커진다(실측: 8/9자 200MB).
// 그 상태로 오래 운용하기 위해 보존 기간을 짧게 잡고, 필요하면 환경변수로 늘린다.
const DEFAULT_KEEP_DAYS = 3;
// 정리를 서버 시작 때 한 번만 돌리면 오래 켜둔 서버에서는 계속 쌓인다. 주기적으로도 돌린다.
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_DETAIL_LENGTH = 4000;

let logsDir = "";
let minLevel: LogLevel = "debug";
// console 티(tee) 재진입을 막기 위해 원본 콘솔 함수를 보관한다.
const rawConsole = { log: console.log.bind(console), info: console.info.bind(console), warn: console.warn.bind(console), error: console.error.bind(console), debug: console.debug.bind(console) };

// 실행 환경에 따라 production은 info, 개발·테스트는 debug를 기본 로그 레벨로 정한다.
export function defaultLogLevel(nodeEnv: string | undefined): LogLevel {
  return nodeEnv === "production" ? "info" : "debug";
}

// 로그 레벨이 현재 최소 레벨 이상인지 판단한다.
function levelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(minLevel);
}

// 객체를 순환 참조·길이 제한을 지키며 한 줄 JSON으로 만든다.
function safeJson(value: unknown): string {
  try {
    const seen = new Set<unknown>();
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      if (typeof item === "bigint") return String(item);
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
      return item;
    });
    return text && text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text ?? "";
  } catch {
    return "[unserializable]";
  }
}

// 날짜별 로그 파일 경로를 돌려준다.
function fileFor(kind: "server" | "client"): string {
  return path.join(logsDir, `${kind}-${new Date().toISOString().slice(0, 10)}.log`);
}

// 로그 한 줄을 파일에 비동기로 덧붙인다(파일 실패는 무시해 앱 동작에 영향 없음).
function appendLine(kind: "server" | "client", line: string): void {
  if (!logsDir) return;
  fs.appendFile(fileFor(kind), `${line}\n`, { mode: 0o600 }, () => {});
}

// 표준 형식(시각 레벨 [범위] 메시지 상세)으로 로그 한 줄을 만든다.
function formatLine(level: LogLevel, scope: string, message: string, details?: unknown): string {
  const suffix = details === undefined ? "" : ` ${safeJson(details)}`;
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;
}

// 콘솔과 서버 로그 파일에 동시에 기록한다.
function write(level: LogLevel, scope: string, message: string, details?: unknown): void {
  if (!levelEnabled(level)) return;
  const line = formatLine(level, scope, message, details);
  (level === "debug" ? rawConsole.debug : rawConsole[level])(line);
  appendLine("server", line);
}

export interface ScopedLogger {
  debug: (message: string, details?: unknown) => void;
  info: (message: string, details?: unknown) => void;
  warn: (message: string, details?: unknown) => void;
  error: (message: string, details?: unknown) => void;
}

// 범위(scope) 이름이 붙은 로거를 만든다.
export function createLogger(scope: string): ScopedLogger {
  return {
    debug: (message, details) => write("debug", scope, message, details),
    info: (message, details) => write("info", scope, message, details),
    warn: (message, details) => write("warn", scope, message, details),
    error: (message, details) => write("error", scope, message, details),
  };
}

// 보존 기간을 정한다. 환경변수로 덮어쓸 수 있고, 값이 이상하면 기본값을 쓴다.
export function keepDays(): number {
  const configured = Number(readProductEnv("LOG_KEEP_DAYS"));
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_KEEP_DAYS;
}

// 지정 디렉터리에서 기준 시각보다 오래된 날짜별 로그 파일을 지운다. 날짜 형식이 아닌 파일은
// 건드리지 않는다 — 로그 디렉터리에 다른 파일이 섞여 있어도 안전해야 한다.
export function pruneLogsIn(directory: string, cutoff: number): void {
  try {
    for (const name of fs.readdirSync(directory)) {
      const match = name.match(/^(?:server|client)-(\d{4}-\d{2}-\d{2})\.log$/);
      if (match && new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) fs.rmSync(path.join(directory, name), { force: true });
    }
  } catch {
    // 정리 실패는 무시한다.
  }
}

// 현재 설정된 보존 기간으로 로그 디렉터리를 정리한다.
function pruneOldLogs(): void {
  pruneLogsIn(logsDir, Date.now() - keepDays() * 24 * 60 * 60 * 1000);
}

// console.* 호출을 감싸 기존 산재한 로그도 전부 서버 로그 파일에 남긴다.
function installConsoleTee(): void {
  const map: Array<[keyof typeof rawConsole, LogLevel]> = [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"], ["debug", "debug"]];
  for (const [method, level] of map) {
    console[method] = (...args: unknown[]) => {
      if (!levelEnabled(level)) return;
      rawConsole[method](...args);
      const message = args.map((item) => (typeof item === "string" ? item : safeJson(item))).join(" ");
      appendLine("server", formatLine(level, "console", message));
    };
  }
}

// 데이터 디렉터리 아래 logs/를 준비하고 콘솔 티·프로세스 오류 로그를 설치한다.
export function initServerLogging(dataDir: string): void {
  logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const configuredLevel = readProductEnv("LOG_LEVEL");
  minLevel = (LEVEL_ORDER as string[]).includes(configuredLevel ?? "") ? configuredLevel as LogLevel : defaultLogLevel(process.env.NODE_ENV);
  pruneOldLogs();
  // 날짜가 바뀌어야 새 파일이 생기므로 하루 한 번이면 충분하지만, 재시작 없이 며칠씩 도는 서버를
  // 감안해 6시간마다 확인한다. 프로세스 종료를 붙잡지 않도록 unref한다.
  const pruneTimer = setInterval(pruneOldLogs, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
  installConsoleTee();
  process.on("unhandledRejection", (reason) => write("error", "process", "unhandledRejection", reason));
  process.on("uncaughtException", (error) => {
    write("error", "process", "uncaughtException", error);
    process.exit(1);
  });
  write("info", "logger", `서버 로깅 시작 (level=${minLevel}, keepDays=${keepDays()}, dir=${logsDir})`);
}

// /api·/internal 요청의 메서드·경로·상태·소요시간·사용자를 기록하는 미들웨어를 만든다.
export function createRequestLogger(): RequestHandler {
  const requestLog = createLogger("http");
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.path.startsWith("/api") && !request.path.startsWith("/internal")) return next();
    const startedAt = Date.now();
    response.on("finish", () => {
      const user = (request as AuthenticatedRequest).authUser?.username ?? "-";
      const details = { method: request.method, path: request.originalUrl, status: response.statusCode, ms: Date.now() - startedAt, user, ip: request.ip };
      if (response.statusCode >= 500) requestLog.error("요청 실패", details);
      else if (response.statusCode >= 400) requestLog.warn("요청 거부", details);
      else requestLog.debug("요청 처리", details);
    });
    next();
  };
}

interface ClientLogEntry {
  at?: string;
  level?: string;
  scope?: string;
  message?: string;
}

// 클라이언트가 배치로 보낸 로그를 client-날짜.log 파일에 기록하는 핸들러를 만든다.
export function createClientLogHandler(): RequestHandler {
  return (request: Request, response: Response) => {
    const entries = Array.isArray((request.body as { entries?: unknown })?.entries) ? ((request.body as { entries: ClientLogEntry[] }).entries.slice(0, 200)) : [];
    const user = (request as AuthenticatedRequest).authUser?.username ?? "-";
    for (const entry of entries) {
      const level = (LEVEL_ORDER as string[]).includes(entry?.level ?? "") ? (entry.level as LogLevel) : "info";
      if (!levelEnabled(level)) continue;
      const at = typeof entry?.at === "string" ? entry.at.slice(0, 40) : new Date().toISOString();
      const scope = typeof entry?.scope === "string" ? entry.scope.slice(0, 60) : "client";
      const message = typeof entry?.message === "string" ? entry.message.slice(0, MAX_DETAIL_LENGTH) : "";
      appendLine("client", `${at} ${level.toUpperCase().padEnd(5)} [${scope}] (${user}) ${message}`);
    }
    response.status(204).end();
  };
}
