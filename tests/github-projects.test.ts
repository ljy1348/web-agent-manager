import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { GithubProjectService, githubRepositoryName, type ProjectCommandRuntime } from "../src/server/services/github-projects";

interface Fixture {
  root: string;
  projectsDir: string;
  database: AppDatabase;
  config: AppConfig;
  calls: Array<{ command: string; args: string[]; cwd: string }>;
  remotes: Map<string, string>;
  service: GithubProjectService;
}

const fixtures: Fixture[] = [];

// GitHub 프로젝트 테스트용 실제 경로·SQLite와 가짜 명령 실행기를 만든다.
function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-github-projects-"));
  const dataDir = path.join(root, "data");
  const projectsDir = path.join(root, "projects");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  const config: AppConfig = {
    rootDir: root,
    homeDir: root,
    dataDir,
    projectsDir,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    allowedRoots: [root],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  const calls: Fixture["calls"] = [];
  const remotes = new Map<string, string>();
  const runtime: ProjectCommandRuntime = {
    run: async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (command === "git" && args.join(" ") === "remote get-url origin") {
        const remote = remotes.get(cwd);
        if (!remote) throw new Error("origin 없음");
        return remote;
      }
      if (command === "gh" && args.join(" ") === "api user --jq .login") return "owner";
      if (command === "gh" && args.join(" ") === "api user/orgs --paginate --jq .[].login") return "example-org";
      if (command === "gh" && args[0] === "repo" && args[1] === "list") {
        if (args[2] === "example-org") return JSON.stringify([{ id: "R_org", name: "org-app", nameWithOwner: "example-org/org-app", url: "https://github.com/example-org/org-app", description: "조직 앱", isPrivate: true, updatedAt: "2026-07-30T00:00:00Z" }]);
        return JSON.stringify([{ id: "R_owner", name: "wam", nameWithOwner: "owner/wam", url: "https://github.com/owner/wam", description: "관리 도구", isPrivate: true, updatedAt: "2026-07-31T00:00:00Z" }]);
      }
      if (command === "gh" && args[0] === "repo" && args[1] === "clone") {
        fs.mkdirSync(args[3], { recursive: true });
        remotes.set(args[3], `https://github.com/${args[2]}.git`);
        return "";
      }
      if (command === "git" && args[0] === "rev-parse") throw new Error("Git 저장소 아님");
      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return JSON.stringify({ name: "local", nameWithOwner: "owner/local", url: "https://github.com/owner/local", description: "로컬 프로젝트", isPrivate: true, updatedAt: "2026-07-31T00:00:00Z" });
      }
      return "";
    },
  };
  const fixture = { root, projectsDir, database, config, calls, remotes, service: new GithubProjectService(database, config, runtime) };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("GitHub 프로젝트 서비스", () => {
  it("HTTPS와 SSH origin을 같은 owner/name으로 정규화한다", () => {
    expect(githubRepositoryName("https://github.com/Owner/WAM.git")).toBe("owner/wam");
    expect(githubRepositoryName("git@github.com:Owner/WAM.git")).toBe("owner/wam");
    expect(githubRepositoryName("https://example.com/owner/wam.git")).toBeNull();
  });

  it("저장소 목록에 이미 연결된 프로젝트와 로컬 경로를 표시한다", async () => {
    const fixture = createFixture();
    const projectPath = path.join(fixture.projectsDir, "wam");
    fs.mkdirSync(projectPath);
    fixture.database.prepare("INSERT INTO projects(name, path) VALUES ('WAM', ?)").run(projectPath);
    fixture.remotes.set(projectPath, "git@github.com:owner/wam.git");

    const result = await fixture.service.listRepositories();

    expect(result.defaultCloneRoot).toBe(fixture.projectsDir);
    expect(result.owners).toEqual([{ login: "owner", type: "user" }, { login: "example-org", type: "organization" }]);
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories.find((repository) => repository.nameWithOwner === "owner/wam")).toMatchObject({ projectId: 1, projectActive: true, localPath: projectPath });
    expect(result.repositories.find((repository) => repository.nameWithOwner === "example-org/org-app")).toMatchObject({ projectId: null, localPath: path.join(fixture.projectsDir, "example-org", "org-app") });
  });

  it("연결된 비활성 프로젝트는 clone하지 않고 재활성화한다", async () => {
    const fixture = createFixture();
    const projectPath = path.join(fixture.projectsDir, "wam");
    fs.mkdirSync(projectPath);
    fixture.database.prepare("INSERT INTO projects(name, path, active) VALUES ('WAM', ?, 0)").run(projectPath);
    fixture.remotes.set(projectPath, "https://github.com/owner/wam.git");

    const result = await fixture.service.cloneProject("owner/wam");

    expect(result.reused).toBe(true);
    expect(result.project.active).toBe(1);
    expect(fixture.calls.some((call) => call.command === "gh" && call.args[1] === "clone")).toBe(false);
  });

  it("새 저장소는 기본 프로젝트 경로에 clone하고 프로젝트로 등록한다", async () => {
    const fixture = createFixture();

    const result = await fixture.service.cloneProject("owner/wam");

    expect(result.reused).toBe(false);
    expect(result.project.path).toBe(path.join(fixture.projectsDir, "owner", "wam"));
    expect(fixture.calls).toContainEqual({ command: "gh", args: ["repo", "clone", "owner/wam", path.join(fixture.projectsDir, "owner", "wam")], cwd: fixture.root });
  });

  it("허용 루트 안의 symlink가 바깥 clone 경로를 가리키면 거부한다", async () => {
    const fixture = createFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-github-outside-"));
    const linkedDestination = path.join(fixture.projectsDir, "outside-link");
    fs.symlinkSync(outside, linkedDestination);

    await expect(fixture.service.cloneProject("owner/wam", linkedDestination)).rejects.toThrow("허용된 프로젝트 경로를 벗어났습니다.");
    expect(fixture.calls.some((call) => call.command === "gh" && call.args[1] === "clone")).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("로컬 프로젝트에서 비공개 GitHub 저장소와 origin을 만든다", async () => {
    const fixture = createFixture();
    const projectPath = path.join(fixture.root, "local");
    fs.mkdirSync(projectPath);

    const result = await fixture.service.registerLocal({ projectPath, createGithub: true, repository: "owner/local", visibility: "private", description: "로컬 프로젝트" });

    expect(result.repository?.nameWithOwner).toBe("owner/local");
    expect(fixture.calls).toContainEqual({ command: "git", args: ["init", "-b", "main"], cwd: projectPath });
    expect(fixture.calls).toContainEqual({ command: "gh", args: ["repo", "create", "owner/local", "--source", projectPath, "--remote", "origin", "--private", "--description", "로컬 프로젝트"], cwd: projectPath });
  });
});
