import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { HistorySynchronizer } from "../src/server/services/history-sync";
import { HistoryCache } from "../src/server/services/history-cache";
import { ApprovalService } from "../src/server/services/approval";
import { ClaudeAdapter } from "../src/server/providers/claude";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { RealtimeHub } from "../src/server/services/realtime";
import type { Notifier } from "../src/server/services/notifier";

// 동시에 만든 미귀속 채팅에 세션이 돌아가며 붙는 회귀를 고정한다. 운영에서 관측된 회전은
// 세션을 오래된 것부터 처리하면서 "가장 최근 미귀속 채팅"을 집어 가는 방식 때문에 생겼다.

const temporaryDirs: string[] = [];

function makeDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(directory);
  return fs.realpathSync(directory);
}

// 지정한 세션 ID와 cwd를 기록한 Claude JSONL을 쓴다.
function writeSession(historyRoot: string, sessionId: string, cwd: string, timestamp: string, content = `${sessionId} 요청`): string {
  const file = path.join(historyRoot, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId, cwd, message: { content }, timestamp }));
  return file;
}

// claim과 첫 user 기록 시각을 현재 기준으로 만든다. history-sync가 SQL `now` 기준 1일 지난 claim을
// 지우므로, 고정 날짜를 쓰면 작성 다음 날부터 claim이 먼저 삭제돼 테스트가 날짜에 따라 깨진다.
function recentClaimTimes(): { claimedAt: string; recordedAt: string } {
  const claimed = Date.now() - 60_000;
  return { claimedAt: new Date(claimed).toISOString(), recordedAt: new Date(claimed + 64).toISOString() };
}

function buildSynchronizer(config: AppConfig, historyRoot: string, customAdapter?: ProviderAdapter) {
  const database = openDatabase(config);
  const realtime = { broadcast: () => undefined } as unknown as RealtimeHub;
  const notifications: Notifier = { notify: async () => undefined };
  const adapter = customAdapter ?? new ClaudeAdapter("", {});
  if (!customAdapter) (adapter as { historyRoot: string }).historyRoot = historyRoot;
  const approvals = new ApprovalService(config, database, realtime, notifications);
  const accounts = new AgentAccountService(config, database);
  const sync = new HistorySynchronizer(config, database, [adapter], realtime, notifications, new HistoryCache(), approvals, accounts);
  return { database, sync };
}

