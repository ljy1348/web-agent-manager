import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { GROK_HOOK_FILE, installGrokHooks, prepareRuntimeFiles } from "../src/server/services/runtime-files";
import { AgentHookEventService, HookObserver, parseHookChatId } from "../src/server/services/agent-hook-events";
import type { RealtimeHub } from "../src/server/services/realtime";

// 훅 단계적 도입(#90·#91·#92): CLI 훅 구성과, 관찰 훅이 session ID를 연결하고 기존 기록 동기화를 즉시
// 요청하는지 고정한다.

const temporaryDirs: string[] = [];

function makeDataDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wam-agent-hook-"));
  temporaryDirs.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

// 격리된 DB에 Claude 채팅(session-a)과 아직 session ID가 없는 Codex 채팅을 만든다.
function createDatabase(): { database: AppDatabase; claudeChat: number; codexChat: number } {
  process.env.WEB_AGENT_MANAGER_DATA_DIR = makeDataDir();
  const database = openDatabase(loadConfig());
  database.prepare("INSERT INTO projects(name, path) VALUES ('p', '/tmp/p')").run();
  const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
  const insert = database.prepare("INSERT INTO chats(project_id, provider, provider_session_id, history_file, tmux_name, status, title) VALUES (?, ?, ?, ?, ?, 'running', 't')");
  const claudeChat = Number(insert.run(project.id, "claude", "session-a", "/tmp/session-a.jsonl", "hook-claude").lastInsertRowid);
  const codexChat = Number(insert.run(project.id, "codex", null, null, "hook-codex").lastInsertRowid);
  return { database, claudeChat, codexChat };
}

// 브로드캐스트한 이벤트를 모으는 실시간 허브 대역.
function recordingRealtime(): { realtime: RealtimeHub; events: Array<{ type: string; payload: unknown }> } {
  const events: Array<{ type: string; payload: unknown }> = [];
  return { realtime: { broadcast: (type: string, payload: unknown) => events.push({ type, payload }) } as unknown as RealtimeHub, events };
}

// setImmediate로 미룬 동기화 요청이 실행될 때까지 기다린다.
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function chatSession(database: AppDatabase, chatId: number): unknown {
  return database.prepare("SELECT provider_session_id AS sessionId, history_file AS historyFile FROM chats WHERE id = ?").get(chatId);
}

describe("CLI 훅 런타임 설정", () => {
  it("Claude는 턴 이벤트를 HTTP 훅, SessionStart를 command 브리지로 등록한다", () => {
    const dataDir = makeDataDir();
    const runtime = prepareRuntimeFiles({ ...loadConfig(), dataDir, port: 14999 });
    const settings = JSON.parse(fs.readFileSync(runtime.claudeSettingsFile, "utf8"));

    expect(settings.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: "command", timeout: 600 });
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain("claude-permission-bridge");
    for (const event of ["UserPromptSubmit", "Stop", "StopFailure"]) {
      expect(settings.hooks[event]).toEqual([{ hooks: [{
        type: "http",
        url: "http://127.0.0.1:14999/internal/claude/hook-event",
        timeout: 5,
        headers: { Authorization: `Bearer ${runtime.hookToken}`, "X-WAM-Chat-Id": "$WEB_AGENT_MANAGER_CHAT_ID" },
        allowedEnvVars: ["WEB_AGENT_MANAGER_CHAT_ID"],
      }] }]);
    }
    // Claude는 SessionStart의 HTTP 훅을 건너뛰므로 command 브리지로 받는다.
    const sessionStart = settings.hooks.SessionStart[0].hooks[0];
    expect(sessionStart).toMatchObject({ type: "command", timeout: 10 });
    expect(sessionStart.command).toContain("hook-event-bridge");
    expect(sessionStart.command).toContain(JSON.stringify("http://127.0.0.1:14999/internal/claude/hook-event"));
    // 설정 파일에 토큰이 들어가므로 소유자만 읽을 수 있어야 한다.
    expect(fs.statSync(runtime.claudeSettingsFile).mode & 0o777).toBe(0o600);
  });

  it("Codex 훅은 -c 인라인 TOML로 만들고 SessionStart만 동기, 턴 이벤트는 async로 둔다", () => {
    const runtime = prepareRuntimeFiles({ ...loadConfig(), dataDir: makeDataDir(), port: 14999 });
    const values = runtime.codexHookArgs.filter((_, index) => index % 2 === 1);

    expect(runtime.codexHookArgs.filter((_, index) => index % 2 === 0)).toEqual(["-c", "-c", "-c", "-c"]);
    expect(values.map((value) => value.split("=")[0])).toEqual(["hooks.SessionStart", "hooks.PermissionRequest", "hooks.UserPromptSubmit", "hooks.Stop"]);
    const [sessionStart, permission, ...turnEvents] = values;
    expect(sessionStart).not.toContain("async=true");
    // 승인은 사람 결정을 기다리는 동기 훅이며 승인 브리지를 Codex 모드(URL 인자)로 부른다(#95).
    expect(permission).toMatch(/^hooks\.PermissionRequest=\[\{hooks=\[\{type="command",command=".*claude-permission-bridge.*",timeout=600\}\]\}\]$/);
    expect(permission).toContain(String.raw`\"http://127.0.0.1:14999/internal/codex/permission\"`);
    for (const value of [sessionStart, ...turnEvents]) {
      if (value !== sessionStart) expect(value).toContain("async=true");
      expect(value).toMatch(/^hooks\.\w+=\[\{hooks=\[\{type="command",command=".*hook-event-bridge.*",timeout=10(,async=true)?\}\]\}\]$/);
      // 명령 안의 경로 따옴표가 TOML 기본 문자열로 이스케이프돼야 한다.
      expect(value).toContain(String.raw`\"http://127.0.0.1:14999/internal/codex/hook-event\"`);
    }
  });
});

