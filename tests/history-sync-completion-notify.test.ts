import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { HistorySynchronizer, isOpenSourceDelegation } from "../src/server/services/history-sync";
import { HistoryCache } from "../src/server/services/history-cache";
import { ApprovalService } from "../src/server/services/approval";
import { ClaudeAdapter } from "../src/server/providers/claude";
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

// 완료 알림을 유발하는 Claude 세션 JSONL을 쓴다. 위임 created_at과 턴 시각을 비교하므로 현재 시각을 쓴다.
function writeClaudeSession(historyRoot: string, sessionId: string, cwd: string, ended: boolean): string {
  const file = path.join(historyRoot, `${sessionId}.jsonl`);
  const started = new Date(Date.now() - 2_000).toISOString();
  const lines: unknown[] = [
    { type: "user", sessionId, cwd, message: { content: "요청" }, timestamp: started },
  ];
  if (ended) {
    lines.push({
      type: "assistant",
      sessionId,
      cwd,
      message: { content: [{ type: "text", text: "완료" }], stop_reason: "end_turn" },
      timestamp: new Date().toISOString(),
    });
  }
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

function buildSynchronizer(cwd: string, historyRoot = makeDir("wam-notify-history-"), hookObserver?: { recordPollingTurnEnd(provider: string, chatId: number): void }) {
  const dataDir = makeDir("wam-notify-data-");
  const config = { dataDir, allowedRoots: [cwd], publicUrl: "http://127.0.0.1" } as unknown as AppConfig;
  const database = openDatabase(config);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(cwd);
  const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(cwd) as { id: number };
  const sent: Array<{ eventId: string; eventType: string; text: string }> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const realtime = { broadcast: (type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); } } as unknown as RealtimeHub;
  const notifications: Notifier = {
    notify: async (eventId, eventType, text) => { sent.push({ eventId, eventType, text }); },
  };
  const adapter = new ClaudeAdapter("", {});
  (adapter as { historyRoot: string }).historyRoot = historyRoot;
  const approvals = new ApprovalService(config, database, realtime, notifications);
  const accounts = new AgentAccountService(config, database);
  const sync = new HistorySynchronizer(config, database, [adapter], realtime, notifications, new HistoryCache(), approvals, accounts, undefined, hookObserver);
  return { database, sync, historyRoot, projectId: project.id, sent, events };
}

// 실행 중인 채팅을 넣고 식별자를 반환한다.
function insertChat(database: AppDatabase, options: {
  projectId: number;
  sessionId: string;
  historyFile: string;
  origin?: "user" | "delegation";
  busy?: number;
}): number {
  const result = database.prepare(`
    INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, history_file, busy, origin)
    VALUES (?, 'claude', ?, ?, 'running', '알림 테스트', ?, ?, ?)
  `).run(
    options.projectId,
    options.sessionId,
    `wam_notify_${options.sessionId}_${process.pid}_${Math.random()}`,
    options.historyFile,
    options.busy ?? 0,
    options.origin ?? "user",
  );
  return Number(result.lastInsertRowid);
}

function insertChild(database: AppDatabase, projectId: number, busy = 1): number {
  const result = database.prepare(`
    INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, origin)
    VALUES (?, 'codex', ?, 'running', '자식', ?, 'delegation')
  `).run(projectId, `wam_notify_child_${process.pid}_${Math.random()}`, busy);
  return Number(result.lastInsertRowid);
}

function insertDelegation(database: AppDatabase, sourceChatId: number, targetChatId: number): string {
  const id = crypto.randomUUID();
  database.prepare(`
    INSERT INTO delegations(id, idempotency_key, source_chat_id, target_chat_id, prompt, status, baseline_message_count)
    VALUES (?, ?, ?, ?, '위임', 'sent', 0)
  `).run(id, `key-${id}`, sourceChatId, targetChatId);
  return id;
}

function completedEvents(events: Array<{ type: string; payload: Record<string, unknown> }>) {
  return events.filter((event) => event.type === "task_completed");
}

