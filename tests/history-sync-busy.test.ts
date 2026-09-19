import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { HistorySynchronizer } from "../src/server/services/history-sync";
import { HistoryCache } from "../src/server/services/history-cache";
import { ApprovalService } from "../src/server/services/approval";
import { GrokAdapter } from "../src/server/providers/grok";
import type { RealtimeHub } from "../src/server/services/realtime";
import type { Notifier } from "../src/server/services/notifier";

const temporaryDirs: string[] = [];

function makeDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(directory);
  return fs.realpathSync(directory);
}

afterEach(() => {
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

// 운영 Grok 세션과 같은 디렉터리 구조로 기록 파일을 만든다.
function writeGrokSession(historyRoot: string, cwd: string, sessionId: string, options: {
  users?: number;
  tools?: number;
  turnEnded?: boolean;
  extraTool?: boolean;
  pending?: boolean;
  updatedAt?: string;
}): { chatHistory: string; events: string; updates: string } {
  const directory = path.join(historyRoot, encodeURIComponent(cwd), sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const records: unknown[] = [
    { type: "system", content: "You are Grok 4.6 released by xAI." },
    { type: "user", content: [{ type: "text", text: "<user_info>\nOS Version: linux\n</user_info>" }] },
  ];
  const users = options.users ?? 1;
  for (let index = 0; index < users; index += 1) {
    records.push({ type: "user", content: [{ type: "text", text: `<user_query>\n요청 ${index}\n</user_query>` }], prompt_index: index });
    if (options.pending) continue;
    records.push({ type: "assistant", content: `진행 ${index}` });
    const tools = options.tools ?? 1;
    for (let tool = 0; tool < tools; tool += 1) {
      records.push({ type: "tool_result", tool_call_id: `call-${index}-${tool}`, content: `결과 ${index}-${tool}` });
    }
    records.push({ type: "assistant", content: `응답 ${index}` });
  }
  if (options.extraTool) records.push({ type: "tool_result", tool_call_id: "call-late", content: "턴 종료 뒤 늦게 붙은 도구 결과" });
  const chatHistory = path.join(directory, "chat_history.jsonl");
  fs.writeFileSync(chatHistory, records.map((record) => JSON.stringify(record)).join("\n"));
  const events = path.join(directory, "events.jsonl");
  const eventLines: unknown[] = [{ ts: "2026-08-21T04:54:56.863Z", type: "turn_started", turn_number: 0 }];
  if (options.turnEnded) {
    const ended = users;
    for (let index = 0; index < ended; index += 1) {
      eventLines.push({ ts: `2026-08-21T05:00:4${index}.194Z`, type: "turn_ended", outcome: "completed" });
    }
  }
  fs.writeFileSync(events, eventLines.map((event) => JSON.stringify(event)).join("\n"));
  const updates = path.join(directory, "updates.jsonl");
  fs.writeFileSync(updates, options.turnEnded
    ? JSON.stringify({ timestamp: 1787288443, method: "_x.ai/session/update", params: { update: { sessionUpdate: "turn_completed", usage: { totalTokens: 10 } } } })
    : "");
  fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({
    info: { id: sessionId, cwd },
    created_at: "2026-08-21T04:54:56.684Z",
    updated_at: options.updatedAt ?? "2026-08-21T05:00:43.217Z",
    generated_title: "busy 고착 재현",
    current_model_id: "grok-4.6",
  }));
  return { chatHistory, events, updates };
}

function buildSynchronizer(cwd: string) {
  const dataDir = makeDir("wam-busy-data-");
  const historyRoot = makeDir("wam-busy-history-");
  const config = { dataDir, allowedRoots: [cwd], publicUrl: "http://127.0.0.1" } as unknown as AppConfig;
  const database = openDatabase(config);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(cwd);
  const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(cwd) as { id: number };
  const realtime = { broadcast: () => undefined } as unknown as RealtimeHub;
  const notifications: Notifier = { notify: async () => undefined };
  const adapter = new GrokAdapter();
  (adapter as { historyRoot: string }).historyRoot = historyRoot;
  const approvals = new ApprovalService(config, database, realtime, notifications);
  const accounts = new AgentAccountService(config, database);
  const sync = new HistorySynchronizer(config, database, [adapter], realtime, notifications, new HistoryCache(), approvals, accounts);
  return { database, sync, historyRoot, projectId: project.id, adapter };
}

// 실행 중인 Grok 채팅을 넣고 현재 busy 값을 읽는다.
function insertRunningChat(database: ReturnType<typeof openDatabase>, projectId: number, sessionId: string, historyFile: string, busy = 1): number {
  const result = database.prepare(`
    INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, history_file, busy)
    VALUES (?, 'grok', ?, ?, 'running', 'busy 재현', ?, ?)
  `).run(projectId, sessionId, `wam_busy_${sessionId}_${process.pid}_${Math.random()}`, historyFile, busy);
  return Number(result.lastInsertRowid);
}

function busyOf(database: ReturnType<typeof openDatabase>, chatId: number): number {
  return (database.prepare("SELECT busy FROM chats WHERE id = ?").get(chatId) as { busy: number }).busy;
}

describe("Grok 히스토리 동기화 busy 고착", () => {
  it("실행 중 채팅은 사용자 메시지가 쌓이면 busy가 된다", () => {
    const cwd = makeDir("wam-busy-cwd-");
    const { database, sync, historyRoot, projectId } = buildSynchronizer(cwd);
    const sessionId = "01a022ac-0fa1-7bc0-9d6b-226c99b64c27";
    const files = writeGrokSession(historyRoot, cwd, sessionId, { users: 1, pending: true, turnEnded: false });
    const chatId = insertRunningChat(database, projectId, sessionId, files.chatHistory, 0);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(1);
  });

  it("events.jsonl에 turn_ended가 붙으면 실행 중 채팅의 busy를 푼다", () => {
    const cwd = makeDir("wam-busy-cwd-");
    const { database, sync, historyRoot, projectId } = buildSynchronizer(cwd);
    const sessionId = "01a022ac-ended-busy";
    const files = writeGrokSession(historyRoot, cwd, sessionId, { turnEnded: false });
    const chatId = insertRunningChat(database, projectId, sessionId, files.chatHistory, 1);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(1);

    writeGrokSession(historyRoot, cwd, sessionId, { turnEnded: true, updatedAt: "2026-08-21T05:00:43.217Z" });
    sync.syncActive(false);
    expect(busyOf(database, chatId)).toBe(0);
  });

  it("활성 채팅 빠른 동기화는 무관한 종료 세션 전체를 다시 훑지 않는다", () => {
    const cwd = makeDir("wam-busy-cwd-");
    const { database, sync, historyRoot, projectId, adapter } = buildSynchronizer(cwd);
    const activeFiles = writeGrokSession(historyRoot, cwd, "active-session", { turnEnded: false });
    insertRunningChat(database, projectId, "active-session", activeFiles.chatHistory, 1);
    const stoppedFiles = writeGrokSession(historyRoot, cwd, "stopped-session", { turnEnded: true });
    const stoppedId = insertRunningChat(database, projectId, "stopped-session", stoppedFiles.chatHistory, 0);
    database.prepare("UPDATE chats SET status = 'stopped' WHERE id = ?").run(stoppedId);
    sync.syncAll(false);
    const parse = vi.spyOn(adapter, "parseHistoryFile");

    writeGrokSession(historyRoot, cwd, "stopped-session", { users: 2, turnEnded: true });
    sync.syncActive(false);

    expect(parse).not.toHaveBeenCalled();
    expect(parse.mock.calls.map(([file]) => file)).not.toContain(stoppedFiles.chatHistory);
    expect(parse.mock.calls.map(([file]) => file)).not.toContain(stoppedFiles.events);
    expect(parse.mock.calls.map(([file]) => file)).not.toContain(stoppedFiles.updates);
  });

  // 운영에서 관측: turn_ended를 읽었고 chats.updated_at도 그 직후인데 busy=1이 남았다.
  // 사이드카(updates.jsonl)가 종료 뒤에 한 번 더 persist되며, 이미 소비한 턴 종료 엣지 때문에
  // isTurnEnd=false + 새 tool_result → markBusy로 다시 올린 뒤 파일이 더 안 바뀌어 영구 고착됐다.
  it("턴이 끝난 뒤 늦게 붙은 도구 결과가 busy를 다시 올리지 않는다", () => {
    const cwd = makeDir("wam-busy-cwd-");
    const { database, sync, historyRoot, projectId } = buildSynchronizer(cwd);
    const sessionId = "01a022ac-late-tool";
    const files = writeGrokSession(historyRoot, cwd, sessionId, { turnEnded: false, tools: 2 });
    const chatId = insertRunningChat(database, projectId, sessionId, files.chatHistory, 1);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(1);

    writeGrokSession(historyRoot, cwd, sessionId, { turnEnded: true, tools: 2 });
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(0);

    writeGrokSession(historyRoot, cwd, sessionId, { turnEnded: true, tools: 2, extraTool: true });
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(0);
  });

  it("종료가 확인된 세션이 busy=1로 남아 있으면 파일이 안 바뀌어도 다음 동기화에서 풀린다", () => {
    const cwd = makeDir("wam-busy-cwd-");
    const { database, sync, historyRoot, projectId } = buildSynchronizer(cwd);
    const sessionId = "01a022ac-heal";
    const files = writeGrokSession(historyRoot, cwd, sessionId, { turnEnded: true });
    const chatId = insertRunningChat(database, projectId, sessionId, files.chatHistory, 1);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(0);

    database.prepare("UPDATE chats SET busy = 1 WHERE id = ?").run(chatId);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(0);
  });

  it("아직 turn_ended가 없는 실행 중 턴은 파일이 안 바뀌어도 busy를 유지한다", () => {
    const cwd = makeDir("wam-busy-cwd-");
    const { database, sync, historyRoot, projectId } = buildSynchronizer(cwd);
    const sessionId = "01a022ac-in-progress";
    const files = writeGrokSession(historyRoot, cwd, sessionId, { turnEnded: false });
    const chatId = insertRunningChat(database, projectId, sessionId, files.chatHistory, 1);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(1);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(1);
  });

  it("턴이 끝난 뒤 새 사용자 메시지가 오면 다시 busy가 된다", () => {
    const cwd = makeDir("wam-busy-cwd-");
    const { database, sync, historyRoot, projectId } = buildSynchronizer(cwd);
    const sessionId = "01a022ac-next-turn";
    const files = writeGrokSession(historyRoot, cwd, sessionId, { users: 1, turnEnded: true });
    const chatId = insertRunningChat(database, projectId, sessionId, files.chatHistory, 1);
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(0);

    writeGrokSession(historyRoot, cwd, sessionId, { users: 2, turnEnded: false });
    sync.syncAll(false);
    expect(busyOf(database, chatId)).toBe(1);
  });
});