describe("parseHookChatId", () => {
  it("양의 정수만 채팅 ID로 인정한다", () => {
    expect(parseHookChatId("42")).toBe(42);
    expect(parseHookChatId(["7"])).toBe(7);
    // 환경변수가 없으면 Claude가 빈 문자열로 치환한다.
    expect(parseHookChatId("")).toBeNull();
    expect(parseHookChatId(undefined)).toBeNull();
    expect(parseHookChatId("0")).toBeNull();
    expect(parseHookChatId("12abc")).toBeNull();
  });
});

describe("AgentHookEventService 동기화 요청", () => {
  it("연결된 채팅의 턴 이벤트는 같은 틱에 몰려도 동기화를 한 번만 요청한다", async () => {
    const { database, claudeChat } = createDatabase();
    let syncCount = 0;
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => { syncCount += 1; });

    service.handle("claude", String(claudeChat), { hook_event_name: "UserPromptSubmit", session_id: "session-a" });
    service.handle("claude", String(claudeChat), { hook_event_name: "Stop", session_id: "session-a" });
    expect(syncCount).toBe(0); // HTTP 응답보다 먼저 동기화하지 않는다.
    await flushImmediate();

    expect(syncCount).toBe(1);
    service.handle("claude", String(claudeChat), { hook_event_name: "StopFailure", session_id: "session-a", error: "rate_limit" });
    await flushImmediate();
    expect(syncCount).toBe(2);
  });

  it("채팅 ID가 없거나 공급자가 다르거나 대상 이벤트가 아니면 동기화하지 않는다", async () => {
    const { database, claudeChat, codexChat } = createDatabase();
    let syncCount = 0;
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => { syncCount += 1; });

    service.handle("claude", "", { hook_event_name: "Stop" });
    service.handle("claude", undefined, { hook_event_name: "Stop" });
    service.handle("claude", String(codexChat), { hook_event_name: "Stop" });
    service.handle("codex", String(claudeChat), { hook_event_name: "Stop" });
    service.handle("claude", "999999", { hook_event_name: "Stop" });
    service.handle("claude", String(claudeChat), { hook_event_name: "PreToolUse" });
    // Codex에는 StopFailure 훅이 없어 대상이 아니다.
    service.handle("codex", String(codexChat), { hook_event_name: "StopFailure" });
    await flushImmediate();

    expect(syncCount).toBe(0);
  });

  it("동기화가 실패해도 예외를 밖으로 던지지 않는다", async () => {
    const { database, claudeChat } = createDatabase();
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => { throw new Error("db closed"); });

    service.handle("claude", String(claudeChat), { hook_event_name: "Stop" });
    await expect(flushImmediate()).resolves.toBeUndefined();
  });
});

