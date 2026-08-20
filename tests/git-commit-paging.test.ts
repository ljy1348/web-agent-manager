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

// 커밋이 여러 개 쌓인 임시 저장소와 라우터를 붙인 express 서버를 준비한다.
function createHarness(commitCount: number): { database: AppDatabase; repoPath: string; baseUrl: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-git-paging-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: repoPath }); };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  for (let index = 1; index <= commitCount; index += 1) {
    fs.writeFileSync(path.join(repoPath, "log.txt"), `${index}\n`);
    git(["add", "log.txt"]);
    git(["commit", "-q", "-m", `커밋 ${index}`]);
  }

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

  cleanup.push(() => { server.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, repoPath, baseUrl: `http://127.0.0.1:${port}` };
}

// 저장소를 만들고 커밋 목록을 한 번 조회한다.
async function fetchCommits(commitCount: number, query = ""): Promise<{ commits: Array<{ subject: string }>; hasMoreCommits: boolean }> {
  const { database, repoPath, baseUrl } = createHarness(commitCount);
  const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
  const response = await fetch(`${baseUrl}/api/projects/${project.id}/git${query}`);
  return await response.json();
}

describe("Git 커밋 목록 페이징", () => {
  it("기본 조회는 30개까지만 주고 뒤에 더 있다고 알린다", async () => {
    const data = await fetchCommits(35);
    expect(data.commits).toHaveLength(30);
    expect(data.hasMoreCommits).toBe(true);
    // 최신 커밋부터 내려온다. 하나 더 읽어 판단하는 방식이라 31번째가 섞여 나오면 안 된다.
    expect(data.commits[0].subject).toBe("커밋 35");
    expect(data.commits.at(-1)?.subject).toBe("커밋 6");
  });

  it("커밋이 기본 개수보다 적으면 더 있다고 하지 않는다", async () => {
    const data = await fetchCommits(5);
    expect(data.commits).toHaveLength(5);
    expect(data.hasMoreCommits).toBe(false);
  });

  it("커밋 수가 요청 개수와 정확히 같으면 더 있다고 하지 않는다", async () => {
    const data = await fetchCommits(10, "?commits=10");
    expect(data.commits).toHaveLength(10);
    expect(data.hasMoreCommits).toBe(false);
  });

  it("더 보기로 개수를 늘리면 그만큼 더 내려온다", async () => {
    const data = await fetchCommits(35, "?commits=60");
    expect(data.commits).toHaveLength(35);
    expect(data.hasMoreCommits).toBe(false);
    expect(data.commits.at(-1)?.subject).toBe("커밋 1");
  });

  it("개수 값이 잘못되면 기본값으로 되돌린다", async () => {
    const data = await fetchCommits(35, "?commits=-5");
    expect(data.commits).toHaveLength(30);
    expect(data.hasMoreCommits).toBe(true);
  });

  it("한 번에 요청할 수 있는 개수에는 상한이 있다", async () => {
    const data = await fetchCommits(3, "?commits=100000");
    // 상한을 넘겨도 오류 없이 상한 개수 기준으로 처리된다.
    expect(data.commits).toHaveLength(3);
    expect(data.hasMoreCommits).toBe(false);
  });
});
