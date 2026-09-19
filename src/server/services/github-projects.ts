import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { assertAllowedPath, safeBasename } from "../core/security";

export interface GithubRepository {
  id?: string;
  name: string;
  nameWithOwner: string;
  url: string;
  description: string | null;
  isPrivate: boolean;
  updatedAt: string;
  defaultBranchRef?: { name?: string } | null;
}

export interface GithubOwner {
  login: string;
  type: "user" | "organization";
}

export interface GithubRepositoryItem extends GithubRepository {
  projectId: number | null;
  projectActive: boolean;
  localPath: string;
}

export interface ProjectCommandRuntime {
  run(command: string, args: string[], cwd: string): Promise<string>;
}

interface ProjectRecord {
  id: number;
  name: string;
  path: string;
  active: number;
}

// 프로젝트·GitHub 명령을 셸 없이 제한 시간 안에서 실행한다.
function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

const DEFAULT_RUNTIME: ProjectCommandRuntime = { run: runCommand };

// 중첩 clone 경로의 가장 가까운 실제 조상을 검증한 뒤 부모 디렉터리를 준비한다.
function prepareCloneDestination(target: string, allowedRoots: string[]): string {
  const requested = path.resolve(target);
  if (fs.existsSync(requested)) return assertAllowedPath(requested, allowedRoots);
  let ancestor = path.dirname(requested);
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  assertAllowedPath(ancestor, allowedRoots);
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  return assertAllowedPath(requested, allowedRoots, false);
}

// owner/name 형식의 GitHub 저장소 식별자를 검증한다.
function assertRepositoryName(value: string): string {
  const repository = value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes("..")) {
    throw new Error("유효한 GitHub 저장소 이름(owner/name)이 필요합니다.");
  }
  return repository;
}

// HTTPS·SSH GitHub 원격 주소를 비교 가능한 owner/name으로 변환한다.
export function githubRepositoryName(remote: string): string | null {
  const normalized = remote.trim().replace(/\.git$/i, "");
  const match = normalized.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i);
  return match ? match[1].toLowerCase() : null;
}

