import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config";
import type { AppDatabase } from "./database";
import { createToken, dummyPasswordHash, hashToken, parseCookies, verifyPassword } from "./security";
import type { AuthUser } from "../../shared/types";

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
  authSession?: { id: number; csrfToken: string; expiresAt: string; temporary: boolean; reauthenticatedAt?: string | null };
  networkOriginTrusted?: boolean;
  appTrusted?: boolean;
  trustedNetwork?: boolean;
}

// 요청 Cookie의 세션 토큰을 검증해 사용자 정보를 주입한다.
export function createSessionLoader(database: AppDatabase, idleMinutes = 720) {
  const touchIntervalMinutes = Math.max(0.5, Math.min(5, idleMinutes / 2));
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction): void => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.web_agent_manager_session ?? cookies.myagent_session;
    if (!token) return next();
    const row = database.prepare(`
      SELECT s.id AS session_id, s.csrf_token, s.mobile_trusted_device_id, s.network_access_allowed,
        s.expires_at, s.reauthenticated_at, d.active AS mobile_device_active, u.temporary_expires_at,
        u.id, u.username, u.role, u.access_scope, u.last_project_id, u.last_chat_id, u.chat_view_mode
      FROM web_sessions s JOIN users u ON u.id = s.user_id
      LEFT JOIN mobile_trusted_devices d
        ON d.id = s.mobile_trusted_device_id AND d.user_id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
        AND COALESCE(s.last_seen_at, s.created_at) > datetime('now', ?)
        AND (u.temporary_expires_at IS NULL OR u.temporary_expires_at > datetime('now'))
    `).get(hashToken(token), `-${idleMinutes} minutes`) as {
      session_id: number;
      csrf_token: string;
      mobile_trusted_device_id: string | null;
      network_access_allowed: number;
      expires_at: string;
      reauthenticated_at: string | null;
      mobile_device_active: number | null;
      temporary_expires_at: string | null;
      id: number;
      username: string;
      role: "admin" | "user";
      access_scope: "standard" | "test_only";
      last_project_id: number | null;
      last_chat_id: number | null;
      chat_view_mode: "chat" | "terminal";
    } | undefined;
    if (row) {
      request.authUser = { id: row.id, username: row.username, role: row.role, access_scope: row.access_scope, last_project_id: row.last_project_id, last_chat_id: row.last_chat_id, chat_view_mode: row.chat_view_mode };
      request.authSession = { id: row.session_id, csrfToken: row.csrf_token, expiresAt: row.expires_at, temporary: row.temporary_expires_at !== null, reauthenticatedAt: row.reauthenticated_at };
      request.appTrusted = Boolean(row.network_access_allowed === 1 && row.mobile_trusted_device_id && row.mobile_device_active === 1);
      if (row.network_access_allowed !== 1) request.trustedNetwork = false;
      else if (request.appTrusted) request.trustedNetwork = true;
      database.prepare("UPDATE web_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', ?))").run(row.session_id, `-${touchIntervalMinutes} minutes`);
    } else database.prepare("DELETE FROM web_sessions WHERE token_hash = ? AND (expires_at <= datetime('now') OR COALESCE(last_seen_at, created_at) <= datetime('now', ?))").run(hashToken(token), `-${idleMinutes} minutes`);
    next();
  };
}

// 인증되지 않은 HTTP 요청을 거부한다.
export function requireAuth(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (!request.authUser) {
    response.status(401).json({ error: "로그인이 필요합니다." });
    return;
  }
  next();
}

// 관리자 역할이 아닌 요청을 거부한다.
export function requireAdmin(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (request.authUser?.role !== "admin") {
    response.status(403).json({ error: "관리자만 접근할 수 있습니다." });
    return;
  }
  next();
}

// 운영 관리자 또는 별도 test_only 자격증명만 안전한 테스트 API를 실행할 수 있다.
// 각 라우트는 이 가드를 붙여도 실제 운영 변경(업데이트, live 승인 등)과 분리돼 있어야 한다.
export function requireTestOperator(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (request.authUser?.role !== "admin" && request.authUser?.access_scope !== "test_only") {
    response.status(403).json({ error: "테스트 실행 권한이 필요합니다." });
    return;
  }
  next();
}

