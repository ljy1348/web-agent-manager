import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "./auth";
import { readProductEnv } from "./config";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];
// 디버그 레벨에서는 조회 화면 전체가 매분 쌓여 하루 수백 MB까지 커진다(실측: 8/9자 200MB).
// 그 상태로 오래 운용하기 위해 보존 기간을 짧게 잡되, 모든 요청 기록(#106)의 공격 추적을 위해 7일로 둔다(#108).
const DEFAULT_KEEP_DAYS = 7;
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

// 프록시가 넘긴 원 클라이언트 헤더들. 신뢰 판정용이 아니라 로그 참고값으로만 쓴다.
const CLIENT_HINT_HEADERS = ["cf-connecting-ip", "true-client-ip", "x-real-ip", "x-forwarded-for", "forwarded"];
const MAX_HEADER_LOG_LENGTH = 200;
// 감독 루프가 5초마다 부르는 헬스 체크는 하루 1.7만 줄을 차지해 기록하지 않는다(#107).
const UNLOGGED_PATHS = new Set(["/health"]);

// 상태 코드로 요청 로그 레벨을 정한다. 운영(info)에서도 모든 요청이 남도록 성공도 info다.
export function requestLogLevel(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

// 첫 번째로 존재하는 프록시 전달 헤더를 "헤더명=값" 원문으로 돌려준다(위조 가능한 참고값).
export function forwardedClientHint(headers: Record<string, string | string[] | undefined>): string | undefined {
  for (const name of CLIENT_HINT_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    if (value) return `${name}=${value}`.slice(0, MAX_HEADER_LOG_LENGTH);
  }
  return undefined;
}

// 헬스 체크를 뺀 모든 HTTP 요청의 메서드·경로·상태·소요시간·사용자·출처 참고값을 기록하는 미들웨어를 만든다.
export function createRequestLogger(): RequestHandler {
  const requestLog = createLogger("http");
  return (request: Request, response: Response, next: NextFunction) => {
    if (UNLOGGED_PATHS.has(request.path)) return next();
    const startedAt = Date.now();
    response.on("finish", () => {
      const user = (request as AuthenticatedRequest).authUser?.username ?? "-";
      const fwd = forwardedClientHint(request.headers);
      const ua = request.headers["user-agent"]?.slice(0, MAX_HEADER_LOG_LENGTH);
      const details = { method: request.method, path: request.originalUrl, status: response.statusCode, ms: Date.now() - startedAt, user, ip: request.ip, ...(fwd ? { fwd } : {}), ...(ua ? { ua } : {}) };
      const level = requestLogLevel(response.statusCode);
      if (level === "error") requestLog.error("요청 실패", details);
      else if (level === "warn") requestLog.warn("요청 거부", details);
      else requestLog.info("요청 처리", details);
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

export type LogKind = "server" | "client";

export interface LogQuery {
  kind: LogKind;
  date: string;
  minLevel: LogLevel;
  search: string;
  limit: number;
}

export interface LogReadResult {
  kind: LogKind;
  date: string;
  dates: string[];
  lines: string[];
  matched: number;
  truncated: boolean;
}

const LOG_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOG_LINE_LEVEL = /^\d{4}-\d{2}-\d{2}T\S+ (DEBUG|INFO|WARN|ERROR)\b/;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 2000;

// 쿼리 문자열을 검증된 로그 조회 조건으로 바꾼다. 날짜 형식만 허용해 경로 조작을 막는다.
export function parseLogQuery(query: Record<string, unknown>, today = new Date().toISOString().slice(0, 10)): LogQuery {
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const kind: LogKind = text(query.kind) === "client" ? "client" : "server";
  const date = LOG_DATE_PATTERN.test(text(query.date)) ? text(query.date) : today;
  const level = text(query.level).toLowerCase();
  const minLevel = (LEVEL_ORDER as string[]).includes(level) ? level as LogLevel : "debug";
  const requested = Number.parseInt(text(query.limit), 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_READ_LIMIT) : DEFAULT_READ_LIMIT;
  return { kind, date, minLevel, search: text(query.q).slice(0, 200).toLowerCase(), limit };
}

// 디렉터리에 있는 해당 종류 로그의 날짜 목록을 최신순으로 돌려준다.
export function listLogDates(directory: string, kind: LogKind): string[] {
  try {
    const pattern = new RegExp(`^${kind}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
    return fs.readdirSync(directory).map((name) => name.match(pattern)?.[1]).filter((date): date is string => !!date).sort().reverse();
  } catch {
    return [];
  }
}

// 날짜별 로그 파일을 스트림으로 읽어 레벨·검색 조건에 맞는 마지막 limit줄을 돌려준다.
// 스택처럼 시각이 없는 줄은 앞 줄의 레벨을 이어받는다.
export async function readLogLines(directory: string, query: LogQuery): Promise<LogReadResult> {
  const dates = listLogDates(directory, query.kind);
  const base = { kind: query.kind, date: query.date, dates };
  const file = path.join(directory, `${query.kind}-${query.date}.log`);
  if (!dates.includes(query.date)) return { ...base, lines: [], matched: 0, truncated: false };
  const minIndex = LEVEL_ORDER.indexOf(query.minLevel);
  const lines: string[] = [];
  let matched = 0;
  let currentLevel: LogLevel = "info";
  const reader = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of reader) {
    const level = line.match(LOG_LINE_LEVEL)?.[1];
    if (level) currentLevel = level.toLowerCase() as LogLevel;
    if (LEVEL_ORDER.indexOf(currentLevel) < minIndex) continue;
    if (query.search && !line.toLowerCase().includes(query.search)) continue;
    matched += 1;
    lines.push(line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH)}…` : line);
    // 줄마다 앞을 지우면 느리므로 두 배까지 쌓였을 때 한 번에 잘라낸다.
    if (lines.length >= query.limit * 2) lines.splice(0, lines.length - query.limit);
  }
  const tail = lines.slice(-query.limit);
  return { ...base, lines: tail, matched, truncated: matched > tail.length };
}

// 관리자용 서버·클라이언트 로그 조회 핸들러를 만든다. 연결 컴퓨터 로그도 federation 중계로 같은 경로를 쓴다.
export function createLogReadHandler(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!logsDir) return response.status(503).json({ error: "로그 디렉터리가 준비되지 않았습니다." });
    readLogLines(logsDir, parseLogQuery(request.query as Record<string, unknown>)).then((result) => response.json(result)).catch(next);
  };
}