afterEach(() => {
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

describe("history-sync 신규 세션 귀속", () => {
  it("첫 user 메시지가 생기기 전의 미예약 세션은 다른 빈 채팅에 FIFO로 붙이지 않는다", () => {
    const projectDir = makeDir("wam-claim-empty-project-");
    const historyRoot = makeDir("wam-claim-empty-history-");
    const dataDir = makeDir("wam-claim-empty-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const emptyFile = path.join(historyRoot, "empty.jsonl");
    fs.writeFileSync(emptyFile, "empty");
    const adapter = {
      id: "codex",
      displayLabel: "Codex",
      historyRootFor: () => historyRoot,
      parseHistoryFile: () => ({
        provider: "codex",
        sessionId: "empty-session",
        cwd: projectDir,
        title: "빈 세션",
        historyFile: emptyFile,
        createdAt: "2026-09-08T13:10:38.000Z",
        updatedAt: "2026-09-08T13:10:38.000Z",
        messages: [],
      }),
    } as unknown as ProviderAdapter;
    const { database, sync } = buildSynchronizer(config, historyRoot, adapter);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };
    const chat = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, created_at, updated_at)
      VALUES (?, 'codex', 'web_agent_manager_empty', 'running', '빈 채팅', '2026-09-06 05:42:36', '2026-09-06 05:42:36')
    `).run(project.id);

    sync.syncAll(false);

    expect(database.prepare("SELECT provider_session_id AS value FROM chats WHERE id = ?").get(Number(chat.lastInsertRowid)))
      .toEqual({ value: null });
    expect((database.prepare("SELECT COUNT(*) AS count FROM chats").get() as { count: number }).count).toBe(1);
  });

  it("busy 반영보다 기록 스캔이 먼저 와도 웹 프롬프트 claim으로 정확한 채팅에 붙인다", () => {
    const projectDir = makeDir("wam-claim-web-project-");
    const historyRoot = makeDir("wam-claim-web-history-");
    const dataDir = makeDir("wam-claim-web-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };
    const older = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_web_older', 'running', '먼저 만든 빈 채팅', 0, '2026-09-06 05:42:36', '2026-09-06 05:42:36')
    `).run(project.id);
    const target = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_web_target', 'running', '질문 대상', 0, '2026-09-08 13:10:38', '2026-09-08 13:10:38')
    `).run(project.id);
    const { claimedAt, recordedAt } = recentClaimTimes();
    database.prepare("INSERT INTO chat_history_claims(chat_id, prompt, created_at) VALUES (?, ?, ?)")
      .run(Number(target.lastInsertRowid), "정확한 웹 질문", claimedAt);

    writeSession(historyRoot, "web-session", projectDir, recordedAt, "정확한 웹 질문");
    sync.syncAll(false);

    const rows = database.prepare("SELECT id, provider_session_id AS sessionId FROM chats ORDER BY id").all();
    expect(rows).toEqual([
      { id: Number(older.lastInsertRowid), sessionId: null },
      { id: Number(target.lastInsertRowid), sessionId: "web-session" },
    ]);
    expect((database.prepare("SELECT COUNT(*) AS count FROM chat_history_claims").get() as { count: number }).count).toBe(0);
  });

  it("터미널 종료가 기록 발견보다 먼저 와도 stopped 채팅의 정확한 claim을 회수한다", () => {
    const projectDir = makeDir("wam-claim-stopped-project-");
    const historyRoot = makeDir("wam-claim-stopped-history-");
    const dataDir = makeDir("wam-claim-stopped-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };
    const target = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_stopped_claim', 'stopped', '방금 끝난 채팅', '2026-09-08 13:16:15', '2026-09-08 13:16:15')
    `).run(project.id);
    const { claimedAt, recordedAt } = recentClaimTimes();
    database.prepare("INSERT INTO chat_history_claims(chat_id, prompt, created_at) VALUES (?, ?, ?)")
      .run(Number(target.lastInsertRowid), "끝나기 직전 질문", claimedAt);

    writeSession(historyRoot, "stopped-session", projectDir, recordedAt, "끝나기 직전 질문");
    sync.syncAll(false);

    expect(database.prepare("SELECT provider_session_id AS sessionId FROM chats WHERE id = ?").get(Number(target.lastInsertRowid)))
      .toEqual({ sessionId: "stopped-session" });
    expect((database.prepare("SELECT COUNT(*) AS count FROM chat_history_claims").get() as { count: number }).count).toBe(0);
  });

  it("앞선 미전송 위임 채팅이 남아도 첫 user 프롬프트가 일치하는 대상에 새 세션을 붙인다", () => {
    const projectDir = makeDir("wam-claim-delegation-project-");
    const historyRoot = makeDir("wam-claim-delegation-history-");
    const dataDir = makeDir("wam-claim-delegation-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };
    const failedFirst = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, origin, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_failed_first', 'running', '첫 위임', 1, 'delegation', '2026-08-31 18:41:13', '2026-08-31 18:41:13')
    `).run(project.id);
    const submittedSecond = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, origin, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_submitted_second', 'running', '둘째 위임', 1, 'delegation', '2026-08-31 18:48:17', '2026-08-31 18:48:17')
    `).run(project.id);
    database.prepare(`
      INSERT INTO delegations(id, idempotency_key, target_chat_id, prompt, history_prompt, status)
      VALUES ('first-delegation', 'first-key', ?, '첫 요청', '첫 요청', 'sent')
    `).run(Number(failedFirst.lastInsertRowid));
    database.prepare(`
      INSERT INTO delegations(id, idempotency_key, target_chat_id, prompt, history_prompt, status)
      VALUES ('second-delegation', 'second-key', ?, '둘째 요청', '둘째 요청', 'sent')
    `).run(Number(submittedSecond.lastInsertRowid));

    writeSession(historyRoot, "second-session", projectDir, "2026-08-31T18:48:22.000Z", "둘째 요청");
    sync.syncActive(false);

    const rows = database.prepare(`
      SELECT id, provider_session_id AS sessionId FROM chats ORDER BY id
    `).all() as Array<{ id: number; sessionId: string | null }>;
    expect(rows).toEqual([
      { id: Number(failedFirst.lastInsertRowid), sessionId: null },
      { id: Number(submittedSecond.lastInsertRowid), sessionId: "second-session" },
    ]);
  });

  it("오래된 stopped 빈 채팅 대신 방금 질문을 받은 running 채팅에 Codex형 미예약 세션을 붙인다", () => {
    const projectDir = makeDir("wam-claim-active-project-");
    const historyRoot = makeDir("wam-claim-active-history-");
    const dataDir = makeDir("wam-claim-active-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };

    const stale = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_stale', 'stopped', '옛 빈 채팅', '2026-08-13 10:43:10', '2026-08-13 10:43:10')
    `).run(project.id);
    const idleRunning = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_idle', 'running', '다른 실행 채팅', 0, '2026-08-22 08:08:00', '2026-08-22 08:08:00')
    `).run(project.id);
    const prompted = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_prompted', 'running', '질문한 채팅', 1, '2026-08-22 08:09:04', '2026-08-22 08:09:04')
    `).run(project.id);

    writeSession(historyRoot, "new-session", projectDir, "2026-08-22T08:09:28.000Z");
    // 질문을 받아 busy인 미귀속 채팅은 30초 발견 주기를 기다리지 않고 빠른 주기에서 전체 탐색한다.
    sync.syncActive(false);

    const rows = database.prepare(`
      SELECT id, provider_session_id AS sessionId FROM chats ORDER BY id
    `).all() as Array<{ id: number; sessionId: string | null }>;
    expect(rows).toEqual([
      { id: Number(stale.lastInsertRowid), sessionId: null },
      { id: Number(idleRunning.lastInsertRowid), sessionId: null },
      { id: Number(prompted.lastInsertRowid), sessionId: "new-session" },
    ]);
  });

  it("미귀속 채팅 3개에 세션 3개를 오래된 순으로 넣어도 최신 채팅부터 집어 회전하지 않는다", () => {
    const projectDir = makeDir("wam-claim-project-");
    const historyRoot = makeDir("wam-claim-history-");
    const dataDir = makeDir("wam-claim-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };

    const createdAt = ["2026-08-21 04:54:53", "2026-08-21 04:54:55", "2026-08-21 04:54:56"];
    const chatIds = createdAt.map((at, index) => {
      const result = database.prepare(`
        INSERT INTO chats(project_id, provider, tmux_name, status, title, created_at, updated_at)
        VALUES (?, 'claude', ?, 'starting', ?, ?, ?)
      `).run(project.id, `web_agent_manager_claim_${index + 1}`, `채팅 ${index + 1}`, at, at);
      return Number(result.lastInsertRowid);
    });
    const sessionIds = ["01a022ac-049f", "01a022ac-09af", "01a022ac-0fa1"];

    sessionIds.forEach((sessionId, index) => {
      writeSession(historyRoot, sessionId, projectDir, `2026-08-21T04:54:5${3 + index * 2}.000Z`);
      sync.syncAll(false);
    });

    const attached = database.prepare(`
      SELECT id, provider_session_id AS sessionId FROM chats WHERE id IN (?, ?, ?) ORDER BY id
    `).all(chatIds[0], chatIds[1], chatIds[2]) as Array<{ id: number; sessionId: string }>;
    expect(attached).toEqual([
      { id: chatIds[0], sessionId: sessionIds[0] },
      { id: chatIds[1], sessionId: sessionIds[1] },
      { id: chatIds[2], sessionId: sessionIds[2] },
    ]);
  });

  it("이미 붙은 세션은 미귀속 채팅이 있어도 다른 채팅으로 옮겨지지 않는다", () => {
    const projectDir = makeDir("wam-claim-keep-project-");
    const historyRoot = makeDir("wam-claim-keep-history-");
    const dataDir = makeDir("wam-claim-keep-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };

    database.prepare(`
      INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, created_at, updated_at)
      VALUES (?, 'claude', 'already-attached', 'web_agent_manager_keep_1', 'stopped', '기존', '2026-08-21 04:54:50', '2026-08-21 04:54:50')
    `).run(project.id);
    database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_keep_2', 'starting', '신규', '2026-08-21 04:54:59', '2026-08-21 04:54:59')
    `).run(project.id);

    writeSession(historyRoot, "already-attached", projectDir, "2026-08-21T04:54:50.000Z");
    writeSession(historyRoot, "brand-new", projectDir, "2026-08-21T04:54:59.000Z");
    sync.syncAll(false);

    const rows = database.prepare(`
      SELECT id, provider_session_id AS sessionId FROM chats ORDER BY id
    `).all() as Array<{ id: number; sessionId: string }>;
    expect(rows.map((row) => row.sessionId)).toEqual(["already-attached", "brand-new"]);
  });

  it("시작할 때 정해 둔 세션 ID가 있으면 미귀속 최신 채팅보다 그 채팅에 붙는다", () => {
    const projectDir = makeDir("wam-claim-assigned-project-");
    const historyRoot = makeDir("wam-claim-assigned-history-");
    const dataDir = makeDir("wam-claim-assigned-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };

    database.prepare(`
      INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, created_at, updated_at)
      VALUES (?, 'claude', 'assigned-older', 'web_agent_manager_assigned_1', 'starting', '먼저', '2026-08-21 04:54:53', '2026-08-21 04:54:53')
    `).run(project.id);
    database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_assigned_2', 'starting', '나중', '2026-08-21 04:54:56', '2026-08-21 04:54:56')
    `).run(project.id);

    writeSession(historyRoot, "assigned-older", projectDir, "2026-08-21T04:54:53.000Z");
    sync.syncAll(false);

    const rows = database.prepare(`
      SELECT provider_session_id AS sessionId FROM chats ORDER BY id
    `).all() as Array<{ sessionId: string | null }>;
    expect(rows.map((row) => row.sessionId)).toEqual(["assigned-older", null]);
  });

  it("/clear로 채팅에서 떼어 낸 옛 기록은 잊게 해야 다음 스캔에서 숨김 외부 채팅으로 보존된다(#91)", () => {
    const projectDir = makeDir("wam-claim-clear-project-");
    const historyRoot = makeDir("wam-claim-clear-history-");
    const dataDir = makeDir("wam-claim-clear-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'manual')").run(projectDir);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };
    const chat = Number(database.prepare(`
      INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title) VALUES (?, 'claude', 'before-clear', 'web_agent_manager_clear', 'running', 't')
    `).run(project.id).lastInsertRowid);
    const oldFile = writeSession(historyRoot, "before-clear", projectDir, new Date().toISOString(), "clear 전 질문");
    sync.syncAll(false);
    const archived = () => database.prepare("SELECT origin, status FROM chats WHERE provider_session_id = 'before-clear' AND id <> ?").get(chat);

    // SessionStart(source=clear) 훅이 채팅을 새 ID로 옮긴 상태. 옛 파일은 바뀌지 않아 그대로면 건너뛴다.
    database.prepare("UPDATE chats SET provider_session_id = 'after-clear', history_file = NULL WHERE id = ?").run(chat);
    sync.syncAll(false);
    expect(archived()).toBeUndefined();

    sync.forgetHistoryFile(oldFile);
    sync.syncAll(false);
    expect(archived()).toEqual({ origin: "delegation", status: "stopped" });
    expect(database.prepare("SELECT provider_session_id AS sessionId FROM chats WHERE id = ?").get(chat)).toEqual({ sessionId: "after-clear" });
  });
});
