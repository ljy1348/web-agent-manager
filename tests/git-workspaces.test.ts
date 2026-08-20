import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { assertGitBranch, GitWorkspaceService, parseGitWorktrees } from "../src/server/services/git-workspaces";

interface Harness {
  root: string;
  repo: string;
  database: AppDatabase;
  service: GitWorkspaceService;
  projectId: number;
  chatIds: number[];
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

// 채팅별 worktree 동작을 실제 Git 명령으로 검증할 임시 저장소와 DB를 만든다.
function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-worktrees-"));
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "초기 내용\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "초기 커밋"], { cwd: repo });

  const config = { dataDir } as AppConfig;
  const database = openDatabase(config);
  const project = database.prepare("INSERT INTO projects(name, path, source) VALUES ('repo', ?, 'manual')").run(repo);
  const projectId = Number(project.lastInsertRowid);
  const chatIds = [1, 2].map((index) => Number(database.prepare(`
    INSERT INTO chats(project_id, provider, tmux_name, status, title) VALUES (?, 'codex', ?, 'stopped', ?)
  `).run(projectId, `test_chat_${index}`, `채팅 ${index}`).lastInsertRowid));
  const service = new GitWorkspaceService(database, config);
  cleanups.push(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, database, service, projectId, chatIds };
}

