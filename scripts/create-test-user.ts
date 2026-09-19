import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../src/server/core/config";
import type { AppDatabase } from "../src/server/core/database";
import { readSecretInput } from "../src/server/core/secret-input";
import { upsertTestOnlyUser } from "../src/server/core/test-user";

// 테스트 전용 계정은 일반 user 역할에 별도 scope를 붙인다. 관리자 권한을 공유하거나
// 공개 signup을 열지 않고, 서버 호스트에서 이 CLI를 명시적으로 실행할 때만 생성한다.
async function main(): Promise<void> {
  const username = process.env.WEB_AGENT_MANAGER_TEST_USERNAME?.trim();
  if (!username) throw new Error("WEB_AGENT_MANAGER_TEST_USERNAME이 필요합니다.");
  const password = readSecretInput({
    valueEnvironment: "WEB_AGENT_MANAGER_TEST_PASSWORD",
    fileEnvironment: "WEB_AGENT_MANAGER_TEST_PASSWORD_FILE",
    label: "테스트 계정 비밀번호",
    minimumLength: 12,
    maximumLength: 256,
  });
  const config = loadConfig();
  // 계정 CLI가 구버전 운영 DB를 몰래 migration하지 않게 현재 schema가 이미 적용된 경우만 쓴다.
  const database = new Database(path.join(config.dataDir, "web-agent-manager.sqlite"), { fileMustExist: true }) as AppDatabase;
  try {
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    const columns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "access_scope")) {
      throw new Error("test_only schema가 아직 적용되지 않았습니다. 검증 백업 후 새 서버를 재시작하세요.");
    }
    await upsertTestOnlyUser(database, username, password);
  } finally {
    database.close();
  }
  process.stdout.write("테스트 전용 계정을 저장했습니다.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "테스트 계정 생성 실패"}\n`);
  process.exitCode = 1;
});
