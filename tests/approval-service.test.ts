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

  // 예전에는 살아있는 훅 요청의 닫기를 에러로 막았는데, 답변 전송과 닫기밖에 없는 질문 카드에서는
  // 답하지 않으려는 사용자가 훅 9분 타임아웃까지 갇혔다. 이제는 막지 않고 거부로 전달한다.
  // interrupt=false여야 한다 — 취소(cancel)로 보내면 질문 하나를 닫았을 뿐인데 진행 중인 턴 전체가
  // 중단된다.
  it("작업 중인 Claude 훅 요청도 닫기로 거부되어 즉시 풀리고 작업은 중단되지 않는다", async () => {
    const database = createTestDatabase();
    const chatId = createChat(database);
    database.prepare("UPDATE chats SET busy = 1 WHERE id = ?").run(chatId);
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), new SlackNotifier(loadConfig(), database));
    const pendingResult = service.handleClaudeHook({ session_id: "s1", tool_name: "AskUserQuestion", tool_input: { question: "선택" } });
    const approval = database.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: string };

    service.dismiss(approval.id, { id: 1, username: "admin", role: "admin" });

    await expect(pendingResult).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "사용자가 이 요청을 닫았습니다.", interrupt: false },
      },
    });
    expect(database.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(approval.id)).toEqual({ status: "declined", decision: "decline" });
  });

  it("완료된 채팅에 남은 Claude 훅 요청은 닫고 HTTP 대기도 해제한다", async () => {
    const database = createTestDatabase();
    createChat(database);
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), new SlackNotifier(loadConfig(), database));
    const pendingResult = service.handleClaudeHook({ session_id: "s1", tool_name: "AskUserQuestion", tool_input: { question: "선택" } });
    const approval = database.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: string };

    database.prepare("UPDATE chats SET busy = 0, updated_at = datetime('now', '+1 second') WHERE provider_session_id = 's1'").run();

    service.dismiss(approval.id, { id: 1, username: "admin", role: "admin" });

    await expect(pendingResult).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "이미 완료되어 닫힌 요청입니다.", interrupt: false },
      },
    });
    expect(database.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(approval.id)).toEqual({ status: "dismissed", decision: "dismiss" });
  });

  it("Claude 턴 완료 정리는 훅 승인만 종료한다", async () => {
    const database = createTestDatabase();
    const chatId = createChat(database);
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), new SlackNotifier(loadConfig(), database));
    const terminalId = service.createTerminalApproval(chatId, "claude", "선택", "confirm_yn", false);
    const hookResult = service.handleClaudeHook({ session_id: "s1", tool_name: "AskUserQuestion", tool_input: { question: "선택" } });

    service.closeCompletedClaudeApprovals(chatId, "Claude 응답이 완료되어 자동으로 정리되었습니다.");

    await expect(hookResult).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Claude 응답이 완료되어 자동으로 정리되었습니다.", interrupt: false },
      },
    });
    expect(database.prepare("SELECT status FROM approvals WHERE request_type = 'permission'").get()).toEqual({ status: "declined" });
    expect(database.prepare("SELECT status FROM approvals WHERE id = ?").get(terminalId)).toEqual({ status: "pending" });
  });

  // 터미널 승인의 키 입력은 지금 화면에 그 프롬프트가 실제로 떠 있을 때만 나가야 한다. 이미 지나간
  // 화면에 키를 보내면 그 입력이 승인 응답이 아니라 진행 중인 작업에 그대로 먹힌다.
  it("화면에서 이미 지나간 터미널 승인은 닫아도 키를 보내지 않는다", () => {
    const database = createTestDatabase();
    const chatId = createChat(database);
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), new SlackNotifier(loadConfig(), database));
    const decisions: string[] = [];
    service.setTerminalDecisionHandler((_chatId, decision) => decisions.push(decision));
    service.setTerminalLiveCheckHandler(() => false);
    const id = service.createTerminalApproval(chatId, "codex", "선택", "terminal_approval", false);

    service.dismiss(id, { id: 1, username: "admin", role: "admin" });

    expect(decisions).toEqual([]);
    expect(database.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id)).toEqual({ status: "dismissed", decision: "dismiss" });
  });

  it("화면에 살아 있는 터미널 승인은 닫으면 작업을 끊는 취소가 아니라 거부로 전달한다", () => {
    const database = createTestDatabase();
    const chatId = createChat(database);
    const service = new ApprovalService(loadConfig(), database, new RealtimeHub(fakeHttpServer(), database), new SlackNotifier(loadConfig(), database));
    const decisions: string[] = [];
    service.setTerminalDecisionHandler((_chatId, decision) => decisions.push(decision));
    service.setTerminalLiveCheckHandler(() => true);
    const id = service.createTerminalApproval(chatId, "codex", "선택", "terminal_approval", false);

    service.dismiss(id, { id: 1, username: "admin", role: "admin" });

    expect(decisions).toEqual(["decline"]);
    expect(database.prepare("SELECT status, decision FROM approvals WHERE id = ?").get(id)).toEqual({ status: "declined", decision: "decline" });
  });
});
