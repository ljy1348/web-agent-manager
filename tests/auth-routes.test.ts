import { once } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { createRecentReauthenticationGuard, createSessionLoader, requireAuth, requireCsrf, requiresRecentReauthentication } from "../src/server/core/auth";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { hashPassword, hashToken, timingSafeEqualString, verifyPassword } from "../src/server/core/security";
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
async function serveAuth(database: AppDatabase, config: AppConfig, trustedNetwork = false, idleMinutes = 720, protectedProbe = false): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.trustedNetwork = trustedNetwork;
    next();
  });
  app.use(createSessionLoader(database, idleMinutes));
  app.use("/api/auth", createAuthRouter(database, config));
  if (protectedProbe) app.post("/api/protected", requireAuth, requireCsrf, createRecentReauthenticationGuard(database, config.reauthenticationWindowMinutes ?? 15), (_request, response) => response.json({ changed: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function loginAccount(baseUrl: string, username: string, password: string): Promise<{ cookie: string; csrfToken: string }> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  return { cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "", csrfToken: body.csrfToken };
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

  it("현재 세션을 표시하고 다른 세션만 CSRF 검증 뒤 폐기한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("session-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config);
    const first = await loginAccount(baseUrl, "session-admin", "correct-password");
    const second = await loginAccount(baseUrl, "session-admin", "correct-password");

    const listed = await fetch(`${baseUrl}/api/auth/sessions`, { headers: { cookie: second.cookie } });
    const listBody = await listed.json() as { sessions: Array<{ current: boolean }>; hasMore: boolean };
    const missingCsrf = await fetch(`${baseUrl}/api/auth/sessions/revoke-others`, { method: "POST", headers: { cookie: second.cookie } });
    const revoked = await fetch(`${baseUrl}/api/auth/sessions/revoke-others`, {
      method: "POST",
      headers: { cookie: second.cookie, "x-csrf-token": second.csrfToken },
    });
    const revokedBody = await revoked.json() as { revokedCount: number };

    expect(listed.status).toBe(200);
    expect(listBody).toMatchObject({ hasMore: false });
    expect(listBody.sessions).toHaveLength(2);
    expect(listBody.sessions.filter((session) => session.current)).toHaveLength(1);
    expect(missingCsrf.status).toBe(403);
    expect(revokedBody.revokedCount).toBe(1);
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: first.cookie } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: second.cookie } })).status).toBe(200);
    const audit = database.prepare("SELECT details FROM audit_logs WHERE action = 'auth.sessions.revoke_others'").get() as { details: string };
    expect(JSON.parse(audit.details)).toEqual({ revokedCount: 1 });
  });

  it("idle timeout 세션을 인증에서 제외하고 DB에서도 정리한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')").run("idle-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, false, 5);
    const session = await loginAccount(baseUrl, "idle-admin", "correct-password");
    database.prepare("UPDATE web_sessions SET last_seen_at = datetime('now', '-6 minutes')").run();

    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: session.cookie } })).status).toBe(401);
    expect((database.prepare("SELECT COUNT(*) AS count FROM web_sessions").get() as { count: number }).count).toBe(0);
  });

  it("오래된 재인증은 중요 작업을 막고 현재 비밀번호 재확인 뒤 짧은 창을 연다", async () => {
    const { database, config } = createTestContext();
    config.reauthenticationWindowMinutes = 15;
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')").run("reauth-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, false, 720, true);
    const session = await loginAccount(baseUrl, "reauth-admin", "correct-password");
    database.prepare("UPDATE web_sessions SET reauthenticated_at = datetime('now', '-16 minutes')").run();
    const headers = { "content-type": "application/json", cookie: session.cookie, "x-csrf-token": session.csrfToken };

    const blocked = await fetch(`${baseUrl}/api/protected`, { method: "POST", headers });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ reauthRequired: true });
    expect((await fetch(`${baseUrl}/api/auth/reauth`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "wrong-password" }) })).status).toBe(401);
    const reauthenticated = await fetch(`${baseUrl}/api/auth/reauth`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "correct-password" }) });
    expect(reauthenticated.status).toBe(200);
    expect(await reauthenticated.json()).toMatchObject({ reauthenticatedAt: expect.any(String), validUntil: expect.any(String) });
    expect((await fetch(`${baseUrl}/api/protected`, { method: "POST", headers })).status).toBe(200);
    expect((database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'auth.reauthenticate'").get() as { count: number }).count).toBe(1);
  });

  it("중요 작업 분류는 모든 DELETE와 호스트·자격증명·복구 영향 경로만 선택한다", () => {
    expect(requiresRecentReauthentication("DELETE", "/projects/1")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/providers/codex/update")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/providers/claude/updates/run-1/rollback")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/system/processes/123/kill")).toBe(true);
    expect(requiresRecentReauthentication("PUT", "/tools/mcp/codex/user/server")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/projects/1/github/pr/3/merge")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/admin/full-backups")).toBe(true);
    expect(requiresRecentReauthentication("GET", "/admin/full-backups/backup-1/download")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/tasks/task-1/routing/apply")).toBe(true);
    expect(requiresRecentReauthentication("PUT", "/task-board/limits/account/1")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/task-board/queue/reconcile")).toBe(true);
    expect(requiresRecentReauthentication("PUT", "/projects/1/preview-target")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/projects/1/profiles")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/projects/1/profiles/profile-1/versions")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/projects/1/profiles/profile-1/activate")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/tasks/task-1/preview-captures")).toBe(true);
    expect(requiresRecentReauthentication("PUT", "/tasks/task-1/visual-baseline")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/tasks/task-1/visual-checks")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/remote-workers")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/remote-workers/host-1/probe")).toBe(true);
    expect(requiresRecentReauthentication("PUT", "/projects/1/remote-worker-mapping")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/tasks/task-1/remote-dispatches")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/tasks/task-1/remote-dispatches/dispatch-1/refresh")).toBe(true);
    expect(requiresRecentReauthentication("PUT", "/admin/webhook-settings")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/webhook/test")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/projects/1/github/pr/3/auto-merge")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/projects/1/git/hunks/decision")).toBe(true);
    expect(requiresRecentReauthentication("POST", "/tasks/task-1/routing/recommend")).toBe(false);
    expect(requiresRecentReauthentication("POST", "/providers/codex/canaries")).toBe(false);
    expect(requiresRecentReauthentication("POST", "/tasks/task-1/verifications")).toBe(false);
    expect(requiresRecentReauthentication("POST", "/chats/1/messages")).toBe(false);
    expect(requiresRecentReauthentication("GET", "/system/processes/123/kill")).toBe(false);
  });

  it("비밀번호 변경은 현재 암호를 검증하고 모든 세션을 폐기한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("password-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config);
    const first = await loginAccount(baseUrl, "password-admin", "correct-password");
    const second = await loginAccount(baseUrl, "password-admin", "correct-password");

    const denied = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: second.cookie, "x-csrf-token": second.csrfToken },
      body: JSON.stringify({ currentPassword: "incorrect-password", newPassword: "new-correct-password" }),
    });
    expect(denied.status).toBe(401);
    expect((database.prepare("SELECT COUNT(*) AS count FROM web_sessions").get() as { count: number }).count).toBe(2);

    const changed = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: second.cookie, "x-csrf-token": second.csrfToken },
      body: JSON.stringify({ currentPassword: "correct-password", newPassword: "new-correct-password" }),
    });
    const changedBody = await changed.json();
    const user = database.prepare("SELECT password_hash, password_changed_at FROM users WHERE username = 'password-admin'").get() as { password_hash: string; password_changed_at: string | null };

    expect(changed.status).toBe(200);
    expect(changedBody).toEqual({ changed: true, revokedCount: 2, loginRequired: true });
    expect(changed.headers.get("set-cookie")).toContain("web_agent_manager_session=;");
    expect(user.password_changed_at).not.toBeNull();
    expect(await verifyPassword("new-correct-password", user.password_hash)).toBe(true);
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: first.cookie } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: second.cookie } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "password-admin", password: "correct-password" }),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "password-admin", password: "new-correct-password" }),
    })).status).toBe(200);
  });

  it("세션 목록은 대량 세션에서도 100개로 제한하고 현재 세션을 빠르게 반환한다", async () => {
    const { database, config } = createTestContext();
    const user = database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("many-sessions", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config);
    const current = await loginAccount(baseUrl, "many-sessions", "correct-password");
    const insert = database.prepare("INSERT INTO web_sessions(user_id, token_hash, csrf_token, expires_at) VALUES (?, ?, 'csrf', datetime('now', '+1 hour'))");
    const addMany = database.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) insert.run(Number(user.lastInsertRowid), `bulk-${index}`);
    });
    addMany();
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/api/auth/sessions`, { headers: { cookie: current.cookie } });
    const elapsedMs = performance.now() - startedAt;
    const body = await response.json() as { sessions: Array<{ current: boolean }>; hasMore: boolean };
    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(100);
    expect(body.hasMore).toBe(true);
    expect(body.sessions.some((session) => session.current)).toBe(true);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("임시 로그인은 자기 세션을 조회할 수 있지만 폐기와 비밀번호 변경은 할 수 없다", async () => {
    const { database, config } = createTestContext();
    const user = database.prepare(`INSERT INTO users(username, password_hash, role, temporary_expires_at)
      VALUES ('temporary-security', 'login-disabled', 'user', datetime('now', '+1 hour'))`).run();
    const token = "temporary-security-session";
    database.prepare(`INSERT INTO web_sessions(user_id, token_hash, csrf_token, network_access_allowed, expires_at)
      VALUES (?, ?, 'temporary-csrf', 0, datetime('now', '+1 hour'))`).run(Number(user.lastInsertRowid), hashToken(token));
    const baseUrl = await serveAuth(database, config);
    const headers = { "content-type": "application/json", cookie: `web_agent_manager_session=${token}`, "x-csrf-token": "temporary-csrf" };

    const listed = await fetch(`${baseUrl}/api/auth/sessions`, { headers });
    const revoke = await fetch(`${baseUrl}/api/auth/sessions/revoke-others`, { method: "POST", headers });
    const password = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST", headers,
      body: JSON.stringify({ currentPassword: "anything", newPassword: "new-password-123" }),
    });

    expect(listed.status).toBe(200);
    expect(revoke.status).toBe(403);
    expect(password.status).toBe(403);
    expect((database.prepare("SELECT COUNT(*) AS count FROM web_sessions WHERE user_id = ?").get(Number(user.lastInsertRowid)) as { count: number }).count).toBe(1);
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
    expect(meBody.user.chat_view_mode).toBe("chat");
  });

  it("채팅 화면 모드를 웹 계정별로 저장하고 검증한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("mode-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mode-admin", password: "correct-password" }),
    });
    const loginBody = await login.json();
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const invalid = await fetch(`${baseUrl}/api/auth/chat-view-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": loginBody.csrfToken },
      body: JSON.stringify({ chatViewMode: "split" }),
    });
    const saved = await fetch(`${baseUrl}/api/auth/chat-view-mode`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": loginBody.csrfToken },
      body: JSON.stringify({ chatViewMode: "terminal" }),
    });
    const meBody = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).json();
    const audit = database.prepare("SELECT details FROM audit_logs WHERE action = 'user.chat_view_mode.update'").get() as { details: string };

    expect(invalid.status).toBe(400);
    expect(saved.status).toBe(200);
    expect(meBody.user.chat_view_mode).toBe("terminal");
    expect(JSON.parse(audit.details)).toEqual({ chatViewMode: "terminal" });
  });

  it("관리자만 8자리 코드를 발급하고 한 번만 일반 사용자 비신뢰 세션으로 교환한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("issuer-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);

    const unauthenticatedIssue = await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST" });
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "issuer-admin", password: "correct-password" }),
    });
    const adminBody = await adminLogin.json();
    const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const missingCsrf = await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers: { cookie: adminCookie } });
    const issue = await fetch(`${baseUrl}/api/auth/one-time-codes`, {
      method: "POST",
      headers: { cookie: adminCookie, "x-csrf-token": adminBody.csrfToken },
    });
    const issued = await issue.json();
    const storedCode = database.prepare("SELECT code_hash FROM one_time_login_codes").get() as { code_hash: string };

    expect(unauthenticatedIssue.status).toBe(401);
    expect(missingCsrf.status).toBe(403);
    expect(issue.status).toBe(201);
    expect(issued.oneTimeCode).toMatch(/^\d{8}$/);
    expect(issued.codeTtlMinutes).toBe(10);
    expect(issued.sessionTtlMinutes).toBe(60);
    expect(storedCode.code_hash).toMatch(/^hmac:/);
    expect(storedCode.code_hash).not.toContain(issued.oneTimeCode);

    const temporaryLogin = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.oneTimeCode }),
    });
    const temporaryBody = await temporaryLogin.json();
    const temporaryCookie = temporaryLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: temporaryCookie } });
    const meBody = await me.json();
    const sessionRow = database.prepare(`
      SELECT s.network_access_allowed, u.role, u.temporary_expires_at
      FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = (SELECT token_hash FROM web_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1)
    `).get(temporaryBody.user.id) as { network_access_allowed: number; role: string; temporary_expires_at: string | null };

    expect(temporaryLogin.status).toBe(200);
    expect(temporaryLogin.headers.get("set-cookie")).toContain("Max-Age=3600");
    expect(temporaryBody.user.role).toBe("user");
    expect(temporaryBody.temporary).toBe(true);
    expect(temporaryBody.networkTrusted).toBe(false);
    expect(me.status).toBe(200);
    expect(meBody.networkTrusted).toBe(false);
    expect(meBody.temporary).toBe(true);
    expect(sessionRow).toMatchObject({ network_access_allowed: 0, role: "user" });
    expect(sessionRow.temporary_expires_at).not.toBeNull();

    const temporaryIssue = await fetch(`${baseUrl}/api/auth/one-time-codes`, {
      method: "POST",
      headers: { cookie: temporaryCookie, "x-csrf-token": temporaryBody.csrfToken },
    });
    const reused = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.oneTimeCode }),
    });
    expect(temporaryIssue.status).toBe(403);
    expect(reused.status).toBe(401);
  });

  it("만료된 임시 사용자의 감사 기록을 보존하고 다음 코드를 재발급한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("reissue-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "reissue-admin", password: "correct-password" }),
    });
    const adminBody = await adminLogin.json();
    const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const issueHeaders = { cookie: adminCookie, "x-csrf-token": adminBody.csrfToken };
    const firstIssue = await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers: issueHeaders });
    const firstCode = await firstIssue.json();
    const temporaryLogin = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: firstCode.oneTimeCode }),
    });
    const temporaryBody = await temporaryLogin.json();
    const temporaryUserId = temporaryBody.user.id as number;
    const auditBefore = database.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE user_id = ? AND action = 'auth.one_time_login'",
    ).get(temporaryUserId) as { count: number };

    database.prepare("UPDATE users SET temporary_expires_at = datetime('now', '-1 minute') WHERE id = ?").run(temporaryUserId);
    const secondIssue = await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers: issueHeaders });
    const auditAfter = database.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE user_id IS NULL AND action = 'auth.one_time_login'",
    ).get() as { count: number };

    expect(firstIssue.status).toBe(201);
    expect(temporaryLogin.status).toBe(200);
    expect(auditBefore.count).toBe(1);
    expect(secondIssue.status).toBe(201);
    expect((database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(temporaryUserId) as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM web_sessions WHERE user_id = ?").get(temporaryUserId) as { count: number }).count).toBe(0);
    expect(auditAfter.count).toBeGreaterThanOrEqual(1);
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("만료된 일회용 코드와 임시 세션을 거부한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("expiry-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "expiry-admin", password: "correct-password" }),
    });
    const adminBody = await adminLogin.json();
    const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const issue = await fetch(`${baseUrl}/api/auth/one-time-codes`, {
      method: "POST",
      headers: { cookie: adminCookie, "x-csrf-token": adminBody.csrfToken },
    });
    const issued = await issue.json();
    database.prepare("UPDATE one_time_login_codes SET expires_at = datetime('now', '-1 minute')").run();
    const expiredCode = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.oneTimeCode }),
    });
    expect(expiredCode.status).toBe(401);

    const secondIssue = await fetch(`${baseUrl}/api/auth/one-time-codes`, {
      method: "POST",
      headers: { cookie: adminCookie, "x-csrf-token": adminBody.csrfToken },
    });
    const secondCode = await secondIssue.json();
    const temporaryLogin = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: secondCode.oneTimeCode }),
    });
    const temporaryBody = await temporaryLogin.json();
    const temporaryCookie = temporaryLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    database.prepare("UPDATE web_sessions SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(temporaryBody.user.id);
    const expiredSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: temporaryCookie } });
    expect(expiredSession.status).toBe(401);
  });

  it("활성 코드가 한도만큼 있으면 발급을 거부하고, 가장 오래된 유효 코드도 그대로 교환된다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("limit-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "limit-admin", password: "correct-password" }),
    });
    const adminBody = await adminLogin.json();
    const issueHeaders = { cookie: adminLogin.headers.get("set-cookie")?.split(";")[0] ?? "", "x-csrf-token": adminBody.csrfToken };
    const issuer = (database.prepare("SELECT id FROM users WHERE username = 'limit-admin'").get() as { id: number }).id;

    // 가장 먼저 만들어진 코드를 알고 있어야 후보 조회에서 밀려나는지 확인할 수 있어 직접 넣는다.
    // 옛 scrypt 형식으로 넣어, HMAC 전환 전에 발급된 코드도 계속 교환되는지(과도기 경로) 함께 본다.
    const oldestCode = "10000001";
    database.prepare(`
      INSERT INTO one_time_login_codes(id, code_hash, issued_by, expires_at, created_at)
      VALUES (?, ?, ?, datetime('now', '+10 minutes'), datetime('now', '-5 minutes'))
    `).run("oldest-code-id", await hashPassword(oldestCode), issuer);
    for (let index = 0; index < 9; index += 1) {
      const filled = await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers: issueHeaders });
      expect(filled.status).toBe(201);
    }

    const overLimit = await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers: issueHeaders });
    const activeCount = (database.prepare(`
      SELECT COUNT(*) AS count FROM one_time_login_codes WHERE consumed_at IS NULL AND expires_at > datetime('now')
    `).get() as { count: number }).count;
    expect(overLimit.status).toBe(429);
    expect(activeCount).toBe(10);
    // 코드 수명 전체가 아니라 가장 이른 만료까지만 기다리게 한다.
    const retryAfter = Number(overLimit.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10 * 60);

    const oldestLogin = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: oldestCode }),
    });
    const oldestBody = await oldestLogin.json();
    expect(oldestLogin.status).toBe(200);
    expect(oldestBody.user.role).toBe("user");
    expect((database.prepare("SELECT consumed_at FROM one_time_login_codes WHERE id = 'oldest-code-id'").get() as { consumed_at: string | null }).consumed_at).not.toBeNull();
  });

  it("성공·실패 로그인 모두 IP와 식별자를 남기고 민감 정보는 넣지 않는다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("audit-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const headers = {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (audit-check)",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      origin: "https://example.test",
      "accept-language": "ko-KR,ko;q=0.9",
    };

    await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ username: "audit-admin", password: "wrong-password" }) });
    await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ username: "audit-admin", password: "correct-password" }) });
    await fetch(`${baseUrl}/api/auth/one-time-login`, { method: "POST", headers, body: JSON.stringify({ code: "00000001" }) });

    const rows = database.prepare("SELECT action, details FROM audit_logs ORDER BY id").all() as Array<{ action: string; details: string }>;
    expect(rows.map((row) => row.action)).toEqual(["auth.login.failed", "auth.login", "auth.one_time_login.failed"]);
    for (const row of rows) {
      const details = JSON.parse(row.details);
      expect(details.ip).toBeTruthy();
      expect(details.userAgent).toBe("Mozilla/5.0 (audit-check)");
      expect(details.forwardedFor).toBe("203.0.113.7, 10.0.0.1");
      expect(details.origin).toBe("https://example.test");
      expect(details.acceptLanguage).toBe("ko-KR,ko;q=0.9");
      expect(details.method).toBeTruthy();
    }
    // 비밀번호·코드 원문·토큰은 어떤 기록에도 남지 않아야 한다.
    const dump = rows.map((row) => row.details).join(" ");
    expect(dump).not.toContain("correct-password");
    expect(dump).not.toContain("wrong-password");
    expect(dump).not.toContain("00000001");
    expect(dump.toLowerCase()).not.toContain("csrf");
  });

  it("성공 로그인 기록도 보존 기간이 지나면 정리한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("prune-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const login = () => fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "prune-admin", password: "correct-password" }),
    });

    // 정리는 감사 기록 100건마다 한 번 돌고 첫 기록에서 먼저 한 번 돈다. 보존 기간이 지난 성공
    // 기록을 미리 넣어 두고 로그인하면 그 첫 정리에서 지워져야 한다.
    database.prepare(`
      INSERT INTO audit_logs(user_id, action, target_type, target_id, details, created_at)
      VALUES (NULL, 'auth.login', 'user', '1', '{}', datetime('now', '-31 days'))
    `).run();
    await login();

    const rows = database.prepare("SELECT created_at FROM audit_logs WHERE action = 'auth.login'").all() as Array<{ created_at: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].created_at.startsWith("20")).toBe(true);
  });

  it("30일 안에 같은 숫자가 다시 뽑히면 다른 숫자로 다시 발급한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("dup-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "dup-admin", password: "correct-password" }),
    });
    const body = await login.json();
    const headers = { cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "", "x-csrf-token": body.csrfToken };

    // HMAC은 같은 숫자에 같은 해시를 만들고 code_hash에는 UNIQUE가 있다. 소비된 행도 30일 남으므로
    // 같은 숫자를 다시 뽑는 상황을 randomInt를 고정해 그대로 재현한다.
    const first = await (await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers })).json();
    const firstNumber = Number(first.oneTimeCode);
    database.prepare("UPDATE one_time_login_codes SET consumed_at = CURRENT_TIMESTAMP").run();

    const randomInt = vi.spyOn(crypto, "randomInt") as unknown as { mockImplementationOnce: (fn: () => number) => { mockImplementationOnce: (fn: () => number) => void }; mockRestore: () => void };
    randomInt.mockImplementationOnce(() => firstNumber).mockImplementationOnce(() => (firstNumber + 1) % 100_000_000);
    const retried = await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers });
    const retriedBody = await retried.json();
    randomInt.mockRestore();

    expect(retried.status).toBe(201);
    // 첫 숫자가 UNIQUE에 걸려 두 번째 숫자로 다시 발급된 것을 정확히 확인한다.
    expect(retriedBody.oneTimeCode).toBe(String((firstNumber + 1) % 100_000_000).padStart(8, "0"));
    expect(retriedBody.oneTimeCode).not.toBe(first.oneTimeCode);
    // 첫 시도가 UNIQUE에 걸려도 행이 남지 않고, 두 번째 숫자만 저장된다.
    expect((database.prepare("SELECT COUNT(*) AS count FROM one_time_login_codes").get() as { count: number }).count).toBe(2);
    const exchanged = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: retriedBody.oneTimeCode }),
    });
    expect(exchanged.status).toBe(200);
  });

  it("코드 해시 시크릿을 데이터 디렉터리에 0600으로 만들고 재사용한다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("secret-admin", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "secret-admin", password: "correct-password" }),
    });
    const body = await login.json();
    const headers = { cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "", "x-csrf-token": body.csrfToken };

    const first = await (await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers })).json();
    const secretFile = path.join(config.dataDir, "one-time-code-secret");
    const stat = fs.statSync(secretFile);
    const second = await (await fetch(`${baseUrl}/api/auth/one-time-codes`, { method: "POST", headers })).json();

    expect(stat.size).toBeGreaterThanOrEqual(32);
    expect(stat.mode & 0o777).toBe(0o600);
    // 시크릿이 매번 새로 만들어지면 이전에 발급한 코드가 교환되지 않는다.
    const exchanged = await fetch(`${baseUrl}/api/auth/one-time-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: first.oneTimeCode }),
    });
    expect(exchanged.status).toBe(200);
    expect(second.oneTimeCode).not.toBe(first.oneTimeCode);
  });

  it("비관리자는 터미널 화면 모드를 저장할 수 없다", async () => {
    const { database, config } = createTestContext();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'user')")
      .run("plain-user", await hashPassword("correct-password"));
    const baseUrl = await serveAuth(database, config, true);
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "plain-user", password: "correct-password" }),
    });
    const body = await login.json();
    const headers = {
      cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
      "x-csrf-token": body.csrfToken,
      "content-type": "application/json",
    };

    const terminal = await fetch(`${baseUrl}/api/auth/chat-view-mode`, { method: "PUT", headers, body: JSON.stringify({ chatViewMode: "terminal" }) });
    const chat = await fetch(`${baseUrl}/api/auth/chat-view-mode`, { method: "PUT", headers, body: JSON.stringify({ chatViewMode: "chat" }) });

    expect(terminal.status).toBe(403);
    expect(chat.status).toBe(200);
    expect((database.prepare("SELECT chat_view_mode FROM users WHERE username = 'plain-user'").get() as { chat_view_mode: string }).chat_view_mode).toBe("chat");
  });
});
