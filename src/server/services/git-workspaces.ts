import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../core/config";
import { PROJECT_INSTRUCTION_FILES } from "../core/instruction-files";
import type { AppDatabase } from "../core/database";

const runFile = promisify(execFile);

interface ProjectRow {
  id: number;
  path: string;
}

interface ChatWorkspaceRow {
  id: number;
  project_id: number;
  tmux_name: string;
  status: string;
  git_branch: string | null;
  worktree_path: string | null;
  project_path: string;
}

export interface GitBranchInfo {
  name: string;
  remote: boolean;
  checkedOutPath: string | null;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  main: boolean;
  appManaged: boolean;
  assignedChatId: number | null;
}

export interface GitWorkspaceInfo {
  chatId: number | null;
  branch: string | null;
  path: string;
  mode: "shared" | "worktree";
  dirty: boolean;
  canSwitch: boolean;
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
}

export interface SwitchGitWorkspaceInput {
  chatId?: number | null;
  branch: string;
  create?: boolean;
  mode?: "shared" | "worktree";
}

interface ParsedWorktree {
  path: string;
  branch: string | null;
  head: string;
}

// Git 명령 실패의 stderr를 사용자에게 전달할 수 있는 오류로 정리한다.
async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runFile("git", args, { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024, env: process.env });
    return stdout.trim();
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new Error(detail.stderr?.trim() || detail.message || "Git 명령을 실행하지 못했습니다.");
  }
}

// Git 브랜치 이름을 명령 인자로 안전하게 전달할 수 있는 형식으로 제한한다.
export function assertGitBranch(branch: string): string {
  const value = branch.trim();
  if (!/^[A-Za-z0-9._/#@+-]{1,200}$/.test(value) || value.includes("..") || value.includes("@{") || value.startsWith("-") || value.endsWith("/")) {
    throw new Error("유효하지 않은 브랜치 이름입니다.");
  }
  return value;
}

// `git worktree list --porcelain` 출력을 작업 경로·브랜치 구조로 변환한다.
export function parseGitWorktrees(output: string): ParsedWorktree[] {
  return output.split(/\n\n+/).map((block) => {
    const entries: Array<[string, string]> = block.split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf(" ");
      return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    });
    const values = new Map(entries);
    const worktreePath = values.get("worktree") ?? "";
    const branchRef = values.get("branch") ?? "";
    return {
      path: worktreePath,
      head: values.get("HEAD") ?? "",
      branch: branchRef.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null,
    };
  }).filter((item) => item.path);
}

// 대상 경로가 루트와 같거나 그 하위인지 확인한다.
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// 프로젝트의 공유 checkout과 채팅별 전용·외부 worktree 연결을 관리한다.
export class GitWorkspaceService {
  private readonly root: string;

  constructor(private readonly database: AppDatabase, config: Pick<AppConfig, "dataDir">) {
    this.root = path.resolve(config.dataDir, "git-worktrees");
  }

  // 서버 시작 시 공유 브랜치와 tmux가 실제로 들어간 외부 worktree 연결을 복원한다.
  async initialize(): Promise<void> {
    const projects = this.database.prepare("SELECT id, path FROM projects WHERE active = 1").all() as ProjectRow[];
    for (const project of projects) {
      try {
        const branch = await this.currentBranch(fs.realpathSync(project.path));
        this.database.prepare("UPDATE chats SET git_branch = ? WHERE project_id = ? AND worktree_path IS NULL").run(branch, project.id);
        await this.syncTmuxAssignments(project.id);
      } catch {
        // Git 저장소가 아닌 프로젝트는 기존 파일·채팅 기능을 그대로 사용한다.
      }
    }
  }

  // 프로젝트 공유 checkout의 현재 브랜치를 반환한다.
  async projectBranch(projectId: number): Promise<string | null> {
    return this.currentBranch(this.project(projectId).path);
  }

  // 요청한 프로젝트·채팅이 실제로 사용하는 저장소 경로를 반환한다.
  workspacePath(projectId: number, chatId?: number | null): string {
    const project = this.project(projectId);
    if (!chatId) return project.path;
    const chat = this.chat(projectId, chatId);
    if (!chat.worktree_path) return project.path;
    if (!fs.existsSync(chat.worktree_path)) throw new Error("채팅에 연결된 worktree 경로가 없습니다.");
    return fs.realpathSync(chat.worktree_path);
  }

