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

// 임시 git 저장소와 그걸 가리키는 프로젝트 DB row, 인증·신뢰 네트워크 미들웨어를 붙인 라우터를 준비한다.
function createHarness(trustedNetwork = true): { database: AppDatabase; repoPath: string; baseUrl: string; server: Server } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-git-discard-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: repoPath }); };
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "원본 내용\n");
  fs.writeFileSync(path.join(repoPath, "src", "a.txt"), "a 원본\n");
  fs.writeFileSync(path.join(repoPath, "src", "b.txt"), "b 원본\n");
  git(["add", "."]);
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
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('repo', ?, 'manual')").run(repoPath);

  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    request.trustedNetwork = trustedNetwork;
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
  return { database, repoPath, baseUrl, server };
}

async function discard(baseUrl: string, projectId: number, files: string[]): Promise<Response> {
  return fetch(`${baseUrl}/api/projects/${projectId}/git/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
}

describe("Git 롤백: 선택 파일·폴더의 미커밋 변경을 되돌린다", () => {
  it("수정된 추적 파일은 HEAD 내용으로 복원된다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "고친 내용\n");

    const response = await discard(baseUrl, project.id, ["tracked.txt"]);

    expect(response.status).toBe(204);
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("원본 내용\n");
  });

  it("삭제된 추적 파일은 다시 살아난다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.rmSync(path.join(repoPath, "tracked.txt"));

    const response = await discard(baseUrl, project.id, ["tracked.txt"]);

    expect(response.status).toBe(204);
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("원본 내용\n");
  });

  it("git add로 스테이지된 새 파일은 인덱스·워킹트리 모두에서 사라진다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "staged-new.txt"), "아직 커밋 안 함\n");
    execFileSync("git", ["add", "staged-new.txt"], { cwd: repoPath });

    const response = await discard(baseUrl, project.id, ["staged-new.txt"]);

    expect(response.status).toBe(204);
    expect(fs.existsSync(path.join(repoPath, "staged-new.txt"))).toBe(false);
  });

  it("한 번도 add하지 않은 untracked 파일도 롤백으로 삭제된다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "scratch.txt"), "임시 파일\n");

    const response = await discard(baseUrl, project.id, ["scratch.txt"]);

    expect(response.status).toBe(204);
    expect(fs.existsSync(path.join(repoPath, "scratch.txt"))).toBe(false);
  });

  it("폴더 단위로 고른 여러 파일을 한 번에 되돌리고, 선택 밖 파일은 그대로 둔다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "src", "a.txt"), "a 수정\n");
    fs.writeFileSync(path.join(repoPath, "src", "b.txt"), "b 수정\n");
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "이건 선택 안 함\n");

    const response = await discard(baseUrl, project.id, ["src/a.txt", "src/b.txt"]);

    expect(response.status).toBe(204);
    expect(fs.readFileSync(path.join(repoPath, "src", "a.txt"), "utf8")).toBe("a 원본\n");
    expect(fs.readFileSync(path.join(repoPath, "src", "b.txt"), "utf8")).toBe("b 원본\n");
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("이건 선택 안 함\n");
  });

  it("외부망(신뢰 네트워크 아님)에서는 롤백을 403으로 거부하고 파일을 건드리지 않는다", async () => {
    const { database, repoPath, baseUrl } = createHarness(false);
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };
    fs.writeFileSync(path.join(repoPath, "tracked.txt"), "고친 내용\n");

    const response = await discard(baseUrl, project.id, ["tracked.txt"]);

    expect(response.status).toBe(403);
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("고친 내용\n");
  });

  it("선택 파일이 없으면 400으로 거부한다", async () => {
    const { database, repoPath, baseUrl } = createHarness();
    const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(repoPath) as { id: number };

    const response = await discard(baseUrl, project.id, []);

    expect(response.status).toBe(400);
  });
});
