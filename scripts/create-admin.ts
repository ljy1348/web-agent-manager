import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { hashPassword } from "../src/server/core/security";

// 환경변수로 전달된 관리자 계정을 생성하거나 비밀번호를 갱신한다.
async function main(): Promise<void> {
  const username = (process.env.WEB_AGENT_MANAGER_ADMIN_USERNAME ?? process.env.MYAGENT_ADMIN_USERNAME)?.trim();
  const password = process.env.WEB_AGENT_MANAGER_ADMIN_PASSWORD ?? process.env.MYAGENT_ADMIN_PASSWORD;
  if (!username || !password || password.length < 12) {
    throw new Error("WEB_AGENT_MANAGER_ADMIN_USERNAME과 12자 이상의 WEB_AGENT_MANAGER_ADMIN_PASSWORD를 설정해야 합니다.");
  }
  const database = openDatabase(loadConfig());
  const passwordHash = await hashPassword(password);
  database.prepare(`
    INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin'
  `).run(username, passwordHash);
  database.close();
  process.stdout.write("관리자 계정을 저장했습니다.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "관리자 생성 실패"}\n`);
  process.exitCode = 1;
});
