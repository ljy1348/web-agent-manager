import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { createGitRouter } from "../src/server/routes/git-routes";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 임시 git 저장소와 그걸 가리키는 프로젝트 DB row, 라우터를 붙인 express 서버를 준비한다.
function createHarness(): { database: AppDatabase; repoPath: string; baseUrl: string; server: Server } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-git-diff-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: repoPath }); };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "원본 내용\n");
  git(["add", "tracked.txt"]);
  git(["commit", "-q", "-m", "init"]);

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
  const baseUrl = `http://127.0.0.1:${port}`;

  cleanup.push(() => { server.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, repoPath, baseUrl, server };
}

describe("Git diff: untracked 파일도 diff 내용을 보여준다", () => {
  it("untracked 새 파일은 전체 내용이 추가된 diff로 나온다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "새파일.md"), "첫 줄\n둘째 줄\n");

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/git/diff`);
    const data = await response.json();
    expect(data.diff).toContain("diff --git a/새파일.md b/새파일.md");
    expect(data.diff).toContain("new file mode");
    expect(data.diff).toContain("+첫 줄");
    expect(data.diff).toContain("+둘째 줄");
  });

  it("특정 untracked 파일만 선택해도 다른 무관한 tracked 변경사항은 섞여 나오지 않는다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    // tracked.txt도 수정해서 무관한 변경을 만들어둔다 — 선택한 untracked 파일 diff에 섞이면 안 된다.
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "수정된 내용\n");
    fs.writeFileSync(path.join(repoPath, "새파일.md"), "새 내용\n");

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/git/diff?file=${encodeURIComponent("새파일.md")}`);
    const data = await response.json();
    expect(data.diff).toContain("새파일.md");
    expect(data.diff).not.toContain("tracked.txt");
  });

  it("tracked·untracked 파일이 섞여 있으면 둘 다 diff에 포함된다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "수정된 내용\n");
    fs.writeFileSync(path.join(repoPath, "새파일.md"), "새 내용\n");

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/git/diff`);
    const data = await response.json();
    expect(data.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(data.diff).toContain("diff --git a/새파일.md b/새파일.md");
  });

  it("수정 파일과 삭제 파일을 함께 선택해도 두 diff를 모두 반환한다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "second.txt"), "두 번째 원본\n");
    execFileSync("git", ["add", "second.txt"], { cwd: repoPath });
    execFileSync("git", ["commit", "-q", "-m", "second"], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, "second.txt"), "두 번째 수정\n");
    fs.rmSync(path.join(repoPath, "tracked.txt"));
    const query = new URLSearchParams();
    query.append("file", "second.txt");
    query.append("file", "tracked.txt");

    const response = await fetch(`${baseUrl}/api/projects/${project.id}/git/diff?${query}`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.diff).toContain("diff --git a/second.txt b/second.txt");
    expect(data.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
  });
});
