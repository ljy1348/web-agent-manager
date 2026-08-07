import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config";
import type { AppDatabase } from "./database";
import { createToken, dummyPasswordHash, hashToken, parseCookies, verifyPassword } from "./security";
import type { AuthUser } from "../../shared/types";

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
  authSession?: { id: number; csrfToken: string };
  trustedNetwork?: boolean;
}

// 요청 Cookie의 세션 토큰을 검증해 사용자 정보를 주입한다.
export function createSessionLoader(database: AppDatabase) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction): void => {
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.web_agent_manager_session ?? cookies.myagent_session;
    if (!token) return next();
    const row = database.prepare(`
      SELECT s.id AS session_id, s.csrf_token, u.id, u.username, u.role, u.last_project_id, u.last_chat_id, u.chat_view_mode
      FROM web_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(hashToken(token)) as {
      session_id: number;
      csrf_token: string;
      id: number;
      username: string;
      role: "admin" | "user";
      last_project_id: number | null;
      last_chat_id: number | null;
      chat_view_mode: "chat" | "terminal";
    } | undefined;
    if (row) {
      request.authUser = { id: row.id, username: row.username, role: row.role, last_project_id: row.last_project_id, last_chat_id: row.last_chat_id, chat_view_mode: row.chat_view_mode };
      request.authSession = { id: row.session_id, csrfToken: row.csrf_token };
    }
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

// 변경 요청의 CSRF 토큰이 로그인 세션과 일치하는지 확인한다.
export function requireCsrf(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  if (!request.authSession || request.headers["x-csrf-token"] !== request.authSession.csrfToken) {
    response.status(403).json({ error: "CSRF 검증에 실패했습니다." });
    return;
  }
  next();
}

// 사용자 자격 증명을 검증하고 새 웹 세션을 생성한다.
export async function login(
  database: AppDatabase,
  config: AppConfig,
  username: string,
  password: string,
): Promise<{ user: AuthUser; token: string; csrfToken: string } | null> {
  const row = database.prepare("SELECT id, username, role, password_hash, last_project_id, last_chat_id, chat_view_mode FROM users WHERE username = ?").get(username) as {
    id: number;
    username: string;
    role: "admin" | "user";
    password_hash: string;
    last_project_id: number | null;
    last_chat_id: number | null;
    chat_view_mode: "chat" | "terminal";
  } | undefined;
  const passwordMatches = await verifyPassword(password, row?.password_hash ?? dummyPasswordHash());
  if (!row || !passwordMatches) return null;
  const token = createToken();
  const csrfToken = createToken(24);
  database.prepare(`
    INSERT INTO web_sessions(user_id, token_hash, csrf_token, expires_at)
    VALUES (?, ?, ?, datetime('now', ?))
  `).run(row.id, hashToken(token), csrfToken, `+${config.sessionTtlHours} hours`);
  return { user: { id: row.id, username: row.username, role: row.role, last_project_id: row.last_project_id, last_chat_id: row.last_chat_id, chat_view_mode: row.chat_view_mode }, token, csrfToken };
}

// 현재 웹 세션을 데이터베이스에서 제거한다.
export function logout(database: AppDatabase, request: AuthenticatedRequest): void {
  if (request.authSession) database.prepare("DELETE FROM web_sessions WHERE id = ?").run(request.authSession.id);
}