describe("GitWorkspaceService", () => {
  it("이슈 번호가 포함된 실제 Git 브랜치 이름을 허용한다", () => {
    expect(assertGitBranch("feat/#567")).toBe("feat/#567");
    expect(() => assertGitBranch("--upload-pack=bad")).toThrow("유효하지 않은 브랜치");
  });

  it("porcelain worktree 출력을 브랜치와 detached 상태로 구분한다", () => {
    expect(parseGitWorktrees([
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt",
      "HEAD def456",
      "detached",
    ].join("\n"))).toEqual([
      { path: "/repo", head: "abc123", branch: "main" },
      { path: "/repo-wt", head: "def456", branch: null },
    ]);
  });

  it("프로젝트 공유 checkout을 유지한 채 채팅마다 다른 전용 브랜치를 만든다", async () => {
    const { repo, database, service, projectId, chatIds } = createHarness();
    const first = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/chat-one", create: true, mode: "worktree" });
    const second = await service.switchBranch(projectId, { chatId: chatIds[1], branch: "feature/chat-two", create: true, mode: "worktree" });

    expect(execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim()).toBe("main");
    expect(first.branch).toBe("feature/chat-one");
    expect(second.branch).toBe("feature/chat-two");
    expect(first.path).not.toBe(second.path);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: first.path, encoding: "utf8" }).trim()).toBe("feature/chat-one");
    const rows = database.prepare("SELECT git_branch, worktree_path FROM chats ORDER BY id").all() as Array<{ git_branch: string; worktree_path: string }>;
    expect(rows.map((row) => row.git_branch)).toEqual(["feature/chat-one", "feature/chat-two"]);
    expect(rows.every((row) => Boolean(row.worktree_path))).toBe(true);
  });

  it("git에 없는 로컬 지침을 새 worktree에 복사하고 커밋된 지침은 덮어쓰지 않는다", async () => {
    const { repo, service, projectId, chatIds } = createHarness();
    // CLAUDE.local.md는 git에 올리지 않는 로컬 전용 지침이라 worktree에 체크아웃되지 않는다.
    fs.writeFileSync(path.join(repo, "CLAUDE.local.md"), "로컬 전용 지침", "utf8");
    fs.writeFileSync(path.join(repo, "AGENTS.override.md"), "Codex 로컬 지침", "utf8");
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "CLAUDE.md"), "디렉터리 지침", "utf8");
    // 반대로 AGENTS.md는 커밋해 두고 원본만 고쳐, worktree의 커밋된 버전이 유지되는지 확인한다.
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "커밋된 지침", "utf8");
    execFileSync("git", ["add", "AGENTS.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "지침 추가"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "원본에서만 고친 지침", "utf8");

    const workspace = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/with-instructions", create: true, mode: "worktree" });

    expect(fs.readFileSync(path.join(workspace.path, "CLAUDE.local.md"), "utf8")).toBe("로컬 전용 지침");
    expect(fs.readFileSync(path.join(workspace.path, "AGENTS.override.md"), "utf8")).toBe("Codex 로컬 지침");
    expect(fs.readFileSync(path.join(workspace.path, ".claude", "CLAUDE.md"), "utf8")).toBe("디렉터리 지침");
    expect(fs.readFileSync(path.join(workspace.path, "AGENTS.md"), "utf8")).toBe("커밋된 지침");
  });

  it("같은 브랜치를 고른 채팅들은 한 worktree 폴더를 공유한다", async () => {
    const { service, projectId, chatIds } = createHarness();

    const first = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/shared", create: true, mode: "worktree" });
    const second = await service.switchBranch(projectId, { chatId: chatIds[1], branch: "feature/shared", create: false, mode: "worktree" });

    expect(second.path).toBe(first.path);
    expect(second.branch).toBe("feature/shared");
  });

  it("공유 중인 worktree는 한 채팅이 떠나도 폴더를 지우지 않는다", async () => {
    const { service, projectId, chatIds } = createHarness();
    const workspace = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/shared", create: true, mode: "worktree" });
    await service.switchBranch(projectId, { chatId: chatIds[1], branch: "feature/shared", create: false, mode: "worktree" });

    await service.removeChatWorktree(chatIds[0]);

    expect(fs.existsSync(workspace.path)).toBe(true);
    const remaining = await service.describe(projectId, chatIds[1]);
    expect(remaining.path).toBe(workspace.path);
  });

  it("미커밋 변경이 있는 worktree 정리는 막고 force에서만 지운다", async () => {
    const { service, projectId, chatIds } = createHarness();
    const workspace = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/cleanup", create: true, mode: "worktree" });
    fs.writeFileSync(path.join(workspace.path, "dirty.txt"), "아직 커밋 안 함", "utf8");

    await expect(service.removeWorktree(projectId, workspace.path)).rejects.toThrow();
    const forced = await service.removeWorktree(projectId, workspace.path, { force: true });

    expect(forced.removed).toBe(true);
    expect(forced.detachedChatIds).toEqual([chatIds[0]]);
    expect(fs.existsSync(workspace.path)).toBe(false);
  });

  it("worktree를 지우면 비게 된 프로젝트 폴더도 함께 치운다", async () => {
    const { service, projectId, chatIds } = createHarness();
    const workspace = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/tidy", create: true, mode: "worktree" });
    const parent = path.dirname(workspace.path);
    expect(fs.existsSync(parent)).toBe(true);

    await service.removeWorktree(projectId, workspace.path);

    expect(fs.existsSync(workspace.path)).toBe(false);
    expect(fs.existsSync(parent)).toBe(false);
  });

  it("같은 프로젝트에 다른 worktree가 남아 있으면 상위 폴더를 지우지 않는다", async () => {
    const { service, projectId, chatIds } = createHarness();
    const first = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/keep-a", create: true, mode: "worktree" });
    const second = await service.switchBranch(projectId, { chatId: chatIds[1], branch: "feature/keep-b", create: true, mode: "worktree" });

    await service.removeWorktree(projectId, first.path);

    expect(fs.existsSync(first.path)).toBe(false);
    expect(fs.existsSync(second.path)).toBe(true);
    expect(fs.existsSync(path.dirname(second.path))).toBe(true);
  });

  it("실행 중인 채팅이 쓰는 worktree는 정리하지 않는다", async () => {
    const { database, service, projectId, chatIds } = createHarness();
    const workspace = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/busy", create: true, mode: "worktree" });
    database.prepare("UPDATE chats SET status = 'running' WHERE id = ?").run(chatIds[0]);

    await expect(service.removeWorktree(projectId, workspace.path, { force: true })).rejects.toThrow("실행 중인 채팅");
    expect(fs.existsSync(workspace.path)).toBe(true);
  });

  it("프로젝트 기본 checkout은 정리 대상에서 제외한다", async () => {
    const { repo, service, projectId } = createHarness();

    await expect(service.removeWorktree(projectId, repo)).rejects.toThrow("기본 checkout");
  });

  it("복사할 로컬 지침이 없어도 worktree 생성은 정상 동작한다", async () => {
    const { service, projectId, chatIds } = createHarness();

    const workspace = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/no-instructions", create: true, mode: "worktree" });

    expect(workspace.branch).toBe("feature/no-instructions");
    expect(fs.existsSync(path.join(workspace.path, "CLAUDE.local.md"))).toBe(false);
  });

  it("AI가 외부에서 만든 미연결 worktree를 발견해 지정 채팅에 연결한다", async () => {
    const { root, repo, database, service, projectId, chatIds } = createHarness();
    const external = path.join(root, "agent-created-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/agent", external], { cwd: repo });

    const before = await service.describe(projectId, chatIds[0]);
    expect(before.worktrees).toContainEqual(expect.objectContaining({ path: external, branch: "feature/agent", appManaged: false, assignedChatId: null }));
    const attached = await service.attachWorktree(projectId, chatIds[0], external);

    expect(attached.mode).toBe("worktree");
    expect(attached.branch).toBe("feature/agent");
    expect((database.prepare("SELECT worktree_path FROM chats WHERE id = ?").get(chatIds[0]) as { worktree_path: string }).worktree_path).toBe(external);
    fs.writeFileSync(path.join(external, "agent-change.txt"), "외부 변경\n");
    await expect(service.switchBranch(projectId, { chatId: chatIds[0], branch: "main", mode: "shared" })).rejects.toThrow("미커밋 변경사항");
  });

  it("외부 worktree가 쓰는 브랜치는 브랜치 지정만으로 붙일 수 없고 경로 지정으로 공유한다", async () => {
    const { root, repo, service, projectId, chatIds } = createHarness();
    const external = path.join(root, "agent-created-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/agent", external], { cwd: repo });

    // 브랜치만 넘기면 앱 관리 경로에 새로 만들려다 Git이 중복 체크아웃을 막는다.
    await expect(service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/agent", mode: "worktree" })).rejects.toThrow();
    // 채팅 없는 worktree 묶음에서 새 채팅을 시작할 수 있도록, 경로를 직접 지정하면 그 폴더를 그대로 쓴다.
    const attached = await service.attachWorktree(projectId, chatIds[1], external);
    expect(attached.path).toBe(external);
    expect(attached.branch).toBe("feature/agent");
  });

  it("실행 중 채팅 또는 미커밋 변경이 있는 worktree 전환을 차단한다", async () => {
    const { database, service, projectId, chatIds } = createHarness();
    database.prepare("UPDATE chats SET status = 'running' WHERE id = ?").run(chatIds[0]);
    await expect(service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/running", create: true, mode: "worktree" })).rejects.toThrow("터미널을 종료");

    database.prepare("UPDATE chats SET status = 'stopped' WHERE id = ?").run(chatIds[0]);
    const workspace = await service.switchBranch(projectId, { chatId: chatIds[0], branch: "feature/dirty", create: true, mode: "worktree" });
    fs.writeFileSync(path.join(workspace.path, "dirty.txt"), "미커밋\n");
    await expect(service.switchBranch(projectId, { chatId: chatIds[0], branch: "main", mode: "shared" })).rejects.toThrow("미커밋 변경사항");
  });
});
