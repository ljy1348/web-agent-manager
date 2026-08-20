import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";

const execFileAsync = promisify(execFile);

export interface ExperimentWorkspace {
  root: string;
  workingDirectory: string;
  baselineCommit: string;
  repositoryRoot: string;
}

// git 명령을 shell 없이 실행하고 상세 오류는 서버 로그에만 남긴다.
async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    console.error("[web-agent-manager:experiment]", "worktree-git-failed", {
      operation: args.slice(0, 2).join(" "), cwd,
      error: detail.stderr?.trim() || detail.message || String(error),
    });
    throw new Error("실험 worktree Git 명령이 실패했습니다.", { cause: error });
  }
}

// 후보 경로가 기준 디렉터리 자신 또는 실제 하위 경로인지 확인한다.
function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// 실험 run별 detached Git worktree를 앱 관리 data 경로에 생성한다.
export class ExperimentWorkspaceService {
  private readonly root: string;

  constructor(private readonly database: AppDatabase, config: Pick<AppConfig, "dataDir">) {
    this.root = path.resolve(config.dataDir, "experiment-worktrees");
  }

  // 프로젝트의 현재 HEAD를 기준으로 새 격리 worktree와 프로젝트 상대 작업 경로를 만든다.
  async create(projectId: number, workspaceKey: string, pinnedCommit?: string | null): Promise<ExperimentWorkspace> {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceKey)) throw new Error("실험 작업공간 키가 올바르지 않습니다.");
    const project = this.database.prepare("SELECT path FROM projects WHERE id = ? AND active = 1").get(projectId) as { path: string } | undefined;
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    const projectPath = fs.realpathSync(project.path);
    const repoRoot = fs.realpathSync(await runGit(projectPath, ["rev-parse", "--show-toplevel"]));
    const relativeProject = path.relative(repoRoot, projectPath);
    if (relativeProject.startsWith("..") || path.isAbsolute(relativeProject)) throw new Error("프로젝트가 Git 저장소 밖에 있습니다.");
    // 계획이 기준 commit을 고정했으면 그 값을 쓴다. 실행 도중 브랜치에 커밋이 쌓여도 같은 비교
    // 조건을 유지하기 위해서다. 고정값이 없을 때만 현재 HEAD를 기준으로 삼는다.
    const baselineCommit = pinnedCommit ?? await runGit(repoRoot, ["rev-parse", "HEAD"]);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = path.join(this.root, workspaceKey);
    if (fs.existsSync(target)) throw new Error("같은 실험 작업공간이 이미 있습니다.");
    try {
      await runGit(repoRoot, ["worktree", "add", "--detach", target, baselineCommit]);
    } catch (error) {
      if (path.dirname(path.resolve(target)) === this.root) fs.rmSync(target, { recursive: true, force: true });
      throw error;
    }
    try {
      const workspaceRoot = fs.realpathSync(target);
      const workingDirectory = fs.realpathSync(path.join(workspaceRoot, relativeProject));
      if (!isInside(workingDirectory, workspaceRoot) || !fs.statSync(workingDirectory).isDirectory()) {
        throw new Error("실험 프로젝트 작업 경로가 worktree 밖을 가리킵니다.");
      }
      return { root: workspaceRoot, workingDirectory, baselineCommit, repositoryRoot: repoRoot };
    } catch (error) {
      try {
        await this.remove(projectId, target);
      } catch (cleanupError) {
        console.error("[web-agent-manager:experiment]", "invalid-worktree-cleanup-failed", {
          workspace: target, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }
  }

  // 앱 관리 루트 안의 run worktree만 원본 저장소를 재확인한 뒤 Git 메타데이터와 함께 제거한다.
  async remove(projectId: number, workspaceRoot: string): Promise<boolean> {
    const resolvedWorkspace = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolvedWorkspace)) return false;
    const managedRoot = fs.realpathSync(this.root);
    const actualWorkspace = fs.realpathSync(resolvedWorkspace);
    if (!isInside(actualWorkspace, managedRoot) || actualWorkspace === managedRoot) {
      throw new Error("앱 관리 경로 밖의 실험 worktree는 제거할 수 없습니다.");
    }
    const project = this.database.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
    if (!project || !fs.existsSync(project.path)) throw new Error("실험 worktree의 원본 프로젝트를 찾을 수 없습니다.");
    const projectPath = fs.realpathSync(project.path);
    const repoRoot = fs.realpathSync(await runGit(projectPath, ["rev-parse", "--show-toplevel"]));
    await runGit(repoRoot, ["worktree", "remove", "--force", actualWorkspace]);
    return true;
  }
}
