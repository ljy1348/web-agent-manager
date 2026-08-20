import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { isLabWorkspace, HistorySynchronizer } from "../src/server/services/history-sync";
import { HistoryCache } from "../src/server/services/history-cache";
import { ApprovalService } from "../src/server/services/approval";
import { ClaudeAdapter } from "../src/server/providers/claude";
import type { RealtimeHub } from "../src/server/services/realtime";
import type { Notifier } from "../src/server/services/notifier";

// history-sync가 채팅을 어느 프로젝트에 귀속시키는지 고정한다. 세션 JSONL의 cwd는 레코드마다 갱신되므로
// 에이전트가 Bash로 `cd` 한 번만 해도 값이 바뀌는데, 예전 구현은 그 값으로 매 동기화(2초)마다 기존 채팅을
// 재귀속시키고 없는 경로면 프로젝트까지 새로 만들었다. 그 결과 채팅이 하위 디렉터리 프로젝트로 튕겨나간 뒤
// 자기 자신을 worktree 소유자로 찾아 영구 고착됐다(실사용 보고, 2026-08-14 채팅 #257).

const temporaryDirs: string[] = [];

function makeDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(directory);
  return fs.realpathSync(directory);
}

// 지정한 cwd를 기록한 Claude 세션 JSONL 한 줄을 쓴다.
function writeSession(historyRoot: string, sessionId: string, cwd: string, timestamp: string): string {
  const file = path.join(historyRoot, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId, cwd, message: { content: "작업 요청" }, timestamp }));
  return file;
}

function buildSynchronizer(config: AppConfig, historyRoot: string) {
  const database = openDatabase(config);
  const realtime = { broadcast: () => undefined } as unknown as RealtimeHub;
  const notifications: Notifier = { notify: async () => undefined };
  const adapter = new ClaudeAdapter("", {});
  (adapter as { historyRoot: string }).historyRoot = historyRoot;
  const approvals = new ApprovalService(config, database, realtime, notifications);
  const accounts = new AgentAccountService(config, database);
  const sync = new HistorySynchronizer(config, database, [adapter], realtime, notifications, new HistoryCache(), approvals, accounts);
  return { database, sync };
}

