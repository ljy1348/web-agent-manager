import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { createGitRouter } from "../src/server/routes/git-routes";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// gh를 대신할 가짜 실행 파일을 만들어 PATH 앞에 둔다. 호출될 때마다 인자를 파일에 적어 횟수를 센다.
function createHarness(): { database: AppDatabase; repoPath: string; baseUrl: string; ghCalls: () => string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-gh-cache-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: repoPath }); };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repoPath, "a.txt"), "a\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "init"]);

  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(root, "gh-calls.log");
  // 하위 명령에 따라 알맞은 JSON을 돌려주는 최소 스텁이다.
  fs.writeFileSync(path.join(binDir, "gh"), `#!/bin/sh
echo "$@" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "issue view") echo '{"number":7,"title":"이슈","state":"OPEN","comments":[]}' ;;
  "pr view") echo '{"number":9,"title":"PR","state":"OPEN","comments":[],"reviews":[]}' ;;
  "repo view") echo '{"nameWithOwner":"tester/repo","url":"https://example.com"}' ;;
  "run list") echo '[{"databaseId":1,"name":"CI","status":"completed"}]' ;;
  *) echo '[]' ;;
esac
`, { mode: 0o755 });

  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    rootDir: root,
    homeDir: root,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:0",
    allowedRoots: [root],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('repo', ?, 'manual')").run(repoPath);

  const app = express();
  app.use("/api", createGitRouter(database));
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;

  cleanup.push(() => {
    process.env.PATH = originalPath;
    server.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    database,
    repoPath,
    baseUrl: `http://127.0.0.1:${port}`,
    ghCalls: () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean) : []),
  };
}

describe("GitHub 조회 비용 줄이기", () => {
  it("같은 이슈를 두 번 열어도 gh는 한 번만 실행된다", async () => {
    const { database, repoPath, baseUrl, ghCalls } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };

    const first = await (await fetch(`${baseUrl}/api/projects/${project.id}/github/issue/7`)).json();
    const second = await (await fetch(`${baseUrl}/api/projects/${project.id}/github/issue/7`)).json();

    expect(first.issue.number).toBe(7);
    expect(second.issue).toEqual(first.issue);
    expect(ghCalls().filter((line) => line.startsWith("issue view"))).toHaveLength(1);
  });

  it("같은 PR을 두 번 열어도 gh는 한 번만 실행된다", async () => {
    const { database, repoPath, baseUrl, ghCalls } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };

    await fetch(`${baseUrl}/api/projects/${project.id}/github/pr/9`);
    const second = await (await fetch(`${baseUrl}/api/projects/${project.id}/github/pr/9`)).json();

    expect(second.pullRequest.number).toBe(9);
    expect(ghCalls().filter((line) => line.startsWith("pr view"))).toHaveLength(1);
  });

  it("다른 번호는 각각 따로 조회한다", async () => {
    const { database, repoPath, baseUrl, ghCalls } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };

    await fetch(`${baseUrl}/api/projects/${project.id}/github/issue/7`);
    await fetch(`${baseUrl}/api/projects/${project.id}/github/issue/8`);

    expect(ghCalls().filter((line) => line.startsWith("issue view"))).toHaveLength(2);
  });

  it("목록 조회는 워크플로를 부르지 않는다", async () => {
    const { database, repoPath, baseUrl, ghCalls } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };

    const data = await (await fetch(`${baseUrl}/api/projects/${project.id}/github`)).json();

    // `gh run list`가 셋 중 가장 느려서, Actions 탭을 열기 전에는 부르지 않는다.
    expect(ghCalls().some((line) => line.startsWith("run list"))).toBe(false);
    expect(ghCalls().some((line) => line.startsWith("issue list"))).toBe(true);
    expect(ghCalls().some((line) => line.startsWith("pr list"))).toBe(true);
    expect(data.runs).toBeUndefined();
  });

  it("Actions 조회는 별도 엔드포인트에서 워크플로만 읽는다", async () => {
    const { database, repoPath, baseUrl, ghCalls } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };

    const data = await (await fetch(`${baseUrl}/api/projects/${project.id}/github/runs`)).json();

    expect(data.runs).toHaveLength(1);
    expect(data.hasMore).toBe(false);
    expect(ghCalls().filter((line) => line.startsWith("run list"))).toHaveLength(1);
    expect(ghCalls().some((line) => line.startsWith("issue list"))).toBe(false);
  });
});