const TEST_ONLY_MUTATION_PATHS = [
  /^\/providers\/(?:codex|claude|grok)\/canaries$/,
  /^\/tasks\/[^/]+\/verifications$/,
  /^\/verifications\/[^/]+\/rerun$/,
];

// tester는 읽기 화면을 사용할 수 있지만 상태를 바꾸는 API는 명시된 테스트 실행만 허용한다.
// auth login/logout/navigation은 /api/auth 라우터가 이 middleware보다 앞에서 자체 가드를 적용한다.
export function restrictTestOnlyMutations(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (request.authUser?.access_scope !== "test_only" || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  if (request.method === "POST" && TEST_ONLY_MUTATION_PATHS.some((pattern) => pattern.test(request.path))) return next();
  response.status(403).json({ error: "테스트 전용 계정은 테스트 기능만 실행할 수 있습니다." });
}

// 일회용 코드로 만든 임시 세션의 변경 작업을 막는다(조회는 그대로 허용).
// 임시 세션은 role이 'user'라 requireAdmin에도, 일반 사용자용 가드에도 걸리지 않는다. 8자리(약
// 26.6비트) 코드로 발급되는 손님 세션이 실행 중인 CLI나 서버 동작을 건드리지 못하게 한다.
export function requireNonTemporarySession(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (request.authSession?.temporary) {
    response.status(403).json({ error: "임시 로그인 세션에서는 변경할 수 없습니다." });
    return;
  }
  next();
}

// 변경 요청의 CSRF 토큰이 로그인 세션과 일치하는지 확인한다.
export function requireCsrf(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  if (!request.authSession || request.headers["x-csrf-token"] !== request.authSession.csrfToken) {
    response.status(403).json({ error: "CSRF 검증에 실패했습니다." });
    return;
  }
  next();
}

export function createRecentReauthenticationGuard(database: AppDatabase, windowMinutes = 15) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    if (!request.authSession) {
      response.status(401).json({ error: "로그인이 필요합니다." });
      return;
    }
    const recent = database.prepare("SELECT 1 FROM web_sessions WHERE id = ? AND reauthenticated_at > datetime('now', ?)").get(request.authSession.id, `-${windowMinutes} minutes`);
    if (!recent) {
      response.status(403).json({ error: "중요 작업 전에 설정에서 본인 확인을 다시 해주세요.", reauthRequired: true });
      return;
    }
    next();
  };
}

export function requiresRecentReauthentication(method: string, requestPath: string): boolean {
  if (method === "GET" && /^\/admin\/full-backups\/[^/]+\/download$/.test(requestPath)) return true;
  if (method === "DELETE") return true;
  if (!["POST", "PUT", "PATCH"].includes(method)) return false;
  return [
    /^\/providers\/(?:codex|claude|grok)\/(?:update|rollouts(?:\/[^/]+\/(?:halt|promote))?)$/,
    /^\/providers\/(?:codex|claude|grok)\/updates\/[^/]+\/rollback$/,
    /^\/system\/processes\/\d+\/kill$/,
    /^\/agent-accounts(?:\/|$)/,
    /^\/cli-auth\//,
    /^\/tools\/mcp(?:\/|$)/,
    /^\/agent-integrations\//,
    /^\/admin\/full-backups(?:\/|$)/,
    /^\/tasks\/[^/]+\/routing\/apply$/,
    /^\/task-board\/(?:limits|queue\/reconcile)(?:\/|$)/,
    /^\/projects\/\d+\/preview-target$/,
    /^\/projects\/\d+\/profiles(?:\/[^/]+\/(?:versions|activate))?$/,
    /^\/tasks\/[^/]+\/preview-captures$/,
    /^\/tasks\/[^/]+\/visual-(?:baseline|checks)$/,
    /^\/remote-workers(?:\/|$)/,
    /^\/projects\/\d+\/remote-worker-mapping$/,
    /^\/tasks\/[^/]+\/remote-dispatches(?:\/[^/]+\/refresh)?$/,
    /^\/admin\/webhook-settings$/,
    /^\/webhook\/test$/,
    /^\/projects\/\d+\/git\/hunks\/decision$/,
    /^\/projects\/\d+\/git\/(?:discard|push)$/,
    /^\/projects\/\d+\/github\/pr\/\d+\/(?:close|merge|auto-merge)$/,
  ].some((pattern) => pattern.test(requestPath));
}

