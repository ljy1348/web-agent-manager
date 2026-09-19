import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { TaskBoardService } from "../src/server/services/task-board";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(): { root: string; database: AppDatabase; board: TaskBoardService; projectId: number; accounts: Record<string, number> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-task-board-"));
  roots.push(root);
  const config = loadConfig(); config.dataDir = root;
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('보드 프로젝트', '/workspace/board')").run().lastInsertRowid);
  const accounts = Object.fromEntries((database.prepare("SELECT provider, id FROM agent_accounts").all() as Array<{ provider: string; id: number }>).map((row) => [row.provider, row.id]));
  return { root, database, board: new TaskBoardService(database), projectId, accounts };
}

function addTask(database: AppDatabase, projectId: number, accountId: number, id: string, provider: string, state: string, busy = 0): number {
  const chatId = Number(database.prepare(`INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title, busy)
    VALUES (?, ?, ?, ?, 'stopped', ?, ?)`).run(projectId, provider, accountId, `board_${id}`, `채팅 ${id}`, busy).lastInsertRowid);
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, created_by, state, goal) VALUES (?, ?, ?, 1, ?, ?)").run(id, chatId, projectId, state, `${id} 목표`);
  return chatId;
}

describe("목표 작업 보드와 자원 라우팅", () => {
  it("상태·rate limit·idle·일정을 서로 다른 보드 신호로 복원한다", () => {
    const { database, board, projectId, accounts } = fixture();
    addTask(database, projectId, accounts.codex, "working", "codex", "running", 1);
    addTask(database, projectId, accounts.codex, "idle", "codex", "running", 0);
    const waitingChat = addTask(database, projectId, accounts.claude, "input", "claude", "needs_input", 0);
    addTask(database, projectId, accounts.grok, "verify", "grok", "verifying");
    addTask(database, projectId, accounts.grok, "failed", "grok", "failed");
    addTask(database, projectId, accounts.grok, "done", "grok", "completed");
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider, resume_after) VALUES (?, 'claude', '2026-09-13 09:00:00')").run(waitingChat);
    database.prepare(`INSERT INTO prompt_schedules(name, project_id, mode, provider, account_id, prompt, daily_time, timezone, created_by)
      VALUES ('아침 점검', ?, 'new_chat', 'codex', ?, 'check', '09:00', 'Asia/Seoul', 1)`).run(projectId, accounts.codex);

    const result = board.list() as { columns: Record<string, Array<Record<string, unknown>>> };
    expect(result.columns.working.map((task) => task.activityKind)).toEqual(expect.arrayContaining(["active", "idle"]));
    expect(result.columns.needs_input[0]).toMatchObject({ id: "input", activityKind: "rate_limit_wait", resume_after: "2026-09-13 09:00:00" });
    expect(result.columns.verifying[0].id).toBe("verify");
    expect(result.columns.failed[0].id).toBe("failed");
    expect(result.columns.completed[0].id).toBe("done");
    expect(result.columns.scheduled[0]).toMatchObject({ name: "아침 점검", project_name: "보드 프로젝트" });
  });

  it("계획 metadata를 멱등 저장하고 재기동 뒤 profile·verified checkpoint와 함께 유지한다", () => {
    const { root, database, board, projectId, accounts } = fixture();
    addTask(database, projectId, accounts.codex, "plan", "codex", "needs_input");
    database.prepare("UPDATE agent_tasks SET profile_version_id = NULL, last_verified_checkpoint = ? WHERE id = 'plan'").run(JSON.stringify({ runId: "verification-1", commitHash: "abc" }));
    const input = { goal: "릴리즈 준비", acceptanceCriteria: ["전체 테스트 통과"], checkpoints: [{ id: "qa", label: "QA", status: "completed" }], nextAction: "배포 승인 요청", budget: { tokens: 100000, activeMinutes: 60 }, priority: 90 };
    board.update("plan", input, "update-1");
    board.update("plan", { goal: "무시되어야 함" }, "update-1");
    database.close();

    const config = loadConfig(); config.dataDir = root;
    const reopened = openDatabase(config);
    const restored = new TaskBoardService(reopened).list() as { columns: Record<string, Array<Record<string, any>>> };
    expect(restored.columns.needs_input[0]).toMatchObject({ goal: "릴리즈 준비", next_action: "배포 승인 요청", priority: 90, profile_version_id: null });
    expect(restored.columns.needs_input[0].acceptanceCriteria).toEqual(["전체 테스트 통과"]);
    expect(restored.columns.needs_input[0].checkpoints).toEqual([{ id: "qa", label: "QA", status: "completed" }]);
    expect(restored.columns.needs_input[0].budget).toEqual({ tokens: 100000, activeMinutes: 60 });
    expect(restored.columns.needs_input[0].lastVerifiedCheckpoint).toMatchObject({ runId: "verification-1", commitHash: "abc" });
    reopened.close();
  });

  it("사용량·reset·capability·동시 실행을 근거로 추천하고 승인 전에는 채팅을 바꾸지 않는다", () => {
    const { database, board, projectId, accounts } = fixture();
    const chatId = addTask(database, projectId, accounts.codex, "route", "codex", "needs_input");
    database.prepare("INSERT INTO usage_status(provider, account_id, data_status, remaining_percent, reset_at) VALUES ('codex', ?, 'fresh', 15, '2026-09-13 01:00:00')").run(accounts.codex);
    database.prepare("INSERT INTO usage_status(provider, account_id, data_status, remaining_percent, reset_at) VALUES ('claude', ?, 'fresh', 90, '2026-09-14 01:00:00')").run(accounts.claude);
    database.prepare(`INSERT INTO provider_capability_snapshots(id, provider, cli_version_key, transport, capabilities_json, checked_at)
      VALUES ('cap', 'claude', '1', 'hook_jsonl_tui', '{"resume":true,"interrupt":true}', CURRENT_TIMESTAMP)`).run();
    board.setLimit("provider", "claude", 1, 1);
    addTask(database, projectId, accounts.claude, "claude-active", "claude", "running", 1);

    const result = board.recommend("route", "recommend-1", 1) as { recommendation: { id: string; candidates: Array<Record<string, any>> }; replayed: boolean };
    expect(result.replayed).toBe(false);
    const claude = result.recommendation.candidates.find((item) => item.provider === "claude")!;
    expect(claude).toMatchObject({ remainingPercent: 90, resetAt: "2026-09-14 01:00:00", eligible: false, capability: { resume: true, interrupt: true } });
    expect((database.prepare("SELECT provider, account_id FROM chats WHERE id = ?").get(chatId))).toEqual({ provider: "codex", account_id: accounts.codex });
    expect((board.recommend("route", "recommend-1", 1) as { replayed: boolean }).replayed).toBe(true);

    const applied = board.apply("route", result.recommendation.id, "claude", accounts.claude, 1);
    expect(applied).toMatchObject({ applied: true, queueState: "queued" });
    expect(database.prepare("SELECT provider, account_id FROM chats WHERE id = ?").get(chatId)).toEqual({ provider: "claude", account_id: accounts.claude });
    expect(database.prepare("SELECT state, priority FROM task_queue_entries WHERE task_id = 'route'").get()).toEqual({ state: "queued", priority: 50 });
  });

  it("2,000개 task 중 최신 1,000개 보드 투영을 1초 안에 반환한다", () => {
    const { database, board, projectId, accounts } = fixture();
    const insertChat = database.prepare("INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title, busy) VALUES (?, 'codex', ?, ?, 'stopped', ?, 0)");
    const insertTask = database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state, priority) VALUES (?, ?, ?, 'completed', ?)");
    database.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        const chatId = Number(insertChat.run(projectId, accounts.codex, `perf_${index}`, `성능 ${index}`).lastInsertRowid);
        insertTask.run(`perf-${index}`, chatId, projectId, index % 101);
      }
    })();
    const startedAt = performance.now();
    const result = board.list(1_000) as { columns: Record<string, unknown[]> };
    const elapsed = performance.now() - startedAt;
    expect(result.columns.completed).toHaveLength(1_000);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("계정 동시 실행 상한 안에서 높은 우선순위 queue만 먼저 승인하고 종료 뒤 다음 작업을 올린다", () => {
    const { database, board, projectId, accounts } = fixture();
    addTask(database, projectId, accounts.codex, "high", "codex", "needs_input");
    addTask(database, projectId, accounts.codex, "low", "codex", "needs_input");
    database.prepare("UPDATE agent_tasks SET priority = 90 WHERE id = 'high'").run();
    database.prepare("UPDATE agent_tasks SET priority = 10 WHERE id = 'low'").run();
    database.prepare("INSERT INTO task_queue_entries(task_id, priority, state, provider, account_id) VALUES ('high', 90, 'queued', 'codex', ?)").run(accounts.codex);
    database.prepare("INSERT INTO task_queue_entries(task_id, priority, state, provider, account_id) VALUES ('low', 10, 'queued', 'codex', ?)").run(accounts.codex);
    board.setLimit("account", String(accounts.codex), 1, 1);

    expect(board.reconcileQueue()).toMatchObject({ admitted: ["high"], released: [] });
    expect(database.prepare("SELECT task_id, state FROM task_queue_entries ORDER BY priority DESC").all()).toEqual([{ task_id: "high", state: "admitted" }, { task_id: "low", state: "queued" }]);
    database.prepare("UPDATE agent_tasks SET state = 'completed' WHERE id = 'high'").run();
    expect(board.reconcileQueue()).toMatchObject({ admitted: ["low"], released: ["high"] });
  });
});
