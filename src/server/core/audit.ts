import type { AppDatabase } from "./database";

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
