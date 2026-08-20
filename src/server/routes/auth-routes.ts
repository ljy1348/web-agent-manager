import { Router } from "express";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { login, logout, requireAuth, requireCsrf, setWebSessionCookie, type AuthenticatedRequest } from "../core/auth";
import { writeAudit } from "../core/audit";
import { hashPassword } from "../core/security";
import { LoginRateLimiter } from "../core/login-rate-limit";

const AUTH_AUDIT_MAX_ROWS = 10_000;
const AUTH_AUDIT_RETENTION_DAYS = 30;

// 로그인 제한에 사용할 클라이언트 주소를 고정 길이 문자열로 정규화한다.
function loginClientAddress(request: AuthenticatedRequest): string {
  return (request.ip || request.socket.remoteAddress || "unknown").slice(0, 128);
}

// 실패한 로그인 시도를 민감 정보 없이 감사 로그에 남긴다.
function auditLoginFailure(database: AppDatabase, username: string, reason: "invalid" | "rate_limited", details?: Record<string, unknown>): void {
  writeAudit(database, null, reason === "rate_limited" ? "auth.login.rate_limited" : "auth.login.failed", "user", username, details);
}

// 오래된 인증 실패 감사 행과 최대 보존 개수를 넘긴 행을 제거한다.
function pruneLoginAuditLogs(database: AppDatabase): void {
  database.prepare(`
    DELETE FROM audit_logs
    WHERE action IN ('auth.login.failed', 'auth.login.rate_limited')
      AND created_at < datetime('now', ?)
  `).run(`-${AUTH_AUDIT_RETENTION_DAYS} days`);
  database.prepare(`
    DELETE FROM audit_logs WHERE id IN (
      SELECT id FROM audit_logs
      WHERE action IN ('auth.login.failed', 'auth.login.rate_limited')
      ORDER BY id DESC LIMIT -1 OFFSET ?
    )
  `).run(AUTH_AUDIT_MAX_ROWS);
}