afterEach(() => {
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

describe("history-sync 프로젝트 귀속", () => {
  it("작업 중 cwd가 하위 디렉터리로 바뀌어도 채팅이 원래 프로젝트에 남고 새 프로젝트를 만들지 않는다", () => {
    const projectDir = makeDir("wam-project-");
    const historyRoot = makeDir("wam-history-");
    const dataDir = makeDir("wam-data-");
    const nested = path.join(projectDir, "artifacts");
    fs.mkdirSync(nested, { recursive: true });
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const sessionId = "cd-moves-cwd";
    const file = writeSession(historyRoot, sessionId, projectDir, "2026-08-14T00:00:00.000Z");
    const { database, sync } = buildSynchronizer(config, historyRoot);

    sync.syncAll(false);
    const before = database.prepare("SELECT project_id FROM chats WHERE provider_session_id = ?").get(sessionId) as { project_id: number };
    expect(database.prepare("SELECT path FROM projects").all()).toEqual([{ path: projectDir }]);

    // 에이전트가 `cd artifacts`를 실행한 뒤의 기록. 이후 레코드의 cwd가 하위 경로로 바뀐다.
    fs.appendFileSync(file, `\n${JSON.stringify({ type: "user", sessionId, cwd: nested, message: { content: "하위 경로에서 조사" }, timestamp: "2026-08-14T00:00:01.000Z" })}`);
    sync.syncAll(false);

    const after = database.prepare("SELECT project_id FROM chats WHERE provider_session_id = ?").get(sessionId) as { project_id: number };
    expect(after.project_id).toBe(before.project_id);
    expect(database.prepare("SELECT path FROM projects").all()).toEqual([{ path: projectDir }]);
  });

  it("등록된 프로젝트의 하위 경로에서 발견된 새 세션은 상위 프로젝트에 귀속된다", () => {
    const projectDir = makeDir("wam-project-");
    const historyRoot = makeDir("wam-history-");
    const dataDir = makeDir("wam-data-");
    // 실험 worktree·평가 작업공간처럼 앱이 만든 임시 경로에서 CLI가 도는 상황이다.
    const worktree = path.join(projectDir, "data", "experiment-worktrees", "run-1");
    fs.mkdirSync(worktree, { recursive: true });
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);

    writeSession(historyRoot, "root-session", projectDir, "2026-08-14T00:00:00.000Z");
    sync.syncAll(false);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };

    writeSession(historyRoot, "experiment-session", worktree, "2026-08-14T00:00:02.000Z");
    sync.syncAll(false);

    const chat = database.prepare("SELECT project_id FROM chats WHERE provider_session_id = ?").get("experiment-session") as { project_id: number };
    expect(chat.project_id).toBe(project.id);
    expect(database.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
  });

  it("정리한 프로젝트의 세션은 새 기록이 쌓여도 다시 채팅으로 등록되지 않는다", () => {
    const projectDir = makeDir("wam-project-");
    const historyRoot = makeDir("wam-history-");
    const dataDir = makeDir("wam-data-");
    const config = { dataDir, allowedRoots: [projectDir] } as unknown as AppConfig;
    const sessionId = "cleaned-up";
    const file = writeSession(historyRoot, sessionId, projectDir, "2026-08-14T00:00:00.000Z");
    const { database, sync } = buildSynchronizer(config, historyRoot);

    sync.syncAll(false);
    expect(database.prepare("SELECT COUNT(*) AS n FROM chats").get()).toEqual({ n: 1 });

    // 사용자가 프로젝트를 삭제(soft delete)하고 딸려 있던 채팅도 지운 상태.
    database.prepare("UPDATE projects SET active = 0 WHERE path = ?").run(projectDir);
    database.prepare("DELETE FROM chats").run();

    // 같은 세션에 기록이 더 쌓여도 정리된 상태가 유지돼야 한다.
    fs.appendFileSync(file, `\n${JSON.stringify({ type: "user", sessionId, cwd: projectDir, message: { content: "추가 작업" }, timestamp: "2026-08-14T00:00:06.000Z" })}`);
    sync.syncAll(false);

    expect(database.prepare("SELECT COUNT(*) AS n FROM chats").get()).toEqual({ n: 0 });
  });

  it("worktree 경로로 등록된 채팅은 그 소유 채팅의 프로젝트로 계속 귀속된다", () => {
    const projectDir = makeDir("wam-project-");
    const worktreeDir = makeDir("wam-worktree-");
    const historyRoot = makeDir("wam-history-");
    const dataDir = makeDir("wam-data-");
    const config = { dataDir, allowedRoots: [projectDir, worktreeDir] } as unknown as AppConfig;
    const { database, sync } = buildSynchronizer(config, historyRoot);

    writeSession(historyRoot, "owner-session", projectDir, "2026-08-14T00:00:00.000Z");
    sync.syncAll(false);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir) as { id: number };
    // 사용자가 만든 worktree 채팅은 아직 세션이 붙기 전이라 provider_session_id가 비어 있다.
    database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, worktree_path, git_branch, created_at, updated_at)
      VALUES (?, 'claude', 'web_agent_manager_wt', 'stopped', '워크트리 작업', ?, 'feature/x', ?, ?)
    `).run(project.id, worktreeDir, "2026-08-14T00:00:00.000Z", "2026-08-14T00:00:00.000Z");

    writeSession(historyRoot, "worktree-session", worktreeDir, "2026-08-14T00:00:03.000Z");
    sync.syncAll(false);

    const chat = database.prepare("SELECT project_id, worktree_path FROM chats WHERE provider_session_id = ?").get("worktree-session") as { project_id: number; worktree_path: string };
    expect(chat.project_id).toBe(project.id);
    expect(chat.worktree_path).toBe(worktreeDir);
    // worktree 경로가 별도 프로젝트로 등록되면 원본 화면에서 답변이 보이지 않는다.
    expect(database.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 1 });
  });
});

describe("실험실 작업공간 세션 제외", () => {
  it("실험 worktree와 평가 작업공간 경로만 랩 세션으로 판정한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-lab-scope-"));
    const worktree = path.join(dataDir, "experiment-worktrees", "run-1");
    const evaluation = path.join(dataDir, "evaluation-workspaces", "eval-1");
    const normal = path.join(dataDir, "git-worktrees", "13", "200");
    for (const dir of [worktree, evaluation, normal]) fs.mkdirSync(dir, { recursive: true });

    expect(isLabWorkspace(worktree, dataDir)).toBe(true);
    expect(isLabWorkspace(evaluation, dataDir)).toBe(true);
    // 채팅 전용 worktree는 사람이 여는 작업이라 계속 채팅으로 남아야 한다.
    expect(isLabWorkspace(normal, dataDir)).toBe(false);
    expect(isLabWorkspace(dataDir, dataDir)).toBe(false);

    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