// 확인된 사용자와 선택적 앱 기기를 묶어 만료 가능한 웹 세션을 생성한다.
export function createWebSession(
  database: AppDatabase,
  config: AppConfig,
  userId: number,
  mobileTrustedDeviceId: string | null = null,
  options: { ttlMinutes?: number; networkAccessAllowed?: boolean; reauthenticated?: boolean } = {},
): { user: AuthUser; token: string; csrfToken: string; expiresAt: string } | null {
  const row = database.prepare(`
    SELECT id, username, role, access_scope, last_project_id, last_chat_id, chat_view_mode FROM users
    WHERE id = ? AND (temporary_expires_at IS NULL OR temporary_expires_at > datetime('now'))
  `).get(userId) as AuthUser | undefined;
  if (!row) return null;
  const token = createToken();
  const csrfToken = createToken(24);
  const ttlModifier = options.ttlMinutes === undefined ? `+${config.sessionTtlHours} hours` : `+${options.ttlMinutes} minutes`;
  const created = database.prepare(`
    INSERT INTO web_sessions(user_id, token_hash, csrf_token, mobile_trusted_device_id, network_access_allowed, expires_at, reauthenticated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?), CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)
    RETURNING expires_at
  `).get(row.id, hashToken(token), csrfToken, mobileTrustedDeviceId, options.networkAccessAllowed === false ? 0 : 1, ttlModifier, options.reauthenticated === false ? 0 : 1) as { expires_at: string };
  return { user: row, token, csrfToken, expiresAt: created.expires_at };
}

// 비밀번호·기기 서명 로그인에 동일한 HttpOnly 웹 세션 쿠키 정책을 적용한다.
export function setWebSessionCookie(response: Response, config: AppConfig, token: string, ttlMinutes = config.sessionTtlHours * 60): void {
  response.cookie("web_agent_manager_session", token, {
    httpOnly: true,
    secure: config.publicUrl.startsWith("https://"),
    sameSite: "strict",
    path: "/",
    maxAge: ttlMinutes * 60 * 1000,
  });
}

// 사용자 자격 증명을 검증하고 새 웹 세션을 생성한다.
export async function login(
  database: AppDatabase,
  config: AppConfig,
  username: string,
  password: string,
): Promise<{ user: AuthUser; token: string; csrfToken: string; expiresAt: string } | null> {
  const user = await verifyLoginCredentials(database, username, password);
  return user ? createWebSession(database, config, user.id) : null;
}

// MFA 계정은 비밀번호 확인과 웹 세션 생성을 분리해야 두 번째 단계 전에 cookie가 생기지 않는다.
export async function verifyLoginCredentials(database: AppDatabase, username: string, password: string): Promise<AuthUser | null> {
  const row = database.prepare("SELECT id, password_hash FROM users WHERE username = ? AND temporary_expires_at IS NULL").get(username) as { id: number; password_hash: string } | undefined;
  const passwordMatches = await verifyPassword(password, row?.password_hash ?? dummyPasswordHash());
  if (!row || !passwordMatches) return null;
  return database.prepare("SELECT id, username, role, access_scope, last_project_id, last_chat_id, chat_view_mode FROM users WHERE id = ?").get(row.id) as AuthUser;
}

// 현재 웹 세션을 데이터베이스에서 제거한다.
export function logout(database: AppDatabase, request: AuthenticatedRequest): void {
  if (request.authSession) database.prepare("DELETE FROM web_sessions WHERE id = ?").run(request.authSession.id);
}
