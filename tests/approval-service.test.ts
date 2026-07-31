import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { RealtimeHub } from "../src/server/services/realtime";
import { SlackNotifier } from "../src/server/services/slack";
import { ApprovalService } from "../src/server/services/approval";
import type { Notifier } from "../src/server/services/notifier";

// 테스트마다 격리된 임시 데이터 디렉터리로 실제 스키마를 그대로 생성한다.
function createTestDatabase(): AppDatabase {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-approval-"));
  process.env.WEB_AGENT_MANAGER_DATA_DIR = dataDir;
  return openDatabase(loadConfig());
}

// httpServer.on("upgrade", ...)만 등록하면 되므로 실제 서버 없이 최소 스텁으로 대체한다.
function fakeHttpServer(): Server {
  return { on: () => undefined } as unknown as Server;
}

function createChat(database: AppDatabase): number {
  database.prepare("INSERT OR IGNORE INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  database.prepare("INSERT INTO projects(name, path) VALUES ('p', '/tmp/p')").run();
  const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
  database.prepare(`
    INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title)
    VALUES (?, 'claude', 's1', 'tmux1', 'running', 't')
  `).run(project.id);
  return (database.prepare("SELECT id FROM chats WHERE tmux_name = 'tmux1'").get() as { id: number }).id;
}

describe("ApprovalService.handleClaudeHook 중복 방지", () => {
  it("같은 채팅에 같은 tool_name+tool_input의 재시도 훅이 오면 새 승인을 만들지 않고 기존 요청에 합류한다", async () => {
    const database = createTestDatabase();
    createChat(database);
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), new SlackNotifier(loadConfig(), database));
    const input = { session_id: "s1", tool_name: "ExitPlanMode", tool_input: { plan: "내용", planFilePath: "/x.md" } };

    const first = service.handleClaudeHook(input);
    const second = service.handleClaudeHook(input);

    const pending = database.prepare("SELECT id FROM approvals WHERE status = 'pending'").all();
    expect(pending).toHaveLength(1);

    const id = (pending[0] as { id: string }).id;
    service.decide(id, "decline", { id: 1, username: "admin", role: "admin" });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "사용자가 권한을 거부했습니다.", interrupt: false } } });
    expect(secondResult).toEqual(firstResult);

    const resolved = database.prepare("SELECT status FROM approvals").all();
    expect(resolved).toEqual([{ status: "declined" }]);
  });

  it("tool_input이 다르면(진짜 다른 요청) 각각 별도 승인으로 만든다", async () => {
    const database = createTestDatabase();
    createChat(database);
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), new SlackNotifier(loadConfig(), database));
    const first = service.handleClaudeHook({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
    const second = service.handleClaudeHook({ session_id: "s1", tool_name: "Bash", tool_input: { command: "pwd" } });

    const pending = database.prepare("SELECT id FROM approvals WHERE status = 'pending'").all() as { id: string }[];
    expect(pending).toHaveLength(2);
    for (const row of pending) service.decide(row.id, "accept", { id: 1, username: "admin", role: "admin" });
    await Promise.all([first, second]);
  });

  it("터미널 승인 알림에는 resume 요약 내용을 포함한다", async () => {
    const database = createTestDatabase();
    const chatId = createChat(database);
    const calls: Array<{ eventType: string; text: string }> = [];
    const notifier: Notifier = { notify: async (_id, eventType, text) => { calls.push({ eventType, text }); } };
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), notifier);

    service.createTerminalApproval(chatId, "claude", "1. Resume from summary (recommended)\n2. Resume full session as-is", "resume_session_prompt", true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    expect(calls[0].eventType).toBe("approval_requested");
    expect(calls[0].text).toContain("요청: 1. Resume from summary");
  });
});