describe("AgentHookEventService SessionStart 연결", () => {
  it("Codex 첫 SessionStart는 session ID를 채팅에 먼저 붙여 claim·FIFO 추측 없이 기록이 연결되게 한다", async () => {
    const { database, codexChat } = createDatabase();
    const { realtime, events } = recordingRealtime();
    let syncCount = 0;
    const service = new AgentHookEventService(database, realtime, () => { syncCount += 1; });

    service.handle("codex", String(codexChat), { hook_event_name: "SessionStart", session_id: "thread-1", source: "startup" });
    await flushImmediate();

    expect(chatSession(database, codexChat)).toEqual({ sessionId: "thread-1", historyFile: null });
    expect(events).toEqual([{ type: "history_updated", payload: { chatId: codexChat } }]);
    expect(syncCount).toBe(1);
  });

  it("Claude /clear로 session ID가 바뀌면 채팅을 새 ID로 옮기고 옛 기록 파일은 다시 스캔되게 넘긴다", () => {
    const { database, claudeChat } = createDatabase();
    const released: string[] = [];
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined, { releaseHistoryFile: (file) => released.push(file) });

    service.handle("claude", String(claudeChat), { hook_event_name: "SessionStart", session_id: "session-b", source: "clear" });

    expect(chatSession(database, claudeChat)).toEqual({ sessionId: "session-b", historyFile: null });
    expect(released).toEqual(["/tmp/session-a.jsonl"]);
  });

  it("같은 session ID의 시작·재개는 기존 연결을 건드리지 않는다", () => {
    const { database, claudeChat } = createDatabase();
    const { realtime, events } = recordingRealtime();
    const released: string[] = [];
    const service = new AgentHookEventService(database, realtime, () => undefined, { releaseHistoryFile: (file) => released.push(file) });

    service.handle("claude", String(claudeChat), { hook_event_name: "SessionStart", session_id: "session-a", source: "resume" });

    expect(chatSession(database, claudeChat)).toEqual({ sessionId: "session-a", historyFile: "/tmp/session-a.jsonl" });
    expect(events).toEqual([]);
    expect(released).toEqual([]);
  });

  it("다른 채팅이 이미 쓰는 session ID로는 옮기지 않는다", () => {
    const { database, claudeChat } = createDatabase();
    const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
    database.prepare("INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title) VALUES (?, 'claude', 'taken', 'hook-other', 'stopped', 't')").run(project.id);
    const released: string[] = [];
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined, { releaseHistoryFile: (file) => released.push(file) });

    service.handle("claude", String(claudeChat), { hook_event_name: "SessionStart", session_id: "taken", source: "resume" });

    expect(chatSession(database, claudeChat)).toEqual({ sessionId: "session-a", historyFile: "/tmp/session-a.jsonl" });
    expect(released).toEqual([]);
  });
});

