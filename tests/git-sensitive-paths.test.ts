import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { createGitRouter } from "../src/server/routes/git-routes";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 민감 파일이 있는 임시 git 저장소와 역할·내부망 여부를 주입한 Git 라우터를 준비한다.
function createHarness(options: { trustedNetwork: boolean; role?: "admin" | "user" } = { trustedNetwork: false }): {
  database: AppDatabase;
  repoPath: string;
  projectId: number;
  baseUrl: string;
  server: Server;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-git-sensitive-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: repoPath }); };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["remote", "add", "origin", "https://user:ghp_leakedtoken@github.com/org/repo.git"]);
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "원본 내용\n");
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "src", "index.ts"), "export const ok = 1;\n");
  git(["add", "tracked.txt", "src/index.ts"]);
  git(["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(repoPath, ".env"), "SECRET=super-secret-token\n");

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
  const role = options.role ?? "user";
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(role === "admin" ? 1 : 2, role, role);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('repo', ?, 'manual')").run(repoPath);
  const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };

  const app = express();
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.authUser = { id: role === "admin" ? 1 : 2, username: role, role };
    request.trustedNetwork = options.trustedNetwork;
    next();
  });
  app.use("/api", createGitRouter(database));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : "오류" });
  });
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  cleanup.push(() => { server.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, repoPath, projectId: project.id, baseUrl, server };
}

describe("Git blob/diff는 파일 API와 같은 민감 경로 정책을 따른다", () => {
  it("외부망에서는 blob으로 .env와 .git/config를 읽지 못한다", async () => {
    const { projectId, baseUrl } = createHarness({ trustedNetwork: false, role: "user" });

    const envResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/blob?path=${encodeURIComponent(".env")}`);
    const envBody = await envResponse.text();
    const gitResponse = await fetch(`${baseUrl}/api/projects/${projectId}/git/blob?path=${encodeURIComponent(".git/config")}`);
    const gitBody = await gitResponse.text();

    expect(envResponse.status).toBe(400);
    expect(envBody).not.toContain("SECRET=super-secret-token");
    expect(envBody).toContain("일반 파일 기능으로 접근할 수 없는 경로입니다.");
    expect(gitResponse.status).toBe(400);
    expect(gitBody).not.toContain("ghp_leakedtoken");
    expect(gitBody).toContain("일반 파일 기능으로 접근할 수 없는 경로입니다.");
  });

  it("외부망에서는 diff로 untracked .env 원문을 읽지 못한다", async () => {
    const { projectId, baseUrl } = createHarness({ trustedNetwork: false, role: "user" });

    const response = await fetch(`${baseUrl}/api/projects/${projectId}/git/diff?file=${encodeURIComponent(".env")}`);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("SECRET=super-secret-token");
    expect(body).toContain("일반 파일 기능으로 접근할 수 없는 경로입니다.");
  });

  it("외부망 전체 diff에도 .env 내용이 포함되지 않는다", async () => {
    const { projectId, baseUrl, repoPath } = createHarness({ trustedNetwork: false, role: "user" });
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "수정된 내용\n");

    const response = await fetch(`${baseUrl}/api/projects/${projectId}/git/diff`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.diff).toContain("tracked.txt");
    expect(data.diff).not.toContain("SECRET=super-secret-token");
    expect(data.diff).not.toContain(".env");
  });

  it("외부망에서도 일반 소스 파일 blob·diff는 그대로 조회된다", async () => {
    const { projectId, baseUrl, repoPath } = createHarness({ trustedNetwork: false, role: "user" });
    fs.writeFileSync(path.join(repoPath, "src", "index.ts"), "export const ok = 2;\n");

    const blob = await fetch(`${baseUrl}/api/projects/${projectId}/git/blob?path=${encodeURIComponent("src/index.ts")}`);
    const blobData = await blob.json();
    const diff = await fetch(`${baseUrl}/api/projects/${projectId}/git/diff?file=${encodeURIComponent("src/index.ts")}`);
    const diffData = await diff.json();

    expect(blob.status).toBe(200);
    expect(blobData.lines.join("\n")).toContain("export const ok = 2;");
    expect(diff.status).toBe(200);
    expect(diffData.diff).toContain("src/index.ts");
    expect(diffData.diff).toContain("+export const ok = 2;");
  });

  it("내부망에서는 .env blob·diff를 허용한다", async () => {
    const { projectId, baseUrl } = createHarness({ trustedNetwork: true, role: "user" });

    const blob = await fetch(`${baseUrl}/api/projects/${projectId}/git/blob?path=${encodeURIComponent(".env")}`);
    const blobData = await blob.json();
    const diff = await fetch(`${baseUrl}/api/projects/${projectId}/git/diff?file=${encodeURIComponent(".env")}`);
    const diffData = await diff.json();

    expect(blob.status).toBe(200);
    expect(blobData.lines.join("\n")).toContain("SECRET=super-secret-token");
    expect(diff.status).toBe(200);
    expect(diffData.diff).toContain("SECRET=super-secret-token");
  });

  it("외부망에서는 커밋된 .env를 rev blob으로도 읽지 못한다", async () => {
    const { projectId, baseUrl, repoPath } = createHarness({ trustedNetwork: false, role: "user" });
    execFileSync("git", ["add", "-f", ".env"], { cwd: repoPath });
    execFileSync("git", ["commit", "-q", "-m", "secret"], { cwd: repoPath });

    const response = await fetch(`${baseUrl}/api/projects/${projectId}/git/blob?path=${encodeURIComponent(".env")}&rev=HEAD`);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("SECRET=super-secret-token");
  });

  it("외부망에서는 symlink로 가리킨 .env blob도 차단한다", async () => {
    const { projectId, baseUrl, repoPath } = createHarness({ trustedNetwork: false, role: "user" });
    fs.symlinkSync(path.join(repoPath, ".env"), path.join(repoPath, "public-name"));

    const response = await fetch(`${baseUrl}/api/projects/${projectId}/git/blob?path=${encodeURIComponent("public-name")}`);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).not.toContain("SECRET=super-secret-token");
    expect(body).toContain("일반 파일 기능으로 접근할 수 없는 경로입니다.");
  });
});