describe("히스토리 동기화 완료 알림 게이트", () => {
  it("위임으로 만든 채팅은 푸시·task_completed를 보내지 않는다", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const { database, sync, historyRoot, projectId, sent, events } = buildSynchronizer(cwd);
    const sessionId = "delegated-child";
    const file = writeClaudeSession(historyRoot, sessionId, cwd, true);
    insertChat(database, { projectId, sessionId, historyFile: file, origin: "delegation" });
    sync.syncAll(true);
    expect(sent).toEqual([]);
    expect(completedEvents(events)).toEqual([]);
    database.close();
  });

  it("미완료 위임이 있으면 부모 완료 알림을 보류한다", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const { database, sync, historyRoot, projectId, sent, events } = buildSynchronizer(cwd);
    const sessionId = "parent-hold";
    const file = writeClaudeSession(historyRoot, sessionId, cwd, true);
    const parentId = insertChat(database, { projectId, sessionId, historyFile: file });
    const childId = insertChild(database, projectId, 1);
    insertDelegation(database, parentId, childId);
    sync.syncAll(true);
    expect(sent).toEqual([]);
    expect(completedEvents(events)).toEqual([]);
    database.close();
  });

  it("마지막 위임이 끝나면 보류했던 부모 알림을 한 번만 보낸다", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const { database, sync, historyRoot, projectId, sent, events } = buildSynchronizer(cwd);
    const sessionId = "parent-flush";
    const file = writeClaudeSession(historyRoot, sessionId, cwd, true);
    const parentId = insertChat(database, { projectId, sessionId, historyFile: file });
    const firstChild = insertChild(database, projectId, 1);
    const secondChild = insertChild(database, projectId, 1);
    insertDelegation(database, parentId, firstChild);
    insertDelegation(database, parentId, secondChild);
    sync.syncAll(true);
    expect(sent).toHaveLength(0);

    database.prepare("UPDATE chats SET busy = 0 WHERE id = ?").run(firstChild);
    sync.syncAll(true);
    expect(sent).toHaveLength(0);

    database.prepare("UPDATE chats SET busy = 0 WHERE id = ?").run(secondChild);
    sync.syncAll(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ eventType: "task_completed" });
    expect(sent[0].text).toContain("AI 작업이 완료되었습니다.");
    expect(sent[0].text).not.toContain("실패");
    expect(completedEvents(events)).toHaveLength(1);
    expect(completedEvents(events)[0].payload).toMatchObject({ chatId: parentId, provider: "claude" });
    database.close();
  });

  it("위임이 실패로 끝나도 보류를 풀고 실패 문구를 붙인다", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const { database, sync, historyRoot, projectId, sent } = buildSynchronizer(cwd);
    const sessionId = "parent-fail";
    const file = writeClaudeSession(historyRoot, sessionId, cwd, true);
    const parentId = insertChat(database, { projectId, sessionId, historyFile: file });
    const childId = insertChild(database, projectId, 1);
    const delegationId = insertDelegation(database, parentId, childId);
    sync.syncAll(true);
    expect(sent).toHaveLength(0);

    database.prepare("UPDATE delegations SET status = 'failed', error = '대상 종료' WHERE id = ?").run(delegationId);
    database.prepare("UPDATE chats SET busy = 0, status = 'error' WHERE id = ?").run(childId);
    sync.syncAll(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("위임 작업 1건 중 1건이 실패했습니다.");
    database.close();
  });

  it("위임이 없는 일반 채팅은 기존과 같이 즉시 완료 알림을 보낸다", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const { database, sync, historyRoot, projectId, sent, events } = buildSynchronizer(cwd);
    const sessionId = "plain-chat";
    const file = writeClaudeSession(historyRoot, sessionId, cwd, true);
    const chatId = insertChat(database, { projectId, sessionId, historyFile: file });
    sync.syncAll(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].eventType).toBe("task_completed");
    expect(sent[0].text).toBe(
      `AI 작업이 완료되었습니다.\n공급자: claude\n프로젝트: ${path.basename(cwd)}\nhttp://127.0.0.1/?chat=${chatId}`,
    );
    expect(completedEvents(events)).toEqual([
      { type: "task_completed", payload: { chatId, provider: "claude", title: expect.any(String) } },
    ]);
    database.close();
  });

  it("부모가 보류 중 새 턴을 돌리면 이전 보류를 새 완료로 갈아 끼운다", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const { database, sync, historyRoot, projectId, sent } = buildSynchronizer(cwd);
    const sessionId = "parent-new-turn";
    const file = writeClaudeSession(historyRoot, sessionId, cwd, true);
    const parentId = insertChat(database, { projectId, sessionId, historyFile: file });
    const childId = insertChild(database, projectId, 1);
    insertDelegation(database, parentId, childId);
    sync.syncAll(true);
    expect(sent).toHaveLength(0);

    fs.appendFileSync(file, `${JSON.stringify({
      type: "user",
      sessionId,
      cwd,
      message: { content: "이어서" },
      timestamp: new Date().toISOString(),
    })}\n`);
    sync.syncAll(true);
    expect(sent).toHaveLength(0);

    fs.appendFileSync(file, `${JSON.stringify({
      type: "assistant",
      sessionId,
      cwd,
      message: { content: [{ type: "text", text: "두번째 완료" }], stop_reason: "end_turn" },
      timestamp: new Date().toISOString(),
    })}\n`);
    sync.syncAll(true);
    expect(sent).toHaveLength(0);

    database.prepare("UPDATE chats SET busy = 0 WHERE id = ?").run(childId);
    sync.syncAll(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].eventId).toContain("parent-new-turn");
    database.close();
  });

  it("재시작 뒤에는 미완료 위임이 남아 있으면 보류를 다시 잡고 나중에 한 번 보낸다", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const historyRoot = makeDir("wam-notify-history-");
    const first = buildSynchronizer(cwd, historyRoot);
    const sessionId = "parent-restart";
    const file = writeClaudeSession(historyRoot, sessionId, cwd, true);
    const parentId = insertChat(first.database, { projectId: first.projectId, sessionId, historyFile: file });
    const childId = insertChild(first.database, first.projectId, 1);
    insertDelegation(first.database, parentId, childId);
    first.sync.syncAll(true);
    expect(first.sent).toHaveLength(0);

    const second = buildSynchronizer(cwd, historyRoot);
    const resumedParent = insertChat(second.database, { projectId: second.projectId, sessionId, historyFile: file });
    const resumedChild = insertChild(second.database, second.projectId, 1);
    insertDelegation(second.database, resumedParent, resumedChild);
    second.sync.syncAll(false);
    expect(second.sent).toHaveLength(0);

    second.database.prepare("UPDATE chats SET busy = 0 WHERE id = ?").run(resumedChild);
    second.sync.syncAll(true);
    expect(second.sent).toHaveLength(1);
    first.database.close();
    second.database.close();
  });
});

