import { getCsrfToken } from "../api";

type LogLevel = "debug" | "info" | "warn" | "error";

interface ClientLogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
}

const MAX_MESSAGE_LENGTH = 2000;
const MAX_BUFFER = 500;
const FLUSH_COUNT = 30;
const FLUSH_INTERVAL_MS = 5000;

const buffer: ClientLogEntry[] = [];
let flushTimer: number | null = null;
let installed = false;

// 값을 로그 문자열로 안전하게 변환한다.
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// 버퍼에 쌓인 로그를 서버로 전송한다(실패 시 콘솔 재귀 없이 조용히 버림).
function flush(useKeepalive = false): void {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!buffer.length || !getCsrfToken()) return;
  const entries = buffer.splice(0, buffer.length);
  void fetch("/api/logs/client", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() },
    body: JSON.stringify({ entries }),
    keepalive: useKeepalive,
  }).catch(() => {});
}

// 로그 한 건을 버퍼에 넣고 배치 전송을 예약한다.
function enqueue(level: LogLevel, scope: string, message: string): void {
  buffer.push({ at: new Date().toISOString(), level, scope, message: message.slice(0, MAX_MESSAGE_LENGTH) });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  if (buffer.length >= FLUSH_COUNT) flush();
  else if (flushTimer === null) flushTimer = window.setTimeout(() => flush(), FLUSH_INTERVAL_MS);
}

export interface ClientLogger {
  debug: (message: string, details?: unknown) => void;
  info: (message: string, details?: unknown) => void;
  warn: (message: string, details?: unknown) => void;
  error: (message: string, details?: unknown) => void;
}

// 범위 이름이 붙은 클라이언트 로거를 만든다(콘솔 출력 + 서버 전송).
export function createLogger(scope: string): ClientLogger {
  const emit = (level: LogLevel, message: string, details?: unknown) => {
    const text = details === undefined ? message : `${message} ${toText(details)}`;
    // console 티가 설치돼 있으므로 콘솔 호출만으로 서버 전송까지 이뤄진다.
    (level === "debug" ? console.debug : console[level])(`[${scope}]`, text);
  };
  return {
    debug: (message, details) => emit("debug", message, details),
    info: (message, details) => emit("info", message, details),
    warn: (message, details) => emit("warn", message, details),
    error: (message, details) => emit("error", message, details),
  };
}

// console.*을 감싸 기존 산재한 로그와 전역 오류를 전부 서버로도 남긴다.
export function initClientLogging(): void {
  if (installed) return;
  installed = true;
  const map: Array<[keyof Console & ("log" | "info" | "warn" | "error" | "debug"), LogLevel]> = [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"], ["debug", "debug"]];
  for (const [method, level] of map) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      enqueue(level, "console", args.map(toText).join(" "));
    };
  }
  window.addEventListener("error", (event) => enqueue("error", "window", `${event.message} (${event.filename}:${event.lineno}:${event.colno})`));
  window.addEventListener("unhandledrejection", (event) => enqueue("error", "window", `unhandledrejection: ${toText(event.reason)}`));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => flush(true));
}
