import { Router } from "express";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { createWebSession, logout, requireAdmin, requireAuth, requireCsrf, requireNonTemporarySession, setWebSessionCookie, verifyLoginCredentials, type AuthenticatedRequest } from "../core/auth";
import { loginRequestIdentifiers, writeAudit } from "../core/audit";
import { dummyPasswordHash, hashPassword, hashToken, verifyPassword } from "../core/security";
import { LoginRateLimiter } from "../core/login-rate-limit";
import { consumeOneTimeLoginCode, issueOneTimeLoginCode, OneTimeCodeLimitError, ONE_TIME_CODE_TTL_MINUTES, TEMPORARY_SESSION_TTL_MINUTES } from "../core/one-time-login";
import { MfaService } from "../core/mfa";

const AUTH_AUDIT_MAX_ROWS = 10_000;
const AUTH_AUDIT_RETENTION_DAYS = 30;
const SESSION_LIST_LIMIT = 100;

// 로그인 제한에 사용할 클라이언트 주소를 고정 길이 문자열로 정규화한다.
function loginClientAddress(request: AuthenticatedRequest): string {
  return String(loginRequestIdentifiers(request).ip);
}

// 실패한 로그인 시도를 민감 정보 없이 감사 로그에 남긴다.
function auditLoginFailure(database: AppDatabase, username: string, reason: "invalid" | "rate_limited", details?: Record<string, unknown>): void {
  writeAudit(database, null, reason === "rate_limited" ? "auth.login.rate_limited" : "auth.login.failed", "user", username, details);
}

// 로그인 성공·실패를 같은 기간만 보관하도록 정리 대상 액션을 한곳에 모은다.
const LOGIN_AUDIT_ACTIONS = [
  "auth.login",
  "auth.login.failed",
  "auth.login.rate_limited",
  "auth.login.mfa_pending",
  "auth.reauthenticate",
  "auth.reauthenticate.failed",
  "auth.reauthenticate.rate_limited",
  "auth.one_time_login",
  "auth.one_time_login.failed",
  "auth.one_time_login.rate_limited",
  "mobile.trust.session",
  "mobile.trust.session.rate_limited",
] as const;
// 실패가 폭주하면 최신 1만 행이 실패로만 채워져 성공 기록이 먼저 밀려난다. 침입 조사에서 정작
// 필요한 것은 "언제 누가 실제로 들어왔는가"이므로 성공과 실패에 각각 한도를 준다.
const LOGIN_AUDIT_SUCCESS_ACTIONS = ["auth.login", "auth.one_time_login", "auth.reauthenticate", "mobile.trust.session"] as const;
const LOGIN_AUDIT_FAILURE_ACTIONS = LOGIN_AUDIT_ACTIONS.filter(
  (action) => !LOGIN_AUDIT_SUCCESS_ACTIONS.includes(action as (typeof LOGIN_AUDIT_SUCCESS_ACTIONS)[number]),
);
const LOGIN_AUDIT_ACTION_PLACEHOLDERS = LOGIN_AUDIT_ACTIONS.map(() => "?").join(", ");

// 오래된 인증 실패 감사 행과 최대 보존 개수를 넘긴 행을 제거한다.
function pruneLoginAuditLogs(database: AppDatabase): void {
  database.prepare(`
    DELETE FROM audit_logs
    WHERE action IN (${LOGIN_AUDIT_ACTION_PLACEHOLDERS})
      AND created_at < datetime('now', ?)
  `).run(...LOGIN_AUDIT_ACTIONS, `-${AUTH_AUDIT_RETENTION_DAYS} days`);
  for (const actions of [LOGIN_AUDIT_SUCCESS_ACTIONS, LOGIN_AUDIT_FAILURE_ACTIONS]) {
    database.prepare(`
      DELETE FROM audit_logs WHERE id IN (
        SELECT id FROM audit_logs
        WHERE action IN (${actions.map(() => "?").join(", ")})
        ORDER BY id DESC LIMIT -1 OFFSET ?
      )
    `).run(...actions, AUTH_AUDIT_MAX_ROWS);
  }
}

