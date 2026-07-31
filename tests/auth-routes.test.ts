import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { createSessionLoader } from "../src/server/core/auth";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { hashPassword, timingSafeEqualString } from "../src/server/core/security";
import { createAuthRouter } from "../src/server/routes/auth-routes";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

// 인증 라우터 테스트용 임시 설정과 실제 SQLite DB를 만든다.
function createTestContext(): { database: AppDatabase; config: AppConfig } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-auth-root-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-auth-data-"));
  const config: AppConfig = {
    rootDir,
    homeDir: rootDir,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    allowedRoots: [rootDir],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  cleanup.push(() => {
    database.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { database, config };
}

// 인증 라우터를 실제 HTTP 서버에 붙여 fetch 가능한 기준 URL을 반환한다.
async function serveAuth(database: AppDatabase, config: AppConfig, trustedNetwork = false): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.trustedNetwork = trustedNetwork;
    next();
  });
  app.use(createSessionLoader(database));
  app.use("/api/auth", createAuthRouter(database, config));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("인증 라우트 보안", () => {
  it("사용자가 없을 때 신뢰 네트워크에서만 첫 관리자를 생성한다", async () => {
    const outside = createTestContext();
    const outsideUrl = await serveAuth(outside.database, outside.config, false);
    const denied = await fetch(`${outsideUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-password" }),
    });
    expect(denied.status).toBe(403);
    expect((outside.database.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count).toBe(0);

    const inside = createTestContext();
    const insideUrl = await serveAuth(inside.database, inside.config, true);
    const created = await fetch(`${insideUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-password" }),
    });
    const duplicate = await fetch(`${insideUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "second-admin", password: "correct-password" }),
    });

    expect(created.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect((inside.database.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count).toBe(1);
  });

  it("로그인 실패를 감사 로그에 남기고 5회 실패 뒤 같은 IP+계정 조합을 제한한다", async () => {
    const { database, config } = createTestContext();
    const baseUrl = await serveAuth(database, config);

    const attempts = [];
    for (let index = 0; index < 5; index += 1) {
      attempts.push(await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "missing-user", password: "wrong-password" }),
      }));
    }
    const blocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "missing-user", password: "wrong-password" }),
    });
    const repeatedBlocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "missing-user", password: "wrong-password" }),
    });

    expect(attempts.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(blocked.status).toBe(429);
    expect(repeatedBlocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const auditRows = database.prepare("SELECT action, target_id, details FROM audit_logs ORDER BY id").all() as Array<{ action: string; target_id: string; details: string }>;
    expect(auditRows.map((row) => row.action)).toEqual([
      "auth.login.failed",
      "auth.login.failed",
      "auth.login.failed",
      "auth.login.failed",
      "auth.login.failed",
      "auth.login.rate_limited",
    ]);
    expect(auditRows.every((row) => row.target_id === "missing-user")).toBe(true);
    expect(auditRows.some((row) => row.details.includes("wrong-password"))).toBe(false);
  });

  it("과도하게 긴 로그인 입력을 저장하지 않고 IP 제한에는 포함한다", async () => {
    const { database, config } = createTestContext();
    const baseUrl = await serveAuth(database, config);
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "x".repeat(10_000), password: "wrong-password" }),
    });
    const row = database.prepare("SELECT target_id FROM audit_logs WHERE action = 'auth.login.failed'").get() as { target_id: string };
    expect(response.status).toBe(400);
    expect(row.target_id).toBe("<invalid>");
  });

  it("로그인 성공 시 실패 카운터를 초기화하고 세션 쿠키를 내려준다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config);

    const failed = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });
    const success = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-password" }),
    });

    expect(failed.status).toBe(401);
    expect(success.status).toBe(200);
    expect(success.headers.get("set-cookie")).toContain("web_agent_manager_session=");
    const actions = database.prepare("SELECT action FROM audit_logs ORDER BY id").all() as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual(["auth.login.failed", "auth.login"]);
  });

  it("로그인 응답과 /me에 현재 요청의 신뢰 네트워크 여부를 포함한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("network-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "network-admin", password: "correct-password" }),
    });
    const loginBody = await login.json();
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const meBody = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).json();
    const legacyCookie = cookie.replace("web_agent_manager_session=", "myagent_session=");
    const legacyMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: legacyCookie } });

    expect(loginBody.networkTrusted).toBe(true);
    expect(meBody.networkTrusted).toBe(true);
    expect(legacyMe.status).toBe(200);
  });

  it("문자열 비교 헬퍼는 같은 값만 true를 반환한다", () => {
    expect(timingSafeEqualString("Bearer token", "Bearer token")).toBe(true);
    expect(timingSafeEqualString("Bearer token", "Bearer other")).toBe(false);
    expect(timingSafeEqualString("short", "much-longer-secret")).toBe(false);
  });

  it("계정별 마지막 프로젝트와 채팅을 저장하고 /me에서 돌려준다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("admin", await hashPassword("correct-password"));
    const project = database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(path.join(config.rootDir, "p"));
    const projectId = Number(project.lastInsertRowid);
    const chat = database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title)
      VALUES (?, 'codex', 'tmux-test', 'stopped', '테스트 채팅')
    `).run(projectId);
    const chatId = Number(chat.lastInsertRowid);
    const baseUrl = await serveAuth(database, config);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct-password" }),
    });
    const loginBody = await login.json();
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const save = await fetch(`${baseUrl}/api/auth/last-session`, {
      method: "POST",
      headers: { "content-type": "application/json", "cookie": cookie, "x-csrf-token": loginBody.csrfToken },
      body: JSON.stringify({ projectId, chatId }),
    });
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    const meBody = await me.json();

    expect(save.status).toBe(200);
    expect(meBody.user.last_project_id).toBe(projectId);
    expect(meBody.user.last_chat_id).toBe(chatId);
  });
});
