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
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

function harness(trusted = true): { database: AppDatabase; root: string; projectId: number; base: string; server: Server } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-hunk-routes-"));
  execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "qa@example.com"], { cwd: root }); execFileSync("git", ["config", "user.name", "QA"], { cwd: root });
  fs.writeFileSync(path.join(root, "review.txt"), "before\n"); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
  fs.writeFileSync(path.join(root, "review.txt"), "after\n");
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
  const config: AppConfig = { rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('review', ?)").run(root).lastInsertRowid);
  const app = express(); app.use(express.json()); app.use((request: AuthenticatedRequest, _response, next) => { request.authUser = { id: 1, username: "admin", role: "admin" }; request.trustedNetwork = trusted; next(); }); app.use("/api", createGitRouter(database));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(Number((error as any)?.statusCode) || 400).json({ error: error instanceof Error ? error.message : "오류" }));
  const server = app.listen(0); const address = server.address(); const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  cleanup.push(() => { server.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, root, projectId, base, server };
}

describe("Git hunk review API", () => {
  it("snapshot hash로 한 hunk를 승인하고 원문 없는 감사 metadata를 남긴다", async () => {
    const value = harness();
    const snapshot = await fetch(`${value.base}/api/projects/${value.projectId}/git/review?file=review.txt`).then((response) => response.json()) as any;
    const response = await fetch(`${value.base}/api/projects/${value.projectId}/git/hunks/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "review.txt", fileHash: snapshot.files[0].fileHash, hunkId: snapshot.files[0].hunks[0].id, decision: "accept" }) });
    expect(response.status).toBe(200);
    expect(execFileSync("git", ["diff", "--cached", "--", "review.txt"], { cwd: value.root, encoding: "utf8" })).toContain("+after");
    const audit = value.database.prepare("SELECT action, details FROM audit_logs ORDER BY id DESC LIMIT 1").get() as { action: string; details: string };
    expect(audit.action).toBe("git.hunk_accept"); expect(audit.details).not.toContain("after");
  });

  it("신뢰하지 않은 접속에서는 hunk 결정을 파일 적용 전에 거부한다", async () => {
    const value = harness(false);
    const snapshot = await fetch(`${value.base}/api/projects/${value.projectId}/git/review?file=review.txt`).then((response) => response.json()) as any;
    const response = await fetch(`${value.base}/api/projects/${value.projectId}/git/hunks/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "review.txt", fileHash: snapshot.files[0].fileHash, hunkId: snapshot.files[0].hunks[0].id, decision: "reject" }) });
    expect(response.status).toBe(403); expect(fs.readFileSync(path.join(value.root, "review.txt"), "utf8")).toBe("after\n");
  });
});
