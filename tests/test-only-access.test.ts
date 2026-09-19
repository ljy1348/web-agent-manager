import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { createWebSession, requireTestOperator, restrictTestOnlyMutations, type AuthenticatedRequest } from "../src/server/core/auth";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { verifyPassword } from "../src/server/core/security";
import { upsertTestOnlyUser } from "../src/server/core/test-user";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function dataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-test-only-"));
  roots.push(root);
  return root;
}

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("테스트 전용 자격증명", () => {
  it("기존 DB에 access_scope를 추가하고 기존 계정은 standard로 보존한다", () => {
    const root = dataDir();
    const legacy = new Database(path.join(root, "web-agent-manager.sqlite"));
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'user')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users(username, password_hash, role) VALUES ('legacy-admin', 'x', 'admin');
    `);
    legacy.close();

    const database = openDatabase({ dataDir: root } as AppConfig);
    expect(database.prepare("SELECT role, access_scope FROM users WHERE username = 'legacy-admin'").get()).toEqual({ role: "admin", access_scope: "standard" });
    expect(() => database.prepare("INSERT INTO users(username, password_hash, role, access_scope) VALUES ('bad', 'x', 'user', 'anything')").run()).toThrow();
    database.close();
  });

  it("test_only 계정을 만들고 로그인 세션에 scope를 전달하며 기존 계정 강등을 막는다", async () => {
    const root = dataDir();
    const config = { dataDir: root, sessionTtlHours: 12, publicUrl: "http://127.0.0.1" } as AppConfig;
    const database = openDatabase(config);
    const tester = await upsertTestOnlyUser(database, "qa-tester", "long-test-password");
    const stored = database.prepare("SELECT id, username, password_hash, role, access_scope FROM users WHERE id = ?").get(tester.id) as any;

    expect(tester).toMatchObject({ username: "qa-tester", role: "user", access_scope: "test_only" });
    await expect(verifyPassword("long-test-password", stored.password_hash)).resolves.toBe(true);
    expect(createWebSession(database, config, tester.id)?.user).toMatchObject({ role: "user", access_scope: "test_only" });

    await upsertTestOnlyUser(database, "qa-tester", "changed-test-password");
    await expect(verifyPassword("changed-test-password", (database.prepare("SELECT password_hash FROM users WHERE id = ?").get(tester.id) as any).password_hash)).resolves.toBe(true);
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('real-admin', 'x', 'admin')").run();
    await expect(upsertTestOnlyUser(database, "real-admin", "cannot-demote-admin")).rejects.toThrow("변경할 수 없습니다");
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('normal-user', 'x', 'user')").run();
    await expect(upsertTestOnlyUser(database, "normal-user", "cannot-convert-user")).rejects.toThrow("변경할 수 없습니다");
    database.close();
  });

  it("tester의 변경 API는 allowlist 세 경로만 통과하고 운영 변경은 전부 403이다", async () => {
    const app = express();
    app.use((request: AuthenticatedRequest, _response, next) => {
      request.authUser = { id: 3, username: "qa-tester", role: "user", access_scope: "test_only" };
      next();
    });
    app.use("/api", restrictTestOnlyMutations);
    app.use((_request, response) => response.status(204).end());
    const base = await serve(app);
    const allowed = [
      ["POST", "/api/providers/codex/canaries"],
      ["POST", "/api/tasks/task-1/verifications"],
      ["POST", "/api/verifications/run-1/rerun"],
      ["GET", "/api/projects"],
    ];
    const denied = [
      ["POST", "/api/providers/codex/update"],
      ["POST", "/api/providers/codex/rollouts"],
      ["POST", "/api/providers/codex/rollouts/run-1/halt"],
      ["POST", "/api/chats/1/messages"],
      ["POST", "/api/chats/1/stop"],
      ["POST", "/api/projects"],
      ["POST", "/api/projects/1/profile-draft"],
      ["POST", "/api/projects/1/profiles"],
      ["POST", "/api/projects/1/profiles/profile-1/versions"],
      ["POST", "/api/projects/1/profiles/profile-1/activate"],
      ["POST", "/api/tools/mcp"],
      ["PUT", "/api/tools/mcp/claude/project/secure"],
      ["POST", "/api/admin/full-backups"],
      ["PATCH", "/api/tasks/task-1/plan"],
      ["POST", "/api/tasks/task-1/routing/recommend"],
      ["POST", "/api/tasks/task-1/routing/apply"],
      ["PUT", "/api/task-board/limits/provider/codex"],
      ["POST", "/api/task-board/queue/reconcile"],
      ["PUT", "/api/projects/1/preview-target"],
      ["POST", "/api/tasks/task-1/preview-captures"],
      ["PUT", "/api/tasks/task-1/visual-baseline"],
      ["POST", "/api/tasks/task-1/visual-checks"],
      ["POST", "/api/remote-workers"],
      ["POST", "/api/remote-workers/host-1/probe"],
      ["PUT", "/api/projects/1/remote-worker-mapping"],
      ["POST", "/api/tasks/task-1/remote-dispatches"],
      ["POST", "/api/tasks/task-1/remote-dispatches/dispatch-1/refresh"],
      ["POST", "/api/projects/1/github/pr/7/auto-merge"],
      ["POST", "/api/projects/1/git/hunks/decision"],
      ["DELETE", "/api/projects/1"],
      ["POST", "/api/slack/test"],
      ["PUT", "/api/admin/webhook-settings"],
      ["POST", "/api/webhook/test"],
      ["POST", "/api/system/processes/1/kill"],
      ["POST", "/api/admin/providers/codex/shadow/chats/1/probe"],
      ["POST", "/api/verifications/run-1/decision"],
    ];
    const started = performance.now();
    const allowedResponses = await Promise.all(allowed.map(([method, url]) => fetch(`${base}${url}`, { method })));
    const deniedResponses = await Promise.all(denied.map(([method, url]) => fetch(`${base}${url}`, { method })));
    const elapsedMs = performance.now() - started;

    expect(allowedResponses.map((response) => response.status)).toEqual([204, 204, 204, 204]);
    expect(deniedResponses.map((response) => response.status)).toEqual(Array(denied.length).fill(403));
    for (const response of deniedResponses) await expect(response.json()).resolves.toEqual({ error: "테스트 전용 계정은 테스트 기능만 실행할 수 있습니다." });
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("테스트 실행 가드는 admin/tester만 허용하고 일반 user를 거부한다", async () => {
    const statuses: number[] = [];
    for (const user of [
      { id: 1, username: "admin", role: "admin" as const },
      { id: 2, username: "tester", role: "user" as const, access_scope: "test_only" as const },
      { id: 3, username: "user", role: "user" as const, access_scope: "standard" as const },
    ]) {
      const app = express();
      app.use((request: AuthenticatedRequest, _response, next) => { request.authUser = user; next(); });
      app.post("/test", requireTestOperator, (_request, response) => response.status(204).end());
      const base = await serve(app);
      statuses.push((await fetch(`${base}/test`, { method: "POST" })).status);
    }
    expect(statuses).toEqual([204, 204, 403]);
  });
});