describe("위임 미완료 판정", () => {
  it("실패했거나 대상이 한가하면 열린 위임이 아니다", () => {
    expect(isOpenSourceDelegation({
      id: "a", status: "failed", completed_at: null, created_at: "2026-08-21 00:00:00", busy: 1, chatStatus: "running",
    })).toBe(false);
    expect(isOpenSourceDelegation({
      id: "b", status: "sent", completed_at: "2026-08-21 00:00:01", created_at: "2026-08-21 00:00:00", busy: 1, chatStatus: "running",
    })).toBe(false);
    expect(isOpenSourceDelegation({
      id: "c", status: "sent", completed_at: null, created_at: "2026-08-21 00:00:00", busy: 0, chatStatus: "running",
    })).toBe(false);
    expect(isOpenSourceDelegation({
      id: "d", status: "sent", completed_at: null, created_at: "2026-08-21 00:00:00", busy: 1, chatStatus: "running",
    })).toBe(true);
    expect(isOpenSourceDelegation({
      id: "e", status: "pending", completed_at: null, created_at: "2026-08-21 00:00:00", busy: 0, chatStatus: "starting",
    })).toBe(true);
  });

  it("실시간 주기에서 찾은 실행 중 채팅의 턴 종료만 훅 관찰기에 알린다(#93)", () => {
    const cwd = makeDir("wam-notify-cwd-");
    const observed: Array<[string, number]> = [];
    const observer = { recordPollingTurnEnd: (provider: string, chatId: number) => { observed.push([provider, chatId]); } };
    const startup = buildSynchronizer(cwd, undefined, observer);
    const startupFile = writeClaudeSession(startup.historyRoot, "startup-scan", cwd, true);
    insertChat(startup.database, { projectId: startup.projectId, sessionId: "startup-scan", historyFile: startupFile });
    startup.sync.syncAll(false);
    expect(observed).toEqual([]); // 서버 시작 스캔의 과거 턴은 세지 않는다.
    startup.database.close();

    const live = buildSynchronizer(cwd, undefined, observer);
    const liveFile = writeClaudeSession(live.historyRoot, "live-turn", cwd, true);
    const chatId = insertChat(live.database, { projectId: live.projectId, sessionId: "live-turn", historyFile: liveFile, busy: 1 });
    live.sync.syncAll(true);
    expect(observed).toEqual([["claude", chatId]]);
    live.database.close();
  });
});