// 로그인·로그아웃·현재 사용자 API를 구성한다.
export function createAuthRouter(database: AppDatabase, config: AppConfig): Router {
  const router = Router();
  const loginRateLimiter = new LoginRateLimiter(database);
  const mfa = new MfaService(database, config.dataDir);
  let auditWritesUntilPrune = 1;
  const maybePruneAuthAudits = (): void => {
    auditWritesUntilPrune -= 1;
    if (auditWritesUntilPrune > 0) return;
    pruneLoginAuditLogs(database);
    auditWritesUntilPrune = 100;
  };
  // 인증 실패를 기록하고 일정 건수마다 보존 기간과 최대 행 수를 적용한다.
  const recordLoginAudit = (username: string, reason: "invalid" | "rate_limited", details?: Record<string, unknown>): void => {
    auditLoginFailure(database, username, reason, details);
    maybePruneAuthAudits();
  };
  router.get("/setup-status", (_request, response) => {
    const count = (database.prepare("SELECT COUNT(*) AS count FROM users WHERE temporary_expires_at IS NULL").get() as { count: number }).count;
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
        const count = (database.prepare("SELECT COUNT(*) AS count FROM users WHERE temporary_expires_at IS NULL").get() as { count: number }).count;
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
        if (limit.shouldAudit) recordLoginAudit(rateLimitUsername, "rate_limited", { method: "password", retryAfterMs: limit.retryAfterMs, scope: limit.scope, ...loginRequestIdentifiers(request as AuthenticatedRequest) });
        response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
        return response.status(429).json({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
      }
      if (!validInput) {
        const failure = loginRateLimiter.recordFailure(clientAddress, rateLimitUsername);
        recordLoginAudit(rateLimitUsername, "invalid", { method: "password", reason: "invalid_format", ...failure, ...loginRequestIdentifiers(request as AuthenticatedRequest) });
        return response.status(400).json({ error: "로그인 정보 형식이 올바르지 않습니다." });
      }
      const user = await verifyLoginCredentials(database, username, password);
      if (!user) {
        const failure = loginRateLimiter.recordFailure(clientAddress, username);
        recordLoginAudit(username, "invalid", { method: "password", reason: "bad_credentials", ...failure, ...loginRequestIdentifiers(request as AuthenticatedRequest) });
        return response.status(401).json({ error: "로그인 정보가 올바르지 않습니다." });
      }
      loginRateLimiter.resetAccount(clientAddress, username);
      if (mfa.enabled(user.id)) {
        const challenge = mfa.createLoginChallenge(user.id);
        writeAudit(database, user.id, "auth.login.mfa_pending", "user", user.id, { method: "password", username: user.username, challengeExpiresAt: challenge.expiresAt, ...loginRequestIdentifiers(request as AuthenticatedRequest) });
        maybePruneAuthAudits();
        return response.status(202).json({ mfaRequired: true, challengeToken: challenge.token, challengeExpiresAt: challenge.expiresAt });
      }
      const result = createWebSession(database, config, user.id)!;
      setWebSessionCookie(response, config, result.token);
      writeAudit(database, result.user.id, "auth.login", "user", result.user.id, {
        method: "password",
        username: result.user.username,
        role: result.user.role,
        temporary: false,
        sessionExpiresAt: result.expiresAt,
        networkTrusted: !!(request as AuthenticatedRequest).trustedNetwork,
        ...loginRequestIdentifiers(request as AuthenticatedRequest),
      });
      maybePruneAuthAudits();
      response.json({ user: result.user, csrfToken: result.csrfToken, networkTrusted: !!(request as AuthenticatedRequest).trustedNetwork, temporary: false, sessionExpiresAt: result.expiresAt });
    } catch (error) {
      next(error);
    }
  });
  router.post("/login/mfa", async (request: AuthenticatedRequest, response, next) => {
    try {
      const challengeToken = typeof request.body?.challengeToken === "string" ? request.body.challengeToken : "";
      const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
      const clientAddress = loginClientAddress(request);
      const limiterKey = mfa.loginChallengeLimiterKey(challengeToken);
      const limit = loginRateLimiter.begin(clientAddress, limiterKey);
      if (!limit.allowed) {
        if (limit.shouldAudit) recordLoginAudit("<mfa>", "rate_limited", { method: "mfa", retryAfterMs: limit.retryAfterMs, scope: limit.scope, ...loginRequestIdentifiers(request) });
        response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
        return response.status(429).json({ error: "인증 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
      }
      const verified = mfa.consumeLoginChallenge(challengeToken, code);
      if (!verified) {
        const failure = loginRateLimiter.recordFailure(clientAddress, limiterKey);
        recordLoginAudit("<mfa>", "invalid", { method: "mfa", ...failure, ...loginRequestIdentifiers(request) });
        return response.status(401).json({ error: "인증 코드가 올바르지 않거나 만료되었습니다." });
      }
      loginRateLimiter.resetAccount(clientAddress, limiterKey);
      const result = createWebSession(database, config, verified.userId);
      if (!result) return response.status(401).json({ error: "로그인 계정을 사용할 수 없습니다." });
      setWebSessionCookie(response, config, result.token);
      writeAudit(database, result.user.id, "auth.login", "user", result.user.id, { method: verified.method, username: result.user.username, role: result.user.role, temporary: false, sessionExpiresAt: result.expiresAt, networkTrusted: !!request.trustedNetwork, ...loginRequestIdentifiers(request) });
      maybePruneAuthAudits();
      response.json({ user: result.user, csrfToken: result.csrfToken, networkTrusted: !!request.trustedNetwork, temporary: false, sessionExpiresAt: result.expiresAt });
    } catch (error) { next(error); }
  });
  // 정식 관리자만 일반 사용자 권한의 8자리 일회용 코드를 발급할 수 있다.
  router.post("/one-time-codes", requireAuth, requireCsrf, requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const issued = await issueOneTimeLoginCode(database, config, request.authUser!.id);
      writeAudit(database, request.authUser!.id, "auth.one_time_code.issue", "one_time_login_code", issued.id, {
        codeExpiresAt: issued.expiresAt,
        sessionTtlMinutes: TEMPORARY_SESSION_TTL_MINUTES,
      });
      response.status(201).json({
        oneTimeCode: issued.code,
        codeExpiresAt: issued.expiresAt,
        codeTtlMinutes: ONE_TIME_CODE_TTL_MINUTES,
        sessionTtlMinutes: TEMPORARY_SESSION_TTL_MINUTES,
      });
    } catch (error) {
      // 한도 초과는 서버 오류가 아니라 재시도 안내 대상이라 500 대신 429로 돌려준다.
      if (error instanceof OneTimeCodeLimitError) {
        // 가장 이른 코드가 만료되면 바로 자리가 나므로 그 시각까지만 기다리게 한다. 값을 못 읽었을
        // 때만 코드 수명 전체를 상한으로 쓴다.
        const earliest = error.earliestExpiresAt ? Date.parse(`${error.earliestExpiresAt.replace(" ", "T")}Z`) : Number.NaN;
        const retryAfterSeconds = Number.isFinite(earliest)
          ? Math.min(ONE_TIME_CODE_TTL_MINUTES * 60, Math.max(1, Math.ceil((earliest - Date.now()) / 1000)))
          : ONE_TIME_CODE_TTL_MINUTES * 60;
        response.setHeader("Retry-After", String(retryAfterSeconds));
        return response.status(429).json({ error: error.message });
      }
      next(error);
    }
  });
  // 공개 로그인 화면에서 코드를 한 번 소비하고 1시간짜리 비신뢰 일반 사용자 세션을 발급한다.
  router.post("/one-time-login", async (request: AuthenticatedRequest, response, next) => {
    try {
      const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
      const validInput = /^\d{8}$/.test(code);
      const clientAddress = loginClientAddress(request);
      const rateLimitKey = validInput ? `one-time:${hashToken(code)}` : "<invalid-one-time-code>";
      const limit = loginRateLimiter.begin(clientAddress, rateLimitKey);
      if (!limit.allowed) {
        if (limit.shouldAudit) {
          writeAudit(database, null, "auth.one_time_login.rate_limited", "one_time_login_code", null, { method: "one_time_code", retryAfterMs: limit.retryAfterMs, scope: limit.scope, ...loginRequestIdentifiers(request) });
          maybePruneAuthAudits();
        }
        response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
        return response.status(429).json({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
      }
      const result = validInput ? await consumeOneTimeLoginCode(database, config, code) : null;
      if (!result) {
        const failure = loginRateLimiter.recordFailure(clientAddress, rateLimitKey);
        writeAudit(database, null, "auth.one_time_login.failed", "one_time_login_code", null, { method: "one_time_code", reason: validInput ? "unknown_or_expired_code" : "invalid_format", validFormat: validInput, ...failure, ...loginRequestIdentifiers(request) });
        maybePruneAuthAudits();
        return response.status(401).json({ error: "일회용 코드가 올바르지 않거나 만료되었습니다." });
      }
      loginRateLimiter.resetAccount(clientAddress, rateLimitKey);
      setWebSessionCookie(response, config, result.token, TEMPORARY_SESSION_TTL_MINUTES);
      // 임시 사용자는 만료 후 행이 지워지고 audit_logs.user_id가 NULL이 되므로, 누구의 로그인이었는지
      // 남기려면 기록 시점에 username을 details에 박아야 한다.
      writeAudit(database, result.user.id, "auth.one_time_login", "one_time_login_code", result.codeId, {
        method: "one_time_code",
        issuedBy: result.issuedBy,
        sessionExpiresAt: result.expiresAt,
        username: result.user.username,
        role: result.user.role,
        temporary: true,
        networkTrusted: false,
        ...loginRequestIdentifiers(request),
      });
      maybePruneAuthAudits();
      response.json({ user: result.user, csrfToken: result.csrfToken, networkTrusted: false, temporary: true, sessionExpiresAt: result.expiresAt });
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
    response.json({
      user: request.authUser,
      csrfToken: request.authSession.csrfToken,
      networkTrusted: !!request.trustedNetwork,
      temporary: request.authSession.temporary,
      sessionExpiresAt: request.authSession.expiresAt,
    });
  });
  router.get("/sessions", requireAuth, (request: AuthenticatedRequest, response) => {
    const sessions = database.prepare(`SELECT s.id, s.mobile_trusted_device_id, s.network_access_allowed, s.created_at,
      COALESCE(s.last_seen_at, s.created_at) AS last_seen_at, s.expires_at, d.label AS device_label
      FROM web_sessions s LEFT JOIN mobile_trusted_devices d ON d.id = s.mobile_trusted_device_id
      WHERE s.user_id = ? AND s.expires_at > datetime('now')
      ORDER BY CASE WHEN s.id = ? THEN 0 ELSE 1 END, COALESCE(s.last_seen_at, s.created_at) DESC, s.id DESC
      LIMIT ?`).all(request.authUser!.id, request.authSession!.id, SESSION_LIST_LIMIT + 1) as Array<Record<string, unknown>>;
    response.json({ sessions: sessions.slice(0, SESSION_LIST_LIMIT).map((session) => ({
      id: session.id, current: session.id === request.authSession?.id, mobileTrusted: session.mobile_trusted_device_id !== null,
      deviceLabel: session.device_label, networkAccessAllowed: session.network_access_allowed === 1,
      createdAt: session.created_at, lastSeenAt: session.last_seen_at, expiresAt: session.expires_at,
    })), hasMore: sessions.length > SESSION_LIST_LIMIT });
  });
  router.get("/mfa", requireAuth, (request: AuthenticatedRequest, response) => response.json(mfa.status(request.authUser!.id)));
  router.post("/reauth", requireAuth, requireCsrf, requireNonTemporarySession, async (request: AuthenticatedRequest, response, next) => {
    try {
      const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
      const code = typeof request.body?.code === "string" ? request.body.code : "";
      const clientAddress = loginClientAddress(request);
      const limiterKey = `reauth-user:${request.authUser!.id}`;
      const limit = loginRateLimiter.begin(clientAddress, limiterKey);
      if (!limit.allowed) {
        if (limit.shouldAudit) writeAudit(database, request.authUser!.id, "auth.reauthenticate.rate_limited", "web_session", request.authSession!.id, { retryAfterMs: limit.retryAfterMs, scope: limit.scope, ...loginRequestIdentifiers(request) });
        response.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
        return response.status(429).json({ error: "본인 확인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요." });
      }
      const user = await verifyLoginCredentials(database, request.authUser!.username, currentPassword);
      let method: "password" | "totp" | "recovery" = "password";
      if (user && mfa.enabled(user.id)) method = mfa.consumeUserCode(user.id, code) ?? method;
      const valid = !!user && (!mfa.enabled(request.authUser!.id) || method !== "password");
      if (!valid) {
        const failure = loginRateLimiter.recordFailure(clientAddress, limiterKey);
        writeAudit(database, request.authUser!.id, "auth.reauthenticate.failed", "web_session", request.authSession!.id, { ...failure, ...loginRequestIdentifiers(request) });
        return response.status(401).json({ error: "비밀번호 또는 인증 코드가 올바르지 않습니다." });
      }
      loginRateLimiter.resetAccount(clientAddress, limiterKey);
      database.prepare("UPDATE web_sessions SET reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ?").run(request.authSession!.id);
      const windowMinutes = config.reauthenticationWindowMinutes ?? 15;
      const timing = database.prepare("SELECT CURRENT_TIMESTAMP AS reauthenticated_at, datetime('now', ?) AS valid_until").get(`+${windowMinutes} minutes`) as { reauthenticated_at: string; valid_until: string };
      writeAudit(database, request.authUser!.id, "auth.reauthenticate", "web_session", request.authSession!.id, { method, validUntil: timing.valid_until });
      response.json({ reauthenticatedAt: timing.reauthenticated_at, validUntil: timing.valid_until });
    } catch (error) { next(error); }
  });
  router.post("/mfa/setup", requireAuth, requireCsrf, requireNonTemporarySession, async (request: AuthenticatedRequest, response, next) => {
    try {
      const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
      const user = await verifyLoginCredentials(database, request.authUser!.username, currentPassword);
      if (!user) return response.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
      const setup = mfa.beginSetup(user.id, user.username);
      writeAudit(database, user.id, "auth.mfa.setup_started", "user", user.id, { expiresInMinutes: setup.expiresInMinutes });
      response.json(setup);
    } catch (error) { next(error); }
  });
  router.post("/mfa/confirm", requireAuth, requireCsrf, requireNonTemporarySession, (request: AuthenticatedRequest, response) => {
    const code = typeof request.body?.code === "string" ? request.body.code : "";
    const recoveryCodes = mfa.confirmSetup(request.authUser!.id, code);
    if (!recoveryCodes) return response.status(401).json({ error: "인증 코드가 올바르지 않거나 등록 시간이 만료되었습니다." });
    writeAudit(database, request.authUser!.id, "auth.mfa.enabled", "user", request.authUser!.id, { recoveryCodeCount: recoveryCodes.length });
    response.json({ enabled: true, recoveryCodes });
  });
  router.post("/mfa/disable", requireAuth, requireCsrf, requireNonTemporarySession, async (request: AuthenticatedRequest, response, next) => {
    try {
      const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
      const code = typeof request.body?.code === "string" ? request.body.code : "";
      if (!await verifyLoginCredentials(database, request.authUser!.username, currentPassword)) return response.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
      const method = mfa.consumeUserCode(request.authUser!.id, code);
      if (!method) return response.status(401).json({ error: "인증 코드가 올바르지 않습니다." });
      const revokedCount = database.transaction(() => {
        mfa.disable(request.authUser!.id);
        return database.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(request.authUser!.id).changes;
      })();
      writeAudit(database, request.authUser!.id, "auth.mfa.disabled", "user", request.authUser!.id, { method, revokedCount });
      response.clearCookie("web_agent_manager_session", { path: "/" }); response.clearCookie("myagent_session", { path: "/" });
      response.json({ enabled: false, revokedCount, loginRequired: true });
    } catch (error) { next(error); }
  });
  router.post("/sessions/revoke-others", requireAuth, requireCsrf, requireNonTemporarySession, (request: AuthenticatedRequest, response) => {
    const result = database.prepare("DELETE FROM web_sessions WHERE user_id = ? AND id <> ?").run(request.authUser!.id, request.authSession!.id);
    writeAudit(database, request.authUser!.id, "auth.sessions.revoke_others", "user", request.authUser!.id, { revokedCount: result.changes });
    response.json({ revokedCount: result.changes });
  });
  router.post("/password", requireAuth, requireCsrf, requireNonTemporarySession, async (request: AuthenticatedRequest, response, next) => {
    try {
      const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
      const newPassword = typeof request.body?.newPassword === "string" ? request.body.newPassword : "";
      if (newPassword.length < 12 || newPassword.length > 256) throw new Error("새 비밀번호는 12~256자여야 합니다.");
      const row = database.prepare("SELECT password_hash FROM users WHERE id = ? AND temporary_expires_at IS NULL").get(request.authUser!.id) as { password_hash: string } | undefined;
      if (!await verifyPassword(currentPassword, row?.password_hash ?? dummyPasswordHash()) || !row) return response.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
      const passwordHash = await hashPassword(newPassword);
      const revokedCount = database.transaction(() => {
        database.prepare("UPDATE users SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?").run(passwordHash, request.authUser!.id);
        return database.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(request.authUser!.id).changes;
      })();
      writeAudit(database, request.authUser!.id, "auth.password.change", "user", request.authUser!.id, { revokedCount });
      response.clearCookie("web_agent_manager_session", { path: "/" });
      response.clearCookie("myagent_session", { path: "/" });
      response.json({ changed: true, revokedCount, loginRequired: true });
    } catch (error) { next(error); }
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
      // 터미널 구독은 WebSocket에서 관리자만 통과하므로, 비관리자에게 저장을 허용하면 화면에
      // 그려지지도 않는 값만 DB에 남는다. 권한 경계는 그대로 WebSocket 쪽이 담당한다.
      if (chatViewMode === "terminal" && request.authUser!.role !== "admin") {
        return response.status(403).json({ error: "터미널 모드는 관리자만 사용할 수 있습니다." });
      }
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
