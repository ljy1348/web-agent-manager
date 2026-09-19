import type { IncomingMessage } from "node:http";
import type { AppDatabase } from "./database";

// 감사 본문에 넣을 헤더 값을 길이 제한과 함께 읽는다. 배열로 오는 중복 헤더는 첫 값만 쓴다.
function headerValue(request: IncomingMessage, name: string, limit = 256): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value ? value.slice(0, limit) : undefined;
}

// 로그인 요청을 나중에 추적할 수 있게 식별자를 모은다(성공·실패 모두 같은 항목을 남긴다).
// 비밀번호·세션 토큰·CSRF 토큰·일회용 코드 원문과 Cookie·Authorization 헤더는 절대 넣지 않는다.
export function loginRequestIdentifiers(request: IncomingMessage & { ip?: string }): Record<string, unknown> {
  const identifiers: Record<string, unknown> = {
    ip: (request.ip || request.socket?.remoteAddress || "unknown").slice(0, 128),
    forwardedFor: headerValue(request, "x-forwarded-for"),
    realIp: headerValue(request, "x-real-ip", 128),
    userAgent: headerValue(request, "user-agent", 512),
    origin: headerValue(request, "origin"),
    referer: headerValue(request, "referer"),
    acceptLanguage: headerValue(request, "accept-language", 128),
  };
  // 값이 없는 항목은 빼서 기록을 읽기 쉽게 유지한다.
  for (const key of Object.keys(identifiers)) if (identifiers[key] === undefined) delete identifiers[key];
  return identifiers;
}

// 감사 이벤트를 민감 정보 없이 데이터베이스에 기록한다.
export function writeAudit(
  database: AppDatabase,
  userId: number | null,
  action: string,
  targetType: string,
  targetId: string | number | null,
  details?: Record<string, unknown>,
): void {
  database.prepare(`
    INSERT INTO audit_logs(user_id, action, target_type, target_id, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, action, targetType, targetId === null ? null : String(targetId), details ? JSON.stringify(details) : null);
}
