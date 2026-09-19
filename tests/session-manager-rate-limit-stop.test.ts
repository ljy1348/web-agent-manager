import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { SessionManager } from "../src/server/services/session-manager";

afterEach(() => vi.useRealTimers());

// 실제 터미널이 없는 테스트용 SessionManager와 채팅을 구성한다.
function buildManager(): { dataDir: string; database: ReturnType<typeof openDatabase>; manager: SessionManager; chatId: number } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-session-limit-stop-"));
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')").run();
  const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
  database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'web-agent-manager-test-limit-stop', 'running', 'ui', 0)").run(project.id);
  const chatId = (database.prepare("SELECT id FROM chats").get() as { id: number }).id;
  const realtime = { setTerminalHandlers: () => undefined, broadcast: () => undefined };
  const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined };
  const notifications = { notify: async () => undefined };
  const manager = new SessionManager(database, [], realtime as never, approvals as never, notifications, { resolveForChat: () => ({ id: 1, config_dir: null }), environment: () => ({}) } as never);
  return { dataDir, database, manager, chatId };
}

describe("SessionManager 리밋 대기 종료", () => {
  it("사용자가 터미널을 종료하면 리밋 대기를 취소하고 자동 입력으로 다시 시작하지 않는다", async () => {
    const { dataDir, database, manager, chatId } = buildManager();
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider, resume_after) VALUES (?, 'codex', ?)").run(chatId, new Date(Date.now() + 60_000).toISOString());

    await manager.stop(chatId, { id: null } as never);

    expect(database.prepare("SELECT * FROM rate_limit_waits WHERE chat_id = ?").get(chatId)).toBeUndefined();
    expect(database.prepare("SELECT status FROM chats WHERE id = ?").get(chatId)).toBeUndefined();
    await expect(manager.sendPromptIfRunning(chatId, "계속", null)).resolves.toBe(false);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("SessionManager 상태 판정 캐시", () => {
  it("화면 원문 대신 지문만 보관하고 같은 판정의 화면 변화는 30초 간격으로 제한한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const { dataDir, database, manager } = buildManager();
    const internal = manager as any;

    internal.logStateCheck("busy", 1, "spinner frame 1 with private prompt", { isBusy: true });
    const first = internal.lastStateLog.get("busy:1");
    expect(first).toMatchObject({ result: '{"isBusy":true}', loggedAt: Date.now() });
    expect(JSON.stringify(first)).not.toContain("private prompt");

    vi.advanceTimersByTime(10_000);
    internal.logStateCheck("busy", 1, "spinner frame 2 with private prompt", { isBusy: true });
    expect(internal.lastStateLog.get("busy:1")).toEqual(first);

    vi.advanceTimersByTime(20_001);
    internal.logStateCheck("busy", 1, "spinner frame 3 with private prompt", { isBusy: true });
    expect(internal.lastStateLog.get("busy:1").loggedAt).toBe(Date.now());
    expect(internal.lastStateLog.get("busy:1").fingerprint).not.toBe(first.fingerprint);

    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("채팅이 끝나면 그 채팅의 상태·입력 큐·마지막 프롬프트 캐시만 제거한다", () => {
    const { dataDir, database, manager } = buildManager();
    const internal = manager as any;
    internal.lastStateLog.set("busy:1", { fingerprint: "a", result: "true", loggedAt: 1 });
    internal.lastStateLog.set("approval:1", { fingerprint: "b", result: "null", loggedAt: 1 });
    internal.lastStateLog.set("busy:2", { fingerprint: "c", result: "false", loggedAt: 1 });
    internal.inputQueues.set(1, Promise.resolve());
    internal.inputQueues.set(2, Promise.resolve());
    internal.lastPromptText.set(1, "one");
    internal.lastPromptText.set(2, "two");

    internal.clearChatCaches(1);

    expect([...internal.lastStateLog.keys()]).toEqual(["busy:2"]);
    expect(internal.inputQueues.has(1)).toBe(false);
    expect(internal.lastPromptText.has(1)).toBe(false);
    expect(internal.inputQueues.has(2)).toBe(true);
    expect(internal.lastPromptText.get(2)).toBe("two");

    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("SessionManager StopFailure 리밋 보완 등록(#94)", () => {
  // Claude 채팅과 표시 이름만 가진 어댑터 대역으로 알림 문구까지 만들 수 있게 구성한다.
  function buildClaudeManager(status = "running") {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-hook-limit-"));
    const database = openDatabase({ dataDir } as unknown as AppConfig);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')").run();
    const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
    const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'claude', 'wam-hook-limit', ?, 'ui', 0)").run(project.id, status).lastInsertRowid);
    const sent: string[] = [];
    const realtime = { setTerminalHandlers: () => undefined, broadcast: () => undefined };
    const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined };
    const notifications = { notify: async (eventId: string) => { sent.push(eventId); } };
    const manager = new SessionManager(database, [{ id: "claude", displayLabel: "Claude" } as never], realtime as never, approvals as never, notifications, { resolveForChat: () => ({ id: 1, config_dir: null }), environment: () => ({}) } as never);
    return { dataDir, database, manager, chatId, sent };
  }

  it("화면 감지가 등록하지 않았을 때만 훅 세부 문구의 리셋 시각으로 대기를 등록하고 알린다", () => {
    const { dataDir, database, manager, chatId, sent } = buildClaudeManager();

    expect(manager.registerRateLimitWaitFromHook(chatId, "You've hit your limit · resets 3am (Asia/Seoul)")).toBe(true);
    const wait = database.prepare("SELECT provider, resume_after AS resumeAfter FROM rate_limit_waits WHERE chat_id = ?").get(chatId) as { provider: string; resumeAfter: string | null };
    expect(wait.provider).toBe("claude");
    expect(wait.resumeAfter).not.toBeNull();
    expect(sent).toHaveLength(1);

    // 이미 대기가 있으면(화면 감지가 먼저 등록) 리셋 시각을 덮지 않고 알림도 다시 보내지 않는다.
    expect(manager.registerRateLimitWaitFromHook(chatId, null)).toBe(false);
    expect((database.prepare("SELECT resume_after AS resumeAfter FROM rate_limit_waits WHERE chat_id = ?").get(chatId) as { resumeAfter: string }).resumeAfter).toBe(wait.resumeAfter);
    expect(sent).toHaveLength(1);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("리셋 시각을 못 읽으면 비워 두어 사용량 회복 확인에 맡기고, 종료된 채팅은 등록하지 않는다", () => {
    const running = buildClaudeManager();
    expect(running.manager.registerRateLimitWaitFromHook(running.chatId, "rate limited")).toBe(true);
    expect(running.database.prepare("SELECT resume_after AS resumeAfter FROM rate_limit_waits WHERE chat_id = ?").get(running.chatId)).toEqual({ resumeAfter: null });
    running.database.close();
    fs.rmSync(running.dataDir, { recursive: true, force: true });

    const stopped = buildClaudeManager("stopped");
    expect(stopped.manager.registerRateLimitWaitFromHook(stopped.chatId, null)).toBe(false);
    expect(stopped.database.prepare("SELECT 1 FROM rate_limit_waits").get()).toBeUndefined();
    stopped.database.close();
    fs.rmSync(stopped.dataDir, { recursive: true, force: true });
  });
});