describe("AgentHookEventService 작업중 반영(#93)", () => {
  function busyOf(database: AppDatabase, chatId: number): number {
    return (database.prepare("SELECT busy FROM chats WHERE id = ?").get(chatId) as { busy: number }).busy;
  }

  it("UserPromptSubmit이면 작업중으로, Stop·StopFailure면 해제로 바로 반영한다", () => {
    const { database, claudeChat } = createDatabase();
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined);

    service.handle("claude", String(claudeChat), { hook_event_name: "UserPromptSubmit" });
    expect(busyOf(database, claudeChat)).toBe(1);
    service.handle("claude", String(claudeChat), { hook_event_name: "Stop" });
    expect(busyOf(database, claudeChat)).toBe(0);
    service.handle("claude", String(claudeChat), { hook_event_name: "UserPromptSubmit" });
    service.handle("claude", String(claudeChat), { hook_event_name: "StopFailure", error: "rate_limit" });
    expect(busyOf(database, claudeChat)).toBe(0);
  });

  it("Codex async Stop이 다음 턴 시작보다 늦게 와도 새 턴의 작업중을 지우지 않는다", () => {
    const { database, codexChat } = createDatabase();
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined);

    service.handle("codex", String(codexChat), { hook_event_name: "UserPromptSubmit", turn_id: "turn-1" });
    service.handle("codex", String(codexChat), { hook_event_name: "UserPromptSubmit", turn_id: "turn-2" });
    service.handle("codex", String(codexChat), { hook_event_name: "Stop", turn_id: "turn-1" });
    expect(busyOf(database, codexChat)).toBe(1);
    service.handle("codex", String(codexChat), { hook_event_name: "Stop", turn_id: "turn-2" });
    expect(busyOf(database, codexChat)).toBe(0);
  });

  it("종료된 채팅은 UserPromptSubmit이 와도 작업중으로 올리지 않는다", () => {
    const { database, claudeChat } = createDatabase();
    database.prepare("UPDATE chats SET status = 'stopped' WHERE id = ?").run(claudeChat);
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined);

    service.handle("claude", String(claudeChat), { hook_event_name: "UserPromptSubmit" });
    expect(busyOf(database, claudeChat)).toBe(0);
  });

  it("받은 훅을 관찰기에 기록한다", () => {
    const { database, claudeChat } = createDatabase();
    const observer = new HookObserver();
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined, { observer });

    service.handle("claude", String(claudeChat), { hook_event_name: "Stop" });
    service.handle("claude", "", { hook_event_name: "Stop" }); // 채팅 ID 없는 훅은 세지 않는다.

    expect(observer.snapshot().hooks).toEqual({ "claude.Stop": 1 });
  });
});

describe("HookObserver 훅 도착 대조(#93)", () => {
  afterEach(() => vi.useRealTimers());

  it("훅이 한 번도 오지 않은 채팅의 턴 종료는 누락이 아니라 관찰 불가로 센다", () => {
    const observer = new HookObserver(15_000);
    observer.recordPollingTurnEnd("claude", 1);
    expect(observer.snapshot()).toMatchObject({ pollingTurnEnds: 1, unobservedTurnEnds: 1, matchedTurnEnds: 0, missedTurnEnds: 0 });
  });

  it("Stop 훅이 폴링보다 먼저 왔거나 유예 시간 안에 오면 일치로 센다", () => {
    vi.useFakeTimers();
    const observer = new HookObserver(15_000);
    observer.recordHook("claude", 1, "Stop");
    observer.recordPollingTurnEnd("claude", 1);
    observer.recordHook("codex", 2, "UserPromptSubmit");
    observer.recordPollingTurnEnd("codex", 2);
    vi.advanceTimersByTime(5_000);
    observer.recordHook("codex", 2, "Stop");
    vi.advanceTimersByTime(15_000);

    expect(observer.snapshot()).toMatchObject({ pollingTurnEnds: 2, matchedTurnEnds: 2, missedTurnEnds: 0, lastMiss: null });
  });

  it("유예 시간 안에 Stop 훅이 오지 않으면 누락으로 세고 마지막 누락을 남긴다", () => {
    vi.useFakeTimers();
    const observer = new HookObserver(15_000);
    observer.recordHook("claude", 3, "UserPromptSubmit");
    observer.recordPollingTurnEnd("claude", 3);
    vi.advanceTimersByTime(15_000);

    expect(observer.snapshot()).toMatchObject({ matchedTurnEnds: 0, missedTurnEnds: 1, lastMiss: { provider: "claude", chatId: 3 } });
    observer.stop();
  });
});

