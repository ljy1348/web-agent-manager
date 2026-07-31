import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { SessionManager } from "../src/server/services/session-manager";

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
  const manager = new SessionManager(database, [], realtime as never, approvals as never, notifications);
  return { dataDir, database, manager, chatId };
}

describe("SessionManager 리밋 대기 종료", () => {
  it("사용자가 터미널을 종료하면 리밋 대기를 취소하고 자동 입력으로 다시 시작하지 않는다", async () => {
    const { dataDir, database, manager, chatId } = buildManager();
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider, resume_after) VALUES (?, 'codex', ?)").run(chatId, new Date(Date.now() + 60_000).toISOString());

    await manager.stop(chatId, { id: null } as never);

    expect(database.prepare("SELECT * FROM rate_limit_waits WHERE chat_id = ?").get(chatId)).toBeUndefined();
    expect((database.prepare("SELECT status FROM chats WHERE id = ?").get(chatId) as { status: string }).status).toBe("stopped");
    await expect(manager.sendPromptIfRunning(chatId, "계속", null)).resolves.toBe(false);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