// 로그인·로그아웃·현재 사용자 API를 구성한다.
export function createAuthRouter(database: AppDatabase, config: AppConfig): Router {
  const router = Router();
  const loginRateLimiter = new LoginRateLimiter();
  let auditWritesUntilPrune = 1;
  // 인증 실패를 기록하고 일정 건수마다 보존 기간과 최대 행 수를 적용한다.
  const recordLoginAudit = (username: string, reason: "invalid" | "rate_limited", details?: Record<string, unknown>): void => {
    auditLoginFailure(database, username, reason, details);
    auditWritesUntilPrune -= 1;
    if (auditWritesUntilPrune > 0) return;
    pruneLoginAuditLogs(database);
    auditWritesUntilPrune = 100;
  };
  router.get("/setup-status", (_request, response) => {
    const count = (database.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    response.json({ setupRequired: count === 0 });
  });
  // 사용자가 한 명도 없을 때 신뢰 네트워크에서만 첫 관리자 계정을 생성한다.
  router.post("/setup", async (request: AuthenticatedRequest, response, next) => {
    try {
      if (!request.trustedNetwork) return response.status(403).json({ error: "초기 설정은 내부망에서만 가능합니다." });
      const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      if (!/^[^\s\x00-\x1f]{2,64}$/.test(username)) throw new Error("관리자 아이디는 공백 없이 2~64자여야 합니다.");
      if (password.length < 12 || password.length > 256) throw new Error("비밀번호는 12~256자여야 합니다.");
      const passwordHash = await hashPassword(password);
      const result = database.transaction(() => {
        const count = (database.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
        if (count !== 0) return null;
        return database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')").run(username, passwordHash);
      })();
      if (!result) return response.status(409).json({ error: "초기 설정이 이미 완료되었습니다." });
      writeAudit(database, Number(result.lastInsertRowid), "auth.setup", "user", Number(result.lastInsertRowid));
      response.status(201).json({ created: true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/login", async (request, response, next) => {
    try {
      const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      const validInput = /^[^\s\x00-\x1f]{2,64}$/.test(username) && password.length >= 1 && password.length <= 256;
      const rateLimitUsername = validInput ? username : "<invalid>";
      const clientAddress = loginClientAddress(request as AuthenticatedRequest);
      const limit = loginRateLimiter.begin(clientAddress, rateLimitUsername);
      if (!limit.allowed) {
        if (limit.shouldAudit) recordLoginAudit(rateLimitUsername, "rate_limited", { retryAfterMs: limit.retryAfterMs, scope: limit.scope });
        response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
        return response.status(429).json({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
      }
      if (!validInput) {
        const failure = loginRateLimiter.recordFailure(clientAddress, rateLimitUsername);
        recordLoginAudit(rateLimitUsername, "invalid", failure);
        return response.status(400).json({ error: "로그인 정보 형식이 올바르지 않습니다." });
      }
      const result = await login(database, config, username, password);
      if (!result) {
        const failure = loginRateLimiter.recordFailure(clientAddress, username);
        recordLoginAudit(username, "invalid", failure);
        return response.status(401).json({ error: "로그인 정보가 올바르지 않습니다." });
      }
      loginRateLimiter.resetAccount(clientAddress, username);
      setWebSessionCookie(response, config, result.token);
      writeAudit(database, result.user.id, "auth.login", "user", result.user.id);
      response.json({ user: result.user, csrfToken: result.csrfToken, networkTrusted: !!(request as AuthenticatedRequest).trustedNetwork });
    } catch (error) {
      next(error);
    }
  });
  router.post("/logout", requireAuth, requireCsrf, (request: AuthenticatedRequest, response) => {
    logout(database, request);
    response.clearCookie("web_agent_manager_session", { path: "/" });
    response.clearCookie("myagent_session", { path: "/" });
    response.status(204).end();
  });
  router.get("/me", (request: AuthenticatedRequest, response) => {
    if (!request.authUser || !request.authSession) return response.status(401).json({ error: "로그인이 필요합니다." });
    response.json({ user: request.authUser, csrfToken: request.authSession.csrfToken, networkTrusted: !!request.trustedNetwork });
  });
  router.post("/last-session", requireAuth, requireCsrf, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.body?.projectId);
      const chatId = Number(request.body?.chatId);
      const validProjectId = Number.isInteger(projectId) && projectId > 0 ? projectId : null;
      const validChatId = Number.isInteger(chatId) && chatId > 0 ? chatId : null;
      if (validProjectId) {
        const project = database.prepare("SELECT id FROM projects WHERE id = ? AND active = 1").get(validProjectId);
        if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
      }
      if (validChatId) {
        const chat = database.prepare("SELECT project_id FROM chats WHERE id = ?").get(validChatId) as { project_id: number } | undefined;
        if (!chat) throw new Error("채팅을 찾을 수 없습니다.");
        if (validProjectId && chat.project_id !== validProjectId) throw new Error("채팅이 선택한 프로젝트에 속하지 않습니다.");
      }
      const finalProjectId = validProjectId ?? (validChatId ? (database.prepare("SELECT project_id FROM chats WHERE id = ?").get(validChatId) as { project_id: number }).project_id : null);
      database.prepare("UPDATE users SET last_project_id = ?, last_chat_id = ? WHERE id = ?").run(finalProjectId, validChatId, request.authUser!.id);
      console.debug("[web-agent-manager:chat:server]", "last-session:update", { at: new Date().toISOString(), userId: request.authUser!.id, projectId: finalProjectId, chatId: validChatId });
      response.json({ lastProjectId: finalProjectId, lastChatId: validChatId });
    } catch (error) {
      next(error);
    }
  });
  // 현재 웹 계정의 채팅 화면 기본 모드를 저장한다.
  router.put("/chat-view-mode", requireAuth, requireCsrf, (request: AuthenticatedRequest, response, next) => {
    try {
      const chatViewMode = request.body?.chatViewMode;
      if (chatViewMode !== "chat" && chatViewMode !== "terminal") return response.status(400).json({ error: "채팅 화면 모드가 올바르지 않습니다." });
      database.prepare("UPDATE users SET chat_view_mode = ? WHERE id = ?").run(chatViewMode, request.authUser!.id);
      request.authUser!.chat_view_mode = chatViewMode;
      writeAudit(database, request.authUser!.id, "user.chat_view_mode.update", "user", request.authUser!.id, { chatViewMode });
      response.json({ chatViewMode });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