// 로컬 프로젝트 등록과 GitHub clone·저장소 생성을 한 경계에서 관리한다.
export class GithubProjectService {
  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly runtime: ProjectCommandRuntime = DEFAULT_RUNTIME,
  ) {}

  // 현재 gh 계정과 소속 조직의 저장소를 프로젝트 연결 상태와 함께 반환한다.
  async listRepositories(): Promise<{ repositories: GithubRepositoryItem[]; owners: GithubOwner[]; defaultCloneRoot: string }> {
    const [viewer, organizationOutput] = await Promise.all([
      this.runtime.run("gh", ["api", "user", "--jq", ".login"], this.config.homeDir),
      this.runtime.run("gh", ["api", "user/orgs", "--paginate", "--jq", ".[].login"], this.config.homeDir),
    ]);
    const owners: GithubOwner[] = [
      { login: viewer.trim(), type: "user" as const },
      ...organizationOutput.split("\n").map((login) => login.trim()).filter(Boolean).map((login) => ({ login, type: "organization" as const })),
    ].filter((owner, index, all) => owner.login && all.findIndex((candidate) => candidate.login.toLowerCase() === owner.login.toLowerCase()) === index);
    const outputs = await Promise.all(owners.map((owner) => this.runtime.run("gh", ["repo", "list", owner.login, "--limit", "200", "--json", "id,name,nameWithOwner,url,description,isPrivate,updatedAt,defaultBranchRef"], this.config.homeDir)));
    const repositoryMap = new Map<string, GithubRepository>();
    for (const output of outputs) {
      for (const repository of JSON.parse(output || "[]") as GithubRepository[]) {
        repositoryMap.set(repository.id || repository.nameWithOwner.toLowerCase(), repository);
      }
    }
    const repositories = [...repositoryMap.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const projects = this.database.prepare("SELECT id, name, path, active FROM projects").all() as ProjectRecord[];
    const linked = new Map<string, ProjectRecord>();
    for (const project of projects) {
      const remote = await this.gitRemote(project.path);
      const name = remote ? githubRepositoryName(remote) : null;
      if (name) linked.set(name, project);
    }
    const cloneRoot = this.config.projectsDir ?? path.join(this.config.homeDir, "Projects");
    return {
      defaultCloneRoot: cloneRoot,
      owners,
      repositories: repositories.map((repository) => {
        const project = linked.get(repository.nameWithOwner.toLowerCase());
        const [owner, name] = repository.nameWithOwner.split("/", 2);
        return {
          ...repository,
          projectId: project?.id ?? null,
          projectActive: project?.active === 1,
          localPath: project?.path ?? path.join(cloneRoot, owner, name),
        };
      }),
    };
  }

  // 선택한 워크스페이스 바로 아래에 새 폴더와 main Git 저장소를 만들고 프로젝트로 등록한다.
  async createLocal(input: {
    workspacePath: string;
    directoryName: string;
    name?: string;
    createGithub?: boolean;
    repository?: string;
    visibility?: string;
    description?: string;
  }): Promise<{ project: ProjectRecord; repository: GithubRepository | null }> {
    const workspacePath = assertAllowedPath(input.workspacePath, this.config.allowedRoots);
    if (!fs.statSync(workspacePath).isDirectory()) throw new Error("워크스페이스 경로가 디렉터리가 아닙니다.");
    const directoryName = safeBasename(input.directoryName);
    const projectPath = assertAllowedPath(path.join(workspacePath, directoryName), this.config.allowedRoots, false);
    if (path.dirname(projectPath) !== workspacePath) throw new Error("프로젝트는 선택한 워크스페이스 바로 아래에 생성해야 합니다.");
    if (fs.existsSync(projectPath)) throw new Error("같은 이름의 파일 또는 폴더가 이미 존재합니다.");

    fs.mkdirSync(projectPath);
    try {
      await this.runtime.run("git", ["init", "-b", "main"], projectPath);
    } catch (error) {
      // git이 아무 것도 쓰지 못한 경우에만 방금 만든 빈 폴더를 되돌린다. 부분 저장소는 진단을 위해 보존한다.
      try { fs.rmdirSync(projectPath); } catch { /* 부분 생성된 Git 자료는 보존한다. */ }
      throw error;
    }

    const repository = input.createGithub
      ? await this.createGithubRepository(projectPath, input.repository || directoryName, input.visibility, input.description)
      : null;
    return { project: this.saveProject(projectPath, input.name?.trim() || directoryName), repository };
  }

  // GitHub 저장소를 안전한 로컬 경로에 clone하거나 이미 연결된 프로젝트를 재활성화한다.
  async cloneProject(repositoryInput: string, destinationInput?: string): Promise<{ project: ProjectRecord; reused: boolean }> {
    const repository = assertRepositoryName(repositoryInput);
    const existing = await this.findByRepository(repository);
    if (existing) {
      this.database.prepare("UPDATE projects SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existing.id);
      return { project: { ...existing, active: 1 }, reused: true };
    }
    const cloneRoot = this.config.projectsDir ?? path.join(this.config.homeDir, "Projects");
    const requestedDestination = path.resolve(destinationInput?.trim() || path.join(cloneRoot, ...repository.split("/")));
    const destination = prepareCloneDestination(requestedDestination, this.config.allowedRoots);
    const pathProject = this.database.prepare("SELECT id, name, path, active FROM projects WHERE path = ?").get(destination) as ProjectRecord | undefined;
    if (pathProject) {
      this.database.prepare("UPDATE projects SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pathProject.id);
      return { project: { ...pathProject, active: 1 }, reused: true };
    }
    if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) throw new Error("clone 대상 경로가 비어 있지 않습니다.");
    await this.runtime.run("gh", ["repo", "clone", repository, destination], this.config.homeDir);
    return { project: this.saveProject(destination, repository.split("/")[1]), reused: false };
  }

  // 로컬 경로를 프로젝트로 등록하고 선택한 경우 새 GitHub 저장소와 origin을 만든다.
  async registerLocal(input: {
    projectPath: string;
    name?: string;
    createGithub?: boolean;
    repository?: string;
    visibility?: string;
    description?: string;
  }): Promise<{ project: ProjectRecord; repository: GithubRepository | null }> {
    const actualPath = assertAllowedPath(input.projectPath, this.config.allowedRoots);
    if (!fs.statSync(actualPath).isDirectory()) throw new Error("프로젝트 경로가 디렉터리가 아닙니다.");
    let repository: GithubRepository | null = null;
    if (input.createGithub) {
      const existingRemote = await this.gitRemote(actualPath);
      if (existingRemote) throw new Error("이미 origin 원격 저장소가 연결되어 있습니다.");
      try {
        await this.runtime.run("git", ["rev-parse", "--is-inside-work-tree"], actualPath);
      } catch {
        await this.runtime.run("git", ["init", "-b", "main"], actualPath);
      }
      repository = await this.createGithubRepository(actualPath, input.repository || path.basename(actualPath), input.visibility, input.description);
    }
    const name = input.name?.trim() || path.basename(actualPath);
    return { project: this.saveProject(actualPath, name), repository };
  }

  // 검증된 로컬 Git 저장소에서 gh CLI로 원격 저장소를 만들고 origin을 연결한다.
  private async createGithubRepository(projectPath: string, repositoryInput: string, visibilityInput?: string, description?: string): Promise<GithubRepository> {
    const visibility = ["private", "public", "internal"].includes(visibilityInput ?? "") ? visibilityInput! : "private";
    const repositoryName = repositoryInput.trim();
    if (!/^(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(repositoryName) || repositoryName.includes("..")) {
      throw new Error("유효한 GitHub 저장소 이름이 필요합니다.");
    }
    const args = ["repo", "create", repositoryName, "--source", projectPath, "--remote", "origin", `--${visibility}`];
    if (description?.trim()) args.push("--description", description.trim().slice(0, 350));
    await this.runtime.run("gh", args, projectPath);
    const output = await this.runtime.run("gh", ["repo", "view", "--json", "name,nameWithOwner,url,description,isPrivate,updatedAt,defaultBranchRef"], projectPath);
    return JSON.parse(output) as GithubRepository;
  }

  // 저장소 원격이 같은 기존 프로젝트를 active 여부와 무관하게 찾는다.
  private async findByRepository(repository: string): Promise<ProjectRecord | null> {
    const projects = this.database.prepare("SELECT id, name, path, active FROM projects").all() as ProjectRecord[];
    for (const project of projects) {
      const remote = await this.gitRemote(project.path);
      if (remote && githubRepositoryName(remote) === repository.toLowerCase()) return project;
    }
    return null;
  }

  // 존재하는 프로젝트의 origin URL을 읽되 Git 저장소가 아니면 null을 반환한다.
  private async gitRemote(projectPath: string): Promise<string | null> {
    if (!fs.existsSync(projectPath)) return null;
    try {
      return await this.runtime.run("git", ["remote", "get-url", "origin"], projectPath);
    } catch {
      return null;
    }
  }

  // 프로젝트 행을 생성하거나 같은 경로의 소프트 삭제 행을 재활성화한다.
  private saveProject(projectPath: string, name: string): ProjectRecord {
    const actualPath = assertAllowedPath(projectPath, this.config.allowedRoots);
    this.database.prepare(`
      INSERT INTO projects(name, path, source) VALUES (?, ?, 'manual')
      ON CONFLICT(path) DO UPDATE SET name = excluded.name, active = 1, updated_at = CURRENT_TIMESTAMP
    `).run(name, actualPath);
    return this.database.prepare("SELECT id, name, path, active FROM projects WHERE path = ?").get(actualPath) as ProjectRecord;
  }
}