  // 조회 화면이 지정한 작업공간 경로를 검증해 실제 경로로 바꾼다.
  // 임의 경로를 그대로 쓰면 프로젝트 밖을 읽을 수 있으므로, git이 보고하는 그 프로젝트의 실제
  // worktree 목록에 있는 경로만 허용한다.
  async resolveWorktreePath(projectId: number, requested: string): Promise<string> {
    const project = this.project(projectId);
    const target = path.resolve(requested);
    const worktrees = await this.listWorktrees(project);
    const match = worktrees.find((item) => item.path === target);
    if (!match) throw new Error("이 프로젝트의 작업공간이 아닙니다.");
    if (!fs.existsSync(match.path)) throw new Error("작업공간 경로를 찾을 수 없습니다.");
    return fs.realpathSync(match.path);
  }

  // 화면에서 고를 수 있는 작업공간 목록(공유 checkout과 모든 worktree)을 돌려준다.
  async listWorkspaces(projectId: number): Promise<GitWorktreeInfo[]> {
    return this.listWorktrees(this.project(projectId));
  }

  // 현재 브랜치·브랜치 목록·외부 worktree와 채팅 연결 상태를 조회한다.
  async describe(projectId: number, chatId?: number | null): Promise<GitWorkspaceInfo> {
    await this.syncTmuxAssignments(projectId);
    const project = this.project(projectId);
    const chat = chatId ? this.chat(projectId, chatId) : null;
    const cwd = this.workspacePath(projectId, chatId);
    const worktrees = await this.listWorktrees(project);
    const branch = await this.currentBranch(cwd);
    if (chat && (chat.git_branch !== branch || chat.worktree_path !== (cwd === project.path ? null : cwd))) {
      this.database.prepare("UPDATE chats SET git_branch = ?, worktree_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(branch, cwd === project.path ? null : cwd, chat.id);
    }
    const refs = await runGit(project.path, ["for-each-ref", "--format=%(refname:short)%09%(refname)", "refs/heads", "refs/remotes"]);
    const checkedOut = new Map(worktrees.filter((item) => item.branch).map((item) => [item.branch!, item.path]));
    const branches = refs.split("\n").filter(Boolean).map((line) => {
      const [name = "", ref = ""] = line.split("\t");
      return { name, remote: ref.startsWith("refs/remotes/"), checkedOutPath: checkedOut.get(name) ?? null };
    }).filter((item) => item.name && !item.name.endsWith("/HEAD"));
    return {
      chatId: chat?.id ?? null,
      branch,
      path: cwd,
      mode: cwd === project.path ? "shared" : "worktree",
      dirty: Boolean(await runGit(cwd, ["status", "--porcelain"])),
      canSwitch: !chat || ["stopped", "error"].includes(chat.status),
      branches,
      worktrees,
    };
  }

  // 기존 브랜치 전환 또는 새 브랜치 생성과 공유·전용 작업공간 선택을 원자적으로 적용한다.
  async switchBranch(projectId: number, input: SwitchGitWorkspaceInput): Promise<GitWorkspaceInfo> {
    const branch = assertGitBranch(input.branch);
    const chatId = input.chatId ? Number(input.chatId) : null;
    const mode = input.mode ?? "shared";
    const project = this.project(projectId);
    const chat = chatId ? this.chat(projectId, chatId) : null;
    if (mode === "worktree" && !chat) throw new Error("전용 worktree를 연결할 채팅이 필요합니다.");
    if (chat && !["stopped", "error"].includes(chat.status)) throw new Error("터미널을 종료한 뒤 브랜치를 전환하세요.");

    if (mode === "shared") {
      if (chat?.worktree_path) await this.detachWorktree(chat, project, true);
      await this.assertClean(project.path);
      await this.switchInPath(project.path, branch, Boolean(input.create));
      const current = await this.currentBranch(project.path);
      this.database.prepare("UPDATE chats SET git_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND worktree_path IS NULL")
        .run(current, projectId);
      return this.describe(projectId, chatId);
    }

    let cwd = chat!.worktree_path;
    if (cwd) {
      cwd = fs.realpathSync(cwd);
      await this.assertClean(cwd);
      await this.switchInPath(cwd, branch, Boolean(input.create));
    } else {
      const startPoint = await runGit(project.path, ["rev-parse", "HEAD"]);
      cwd = this.managedPath(projectId, branch);
      // 같은 브랜치의 worktree가 이미 있으면 새로 만들지 않고 그대로 붙여 채팅끼리 공유한다.
      if (fs.existsSync(cwd)) {
        const existing = fs.realpathSync(cwd);
        const current = await this.currentBranch(existing);
        if (current !== branch) throw new Error("같은 이름의 worktree 폴더가 다른 브랜치를 쓰고 있습니다.");
        this.database.prepare("UPDATE chats SET worktree_path = ?, git_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(existing, current, chat!.id);
        return this.describe(projectId, chatId);
      }
      fs.mkdirSync(path.dirname(cwd), { recursive: true, mode: 0o700 });
      const args = ["worktree", "add"];
      if (input.create) args.push("-b", branch, cwd, startPoint);
      else if (await this.isRemoteBranch(project.path, branch)) {
        const localBranch = this.localName(branch);
        if (await this.refExists(project.path, `refs/heads/${localBranch}`)) args.push(cwd, localBranch);
        else args.push("--track", "-b", localBranch, cwd, branch);
      }
      else args.push(cwd, branch);
      await runGit(project.path, args);
      cwd = fs.realpathSync(cwd);
      this.copyLocalInstructions(project.path, cwd);
    }
    const current = await this.currentBranch(cwd);
    this.database.prepare("UPDATE chats SET worktree_path = ?, git_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(cwd, current, chat!.id);
    return this.describe(projectId, chatId);
  }

  // worktree를 지우면 `git-worktrees/<projectId>/` 상위 폴더가 빈 채로 남는다. 쌓이면 지저분해서
  // 앱이 만든 경로 안에서만, 비어 있을 때만 함께 치운다.
  private pruneEmptyParent(worktreePath: string): void {
    const parent = path.dirname(path.resolve(worktreePath));
    if (!isInside(this.root, parent) || path.resolve(parent) === path.resolve(this.root)) return;
    try {
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    } catch {
      // 정리는 부가 작업이라 실패해도 삭제 자체는 성공으로 둔다.
    }
  }

  // 작업이 끝난 worktree를 정리한다. 미커밋 변경이 남아 있으면 기본적으로 거부하고, force일 때만 지운다.
  // detachChats면 그 worktree를 쓰던 채팅들의 연결도 함께 끊는다(채팅 자체는 남는다).
  async removeWorktree(projectId: number, requestedPath: string, options: { force?: boolean; detachChats?: boolean } = {}): Promise<{ removed: boolean; detachedChatIds: number[] }> {
    const project = this.project(projectId);
    const target = await this.resolveWorktreePath(projectId, requestedPath);
    if (target === project.path) throw new Error("프로젝트 기본 checkout은 정리할 수 없습니다.");
    const users = this.database.prepare("SELECT id, status FROM chats WHERE worktree_path = ?")
      .all(target) as Array<{ id: number; status: string }>;
    const running = users.filter((chat) => !["stopped", "error"].includes(chat.status));
    if (running.length) throw new Error(`실행 중인 채팅(${running.map((chat) => `#${chat.id}`).join(", ")})이 있어 정리할 수 없습니다. 먼저 종료해주세요.`);
    if (!options.force) await this.assertClean(target);
    const args = ["worktree", "remove", target];
    if (options.force) args.splice(2, 0, "--force");
    await runGit(project.path, args);
    this.pruneEmptyParent(target);
    const detachedChatIds = options.detachChats === false ? [] : users.map((chat) => chat.id);
    for (const chatId of detachedChatIds) {
      this.database.prepare("UPDATE chats SET worktree_path = NULL, git_branch = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chatId);
    }
    return { removed: true, detachedChatIds };
  }

  // git에 올리지 않는 로컬 지침(CLAUDE.local.md 등)은 worktree에 체크아웃되지 않아 새 작업공간의
  // 에이전트가 다른 지침으로 움직이게 된다. 원본 checkout에만 있는 지침을 그대로 복사해 맞춘다.
  // 이미 있는 파일(= git에서 따라온 버전)은 건드리지 않는다.
  private copyLocalInstructions(sourceRoot: string, worktreePath: string): void {
    for (const name of PROJECT_INSTRUCTION_FILES) {
      const source = path.join(sourceRoot, name);
      const target = path.join(worktreePath, name);
      try {
        if (!fs.existsSync(source) || fs.existsSync(target)) continue;
        if (!fs.statSync(source).isFile()) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      } catch (error) {
        // 지침 복사는 부가 작업이라 실패해도 worktree 생성 자체는 성공으로 둔다.
        console.warn("[web-agent-manager:git]", "instruction-copy-failed", { name, worktreePath, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // 발견된 외부 worktree를 특정 종료 채팅에 연결하고 다른 채팅과의 중복 연결을 막는다.
  async attachWorktree(projectId: number, chatId: number, worktreePath: string): Promise<GitWorkspaceInfo> {
    const project = this.project(projectId);
    const chat = this.chat(projectId, chatId);
    if (!["stopped", "error"].includes(chat.status)) throw new Error("터미널을 종료한 뒤 worktree를 연결하세요.");
    const worktrees = await this.listWorktrees(project);
    const wanted = worktrees.find((item) => item.path === path.resolve(worktreePath));
    if (!wanted) throw new Error("프로젝트에 등록된 worktree가 아닙니다.");
    // 같은 worktree를 여러 채팅이 함께 쓸 수 있으므로 중복 연결을 막지 않는다.
    if (chat.worktree_path && chat.worktree_path !== wanted.path) await this.detachWorktree(chat, project, false);
    const branch = await this.currentBranch(wanted.path);
    this.database.prepare("UPDATE chats SET worktree_path = ?, git_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(wanted.main ? null : wanted.path, branch, chatId);
    return this.describe(projectId, chatId);
  }

  // 채팅 삭제 전에 앱 관리 worktree는 깨끗할 때 제거하고 외부 worktree는 연결만 해제한다.
  async removeChatWorktree(chatId: number): Promise<{ worktreeRemoved: boolean; worktreePath: string | null; branch: string | null }> {
    const row = this.database.prepare(`
      SELECT c.*, p.path AS project_path FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id = ?
    `).get(chatId) as ChatWorkspaceRow | undefined;
    if (!row?.worktree_path) return { worktreeRemoved: false, worktreePath: null, branch: null };
    // 마지막 사용 채팅인지 미리 확인해, 폴더까지 정리됐는지 화면에 알릴 수 있게 한다.
    const others = this.database.prepare("SELECT COUNT(*) AS count FROM chats WHERE worktree_path = ? AND id != ?")
      .get(row.worktree_path, chatId) as { count: number };
    const lastUser = others.count === 0;
    await this.detachWorktree(row, { id: row.project_id, path: fs.realpathSync(row.project_path) }, true);
    return {
      worktreeRemoved: lastUser && !fs.existsSync(row.worktree_path),
      worktreePath: row.worktree_path,
      branch: row.git_branch,
    };
  }

  // 저장소 경로의 현재 로컬 브랜치를 읽고 detached HEAD는 null로 표시한다.
  private async currentBranch(cwd: string): Promise<string | null> {
    const branch = await runGit(cwd, ["branch", "--show-current"]);
    return branch || null;
  }

  // 작업 경로에 변경사항이 있으면 브랜치 전환이나 제거를 차단한다.
  private async assertClean(cwd: string): Promise<void> {
    if (await runGit(cwd, ["status", "--porcelain"])) throw new Error("미커밋 변경사항을 정리한 뒤 작업공간을 전환하세요.");
  }

  // 현재 작업 경로에서 로컬·원격 브랜치 전환 또는 새 브랜치 생성을 수행한다.
  private async switchInPath(cwd: string, branch: string, create: boolean): Promise<void> {
    if (create) {
      await runGit(cwd, ["switch", "-c", branch]);
      return;
    }
    if (await this.isRemoteBranch(cwd, branch)) {
      const localBranch = this.localName(branch);
      if (await this.refExists(cwd, `refs/heads/${localBranch}`)) await runGit(cwd, ["switch", localBranch]);
      else await runGit(cwd, ["switch", "--track", "-c", localBranch, branch]);
      return;
    }
    await runGit(cwd, ["switch", branch]);
  }

  // 프로젝트의 모든 worktree를 앱 관리 여부와 채팅 연결 상태까지 합쳐 반환한다.
  private async listWorktrees(project: ProjectRow): Promise<GitWorktreeInfo[]> {
    const parsed = parseGitWorktrees(await runGit(project.path, ["worktree", "list", "--porcelain"]));
    const assignments = this.database.prepare("SELECT id, worktree_path FROM chats WHERE project_id = ? AND worktree_path IS NOT NULL")
      .all(project.id) as Array<{ id: number; worktree_path: string }>;
    const byPath = new Map(assignments.map((item) => [path.resolve(item.worktree_path), item.id]));
    return parsed.map((item) => {
      const resolved = path.resolve(item.path);
      return {
        ...item,
        path: resolved,
        main: resolved === project.path,
        appManaged: isInside(this.root, resolved),
        assignedChatId: byPath.get(resolved) ?? null,
      };
    });
  }

  // tmux pane의 실제 현재 경로가 외부 worktree 안이면 미연결 채팅에 자동 연결한다.
  private async syncTmuxAssignments(projectId: number): Promise<void> {
    const project = this.project(projectId);
    const worktrees = await this.listWorktrees(project);
    const assigned = new Set(worktrees.filter((item) => item.assignedChatId).map((item) => item.path));
    const chats = this.database.prepare("SELECT id, tmux_name FROM chats WHERE project_id = ? AND worktree_path IS NULL")
      .all(projectId) as Array<{ id: number; tmux_name: string }>;
    for (const chat of chats) {
      try {
        const tmux = await runFile("tmux", ["display-message", "-p", "-t", chat.tmux_name, "#{pane_current_path}"], { timeout: 2_000 });
        const currentPath = path.resolve(tmux.stdout.trim() || project.path);
        const match = worktrees.filter((item) => !item.main && !assigned.has(item.path) && isInside(item.path, currentPath))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (!match) continue;
        this.database.prepare("UPDATE chats SET worktree_path = ?, git_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(match.path, match.branch, chat.id);
        assigned.add(match.path);
      } catch {
        // tmux 세션이 없거나 현재 경로를 확인할 수 없으면 미연결 상태를 유지한다.
      }
    }
  }

  // 앱 관리 worktree는 필요할 때 Git에서 제거하고 외부 worktree는 DB 연결만 해제한다.
  private async detachWorktree(chat: ChatWorkspaceRow, project: ProjectRow, removeManaged: boolean): Promise<void> {
    const worktreePath = chat.worktree_path ? path.resolve(chat.worktree_path) : null;
    if (!worktreePath) return;
    // 같은 worktree를 다른 채팅도 쓰고 있으면 연결만 끊고 폴더는 남긴다.
    const others = this.database.prepare("SELECT COUNT(*) AS count FROM chats WHERE worktree_path = ? AND id != ?")
      .get(chat.worktree_path, chat.id) as { count: number };
    const lastUser = others.count === 0;
    if (lastUser && fs.existsSync(worktreePath)) await this.assertClean(worktreePath);
    if (lastUser && removeManaged && isInside(this.root, worktreePath) && fs.existsSync(worktreePath)) {
      await runGit(project.path, ["worktree", "remove", worktreePath]);
      this.pruneEmptyParent(worktreePath);
    }
    this.database.prepare("UPDATE chats SET worktree_path = NULL, git_branch = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chat.id);
  }

  // 프로젝트 ID를 실제 활성 프로젝트 Git 루트로 해석한다.
  private project(projectId: number): ProjectRow {
    const row = this.database.prepare("SELECT id, path FROM projects WHERE id = ? AND active = 1").get(projectId) as ProjectRow | undefined;
    if (!row) throw new Error("프로젝트를 찾을 수 없습니다.");
    return { ...row, path: fs.realpathSync(row.path) };
  }

  // 채팅이 요청 프로젝트에 속하는지 확인하고 작업공간 필드를 함께 반환한다.
  private chat(projectId: number, chatId: number): ChatWorkspaceRow {
    const row = this.database.prepare(`
      SELECT c.*, p.path AS project_path FROM chats c JOIN projects p ON p.id = c.project_id
      WHERE c.id = ? AND c.project_id = ?
    `).get(chatId, projectId) as ChatWorkspaceRow | undefined;
    if (!row) throw new Error("채팅을 찾을 수 없습니다.");
    return row;
  }

  // 채팅별 앱 관리 worktree의 예측 가능한 내부 경로를 만든다.
  // worktree 폴더를 브랜치 기준으로 잡아 같은 브랜치를 쓰는 채팅들이 한 폴더를 공유하게 한다.
  // (예전에는 채팅 ID로 잡아 채팅마다 폴더가 갈렸고, 같은 작업에 Claude와 Codex를 함께 둘 수 없었다.)
  private managedPath(projectId: number, branch: string): string {
    const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "work";
    return path.join(this.root, String(projectId), slug);
  }

  // refs/remotes에 실제로 존재하는 이름인지 확인해 슬래시가 있는 로컬 브랜치와 구분한다.
  private async isRemoteBranch(cwd: string, branch: string): Promise<boolean> {
    return this.refExists(cwd, `refs/remotes/${branch}`);
  }

  // 지정한 완전한 Git ref가 저장소에 존재하는지 확인한다.
  private async refExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  // 원격 브랜치의 첫 원격 이름을 제거해 로컬 추적 브랜치 이름을 만든다.
  private localName(branch: string): string {
    return branch.split("/").slice(1).join("/");
  }
}
