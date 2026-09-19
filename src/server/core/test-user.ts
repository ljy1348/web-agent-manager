import type { AppDatabase } from "./database";
import { hashPassword } from "./security";
import type { AuthUser } from "../../shared/types";

// 호스트 관리자 CLI가 호출하는 테스트 계정 생성 핵심. 기존 standard/admin/임시 계정을
// 조용히 강등하거나 용도 변경하지 않고 이미 test_only인 계정의 비밀번호만 갱신한다.
export async function upsertTestOnlyUser(database: AppDatabase, usernameInput: string, password: string): Promise<AuthUser> {
  const username = usernameInput.trim();
  if (!/^[^\s\x00-\x1f]{2,64}$/.test(username)) throw new Error("테스트 계정 아이디는 공백 없이 2~64자여야 합니다.");
  if (password.length < 12 || password.length > 256) throw new Error("테스트 계정 비밀번호는 12~256자여야 합니다.");
  const existing = database.prepare("SELECT id, role, access_scope, temporary_expires_at FROM users WHERE username = ?").get(username) as {
    id: number;
    role: string;
    access_scope: string;
    temporary_expires_at: string | null;
  } | undefined;
  if (existing && (existing.role !== "user" || existing.access_scope !== "test_only" || existing.temporary_expires_at !== null)) {
    throw new Error("기존 관리자·일반·임시 계정은 테스트 전용 계정으로 변경할 수 없습니다.");
  }
  const passwordHash = await hashPassword(password);
  database.prepare(`
    INSERT INTO users(username, password_hash, role, access_scope) VALUES (?, ?, 'user', 'test_only')
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash
  `).run(username, passwordHash);
  return database.prepare("SELECT id, username, role, access_scope FROM users WHERE username = ?").get(username) as AuthUser;
}
