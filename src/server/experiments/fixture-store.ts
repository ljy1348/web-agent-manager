import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../core/config";
import type { ExperimentFixtureRecord } from "../services/experiment-repository";

const execFileAsync = promisify(execFile);
const CLONE_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 5 * 60_000;

export interface FixtureWorkspace {
  root: string;
  workingDirectory: string;
  baselineCommit: string;
  source: "fixture" | "empty";
}

// 후보 경로가 기준 디렉터리 자신 또는 실제 하위 경로인지 확인한다.
function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// git을 shell 없이 실행하고 상세 오류는 서버 로그에만 남긴다.
async function runGit(args: string[], cwd: string | undefined, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    console.error("[web-agent-manager:experiment]", "fixture-git-failed", {
      operation: args.slice(0, 2).join(" "),
      error: detail.stderr?.trim() || detail.message || String(error),
    });
    throw new Error("실험 fixture Git 명령이 실패했습니다.", { cause: error });
  }
}

// 외부 공개 저장소 fixture의 bare mirror를 캐시하고, run마다 고정 commit의 격리 worktree를 만든다.
// 원본 저장소는 한 번만 받아 두므로 반복 실행이 네트워크 상태에 좌우되지 않는다.
export class ExperimentFixtureStore {
  private readonly mirrorRoot: string;
  private readonly workspaceRoot: string;

  constructor(config: Pick<AppConfig, "dataDir">) {
    this.mirrorRoot = path.resolve(config.dataDir, "experiment-fixtures");
    this.workspaceRoot = path.resolve(config.dataDir, "experiment-worktrees");
  }

  // fixture의 bare mirror를 준비하고 기준 commit이 실제로 존재하는지 확인한 뒤 mirror 경로를 반환한다.
  async ensureMirror(fixture: ExperimentFixtureRecord): Promise<string> {
    fs.mkdirSync(this.mirrorRoot, { recursive: true, mode: 0o700 });
    const mirror = path.join(this.mirrorRoot, `${fixture.id}.git`);
    if (!fs.existsSync(mirror)) {
      await runGit(["clone", "--mirror", "--quiet", fixture.url, mirror], this.mirrorRoot, CLONE_TIMEOUT_MS);
    }
    if (!await this.hasCommit(mirror, fixture.pinnedCommit)) {
      // 등록 당시보다 mirror가 오래됐을 수 있으므로 한 번만 갱신하고 다시 확인한다.
      await runGit(["--git-dir", mirror, "fetch", "--prune", "--quiet", "origin"], undefined, CLONE_TIMEOUT_MS);
      if (!await this.hasCommit(mirror, fixture.pinnedCommit)) {
        throw new Error(`fixture 기준 commit이 저장소에 없습니다: ${fixture.pinnedCommit.slice(0, 12)}`);
      }
    }
    return mirror;
  }

  // 고정 commit의 detached worktree를 앱 관리 경로에 만든다. 원본 mirror는 읽기 전용으로만 쓴다.
  async createWorktree(fixture: ExperimentFixtureRecord, workspaceKey: string): Promise<FixtureWorkspace> {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceKey)) throw new Error("실험 작업공간 키가 올바르지 않습니다.");
    const mirror = await this.ensureMirror(fixture);
    fs.mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const target = path.join(this.workspaceRoot, workspaceKey);
    if (fs.existsSync(target)) throw new Error("같은 실험 작업공간이 이미 있습니다.");
    await runGit(["--git-dir", mirror, "worktree", "add", "--detach", target, fixture.pinnedCommit], undefined);
    const root = fs.realpathSync(target);
    return { root, workingDirectory: root, baselineCommit: fixture.pinnedCommit, source: "fixture" };
  }

  // greenfield 과제용 빈 Git 작업공간을 만든다. 기준 commit이 없으므로 빈 문자열로 남긴다.
  async createEmptyWorkspace(workspaceKey: string): Promise<FixtureWorkspace> {
    if (!/^[0-9a-f-]{36}$/i.test(workspaceKey)) throw new Error("실험 작업공간 키가 올바르지 않습니다.");
    fs.mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const target = path.join(this.workspaceRoot, workspaceKey);
    if (fs.existsSync(target)) throw new Error("같은 실험 작업공간이 이미 있습니다.");
    fs.mkdirSync(target, { mode: 0o700 });
    await runGit(["init", "--quiet"], target);
    const root = fs.realpathSync(target);
    return { root, workingDirectory: root, baselineCommit: "", source: "empty" };
  }

  // 앱 관리 루트 바로 아래의 작업공간만 제거한다. fixture worktree는 mirror의 Git 메타데이터까지 정리한다.
  async remove(workspaceRoot: string, mirrorPath: string | null): Promise<boolean> {
    const resolved = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolved)) return false;
    const managedRoot = fs.realpathSync(this.workspaceRoot);
    const actual = fs.realpathSync(resolved);
    if (!isInside(actual, managedRoot) || actual === managedRoot) {
      throw new Error("앱 관리 경로 밖의 실험 작업공간은 제거할 수 없습니다.");
    }
    if (mirrorPath && fs.existsSync(mirrorPath)) {
      await runGit(["--git-dir", mirrorPath, "worktree", "remove", "--force", actual], undefined);
      return true;
    }
    fs.rmSync(actual, { recursive: true, force: true });
    return true;
  }

  // 기준 commit이 mirror 안에 실제로 존재하는지 확인한다.
  private async hasCommit(mirror: string, commit: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["--git-dir", mirror, "cat-file", "-e", `${commit}^{commit}`], { timeout: GIT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
}
