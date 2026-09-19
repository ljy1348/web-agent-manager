import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("실제 schema deployment migration drill", () => {
  it("source DB는 바꾸지 않고 snapshot에 migration·integrity·test_only 검증을 수행한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-deployment-drill-test-"));
    roots.push(dataDir);
    const database = openDatabase({ dataDir } as AppConfig);
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('source-user-marker', 'source-password-marker', 'admin')").run();
    database.prepare("INSERT INTO projects(name, path) VALUES ('source-project-marker', '/workspace/source')").run();
    database.exec("DROP TABLE provider_shadow_turn_scans");
    database.close();

    const result = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/drill-deployment.ts")], {
      cwd: path.resolve("."),
      env: { ...process.env, WEB_AGENT_MANAGER_DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      drillPassed: boolean;
      sourceSchemaUnchanged: boolean;
      durableCounts: Record<string, number>;
      currentSchema: { missingTables: number; missingColumns: number };
      testOnlyCredential: { role: string; accessScope: string; passwordVerified: boolean };
    };
    expect(output).toMatchObject({
      drillPassed: true,
      sourceSchemaUnchanged: true,
      currentSchema: { missingTables: 0, missingColumns: 0 },
      testOnlyCredential: { role: "user", accessScope: "test_only", passwordVerified: true },
    });
    expect(output.durableCounts).toMatchObject({ users: 1, projects: 1 });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("source-user-marker");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("source-password-marker");

    const source = new Database(path.join(dataDir, "web-agent-manager.sqlite"), { readonly: true });
    expect((source.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count).toBe(1);
    expect(source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_shadow_turn_scans'").get()).toBeUndefined();
    source.close();
  }, 20_000);
});
