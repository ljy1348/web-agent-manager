import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { verifyPassword } from "../src/server/core/security";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function run(dataDir: string, passwordFile: string) {
  return spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/create-test-user.ts")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      WEB_AGENT_MANAGER_DATA_DIR: dataDir,
      WEB_AGENT_MANAGER_TEST_USERNAME: "qa-file-tester",
      WEB_AGENT_MANAGER_TEST_PASSWORD: undefined,
      WEB_AGENT_MANAGER_TEST_PASSWORD_FILE: passwordFile,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("test-only 계정 생성 CLI", () => {
  it("적용된 schema에서 owner-only 비밀번호 파일로만 test_only 계정을 만든다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-test-user-cli-"));
    roots.push(root);
    const database = openDatabase({ dataDir: root } as AppConfig);
    database.close();
    const password = "file-only-test-password";
    const passwordFile = path.join(root, "test-password");
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });

    const result = run(root, passwordFile);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(password);
    const stored = new Database(path.join(root, "web-agent-manager.sqlite"), { readonly: true });
    const user = stored.prepare("SELECT role, access_scope, password_hash FROM users WHERE username = ?").get("qa-file-tester") as {
      role: string; access_scope: string; password_hash: string;
    };
    expect(user).toMatchObject({ role: "user", access_scope: "test_only" });
    await expect(verifyPassword(password, user.password_hash)).resolves.toBe(true);
    stored.close();
  });

  it("legacy schema를 자동 migration하거나 계정을 쓰지 않는다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-test-user-legacy-"));
    roots.push(root);
    const databaseFile = path.join(root, "web-agent-manager.sqlite");
    const legacy = new Database(databaseFile);
    legacy.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT)");
    legacy.close();
    const passwordFile = path.join(root, "test-password");
    fs.writeFileSync(passwordFile, "legacy-safe-password\n", { mode: 0o600 });

    const result = run(root, passwordFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test_only schema가 아직 적용되지 않았습니다");
    const inspected = new Database(databaseFile, { readonly: true });
    expect((inspected.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count).toBe(0);
    expect((inspected.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((row) => row.name)).not.toContain("access_scope");
    inspected.close();
  });
});