describe("AgentHookEventService StopFailure 리밋 보완(#94)", () => {
  afterEach(() => vi.useRealTimers());

  it("rate_limit으로 멈춘 턴만 화면 감지에 시간을 준 뒤 리밋 대기 보완 등록을 요청한다", () => {
    vi.useFakeTimers();
    const { database, claudeChat } = createDatabase();
    const requested: Array<[number, string | null]> = [];
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined, {
      onRateLimit: (chatId, details) => requested.push([chatId, details]),
      rateLimitDelayMs: 5_000,
    });

    service.handle("claude", String(claudeChat), { hook_event_name: "StopFailure", error: "server_error" });
    service.handle("claude", String(claudeChat), { hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3am (Asia/Seoul)" });
    vi.advanceTimersByTime(4_999);
    expect(requested).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(requested).toEqual([[claudeChat, "resets 3am (Asia/Seoul)"]]);
  });
});

describe("Grok 전역 훅(#96)", () => {
  afterEach(() => vi.useRealTimers());

  // 기존 DB에 Grok 채팅을 하나 더 만든다.
  function addGrokChat(database: AppDatabase, sessionId: string | null = "grok-a"): number {
    const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
    return Number(database.prepare("INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title) VALUES (?, 'grok', ?, 'hook-grok', 'running', 't')").run(project.id, sessionId).lastInsertRowid);
  }

  it("다섯 이벤트를 브리지 command 훅으로 만들고, 설치는 0600이며 같은 내용이면 다시 쓰지 않는다", () => {
    const runtime = prepareRuntimeFiles({ ...loadConfig(), dataDir: makeDataDir(), port: 14999 });
    expect(Object.keys(runtime.grokHooks.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "StopCancelled"]);
    const handler = (runtime.grokHooks.hooks.Stop[0] as { hooks: Array<{ type: string; command: string; timeout: number }> }).hooks[0];
    expect(handler).toMatchObject({ type: "command", timeout: 10 });
    expect(handler.command).toContain("hook-event-bridge");
    expect(handler.command).toContain(JSON.stringify("http://127.0.0.1:14999/internal/grok/hook-event"));

    const grokHome = makeDataDir();
    const file = installGrokHooks(runtime.grokHooks, grokHome);
    expect(file).toBe(path.join(grokHome, "hooks", GROK_HOOK_FILE));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(runtime.grokHooks);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const firstMtime = fs.statSync(file).mtimeMs;
    installGrokHooks(runtime.grokHooks, grokHome);
    expect(fs.statSync(file).mtimeMs).toBe(firstMtime);
  });

  it("session_id로 채팅을 연결하고 promptId로 늦은 Stop을 거르며 StopCancelled도 작업중을 푼다", () => {
    vi.useFakeTimers();
    const { database } = createDatabase();
    const grokChat = addGrokChat(database, null);
    const requested: number[] = [];
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined, { onRateLimit: (chatId) => requested.push(chatId), rateLimitDelayMs: 1 });
    const busy = () => (database.prepare("SELECT busy FROM chats WHERE id = ?").get(grokChat) as { busy: number }).busy;

    service.handle("grok", String(grokChat), { hook_event_name: "SessionStart", session_id: "grok-session", sessionId: "grok-session", source: "new" });
    expect(chatSession(database, grokChat)).toEqual({ sessionId: "grok-session", historyFile: null });

    service.handle("grok", String(grokChat), { hook_event_name: "UserPromptSubmit", promptId: "p1" });
    service.handle("grok", String(grokChat), { hook_event_name: "UserPromptSubmit", promptId: "p2" });
    service.handle("grok", String(grokChat), { hook_event_name: "Stop", promptId: "p1" });
    expect(busy()).toBe(1);
    service.handle("grok", String(grokChat), { hook_event_name: "StopCancelled", promptId: "p2" });
    expect(busy()).toBe(0);

    // Grok StopFailure의 오류 표기는 실측 전이라 리밋 대기로 잇지 않는다.
    service.handle("grok", String(grokChat), { hook_event_name: "StopFailure", error: "rate_limit" });
    vi.advanceTimersByTime(10);
    expect(requested).toEqual([]);
  });
});

describe("UserPromptSubmit 제출 증거 전달(#98)", () => {
  it("UserPromptSubmit을 받으면 전송 확인이 쓸 수 있게 채팅 ID를 알린다", () => {
    const { database, codexChat } = createDatabase();
    const submitted: number[] = [];
    const service = new AgentHookEventService(database, recordingRealtime().realtime, () => undefined, { onPromptSubmit: (chatId) => submitted.push(chatId) });

    service.handle("codex", String(codexChat), { hook_event_name: "UserPromptSubmit", turn_id: "t1" });
    service.handle("codex", String(codexChat), { hook_event_name: "Stop", turn_id: "t1" });

    expect(submitted).toEqual([codexChat]);
  });
});
