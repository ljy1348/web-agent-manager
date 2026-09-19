import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("workbench artifact schema migration", () => {
  it("preview 전용 기존 table의 행을 보존하고 visual_diff 종류를 추가한다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-artifact-migration-")); roots.push(root);
    const config: AppConfig = { rootDir: root, homeDir: root, dataDir: root, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } };
    let database = openDatabase(config);
    database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(root).lastInsertRowid);
    const accountId = Number((database.prepare("SELECT id FROM agent_accounts WHERE provider = 'codex'").get() as { id: number }).id);
    const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title) VALUES (?, 'codex', ?, 'migration', 'stopped', 'migration')").run(projectId, accountId).lastInsertRowid);
    database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state) VALUES ('task', ?, ?, 'running')").run(chatId, projectId);
    database.prepare("INSERT INTO task_workbench_artifacts(id, task_id, kind, path, sha256, size_bytes, metadata_json, created_by) VALUES ('old-preview', 'task', 'preview_screenshot', '/tmp/old.png', 'hash', 1, '{}', 1)").run();
    database.close();

    const raw = new Database(path.join(root, "web-agent-manager.sqlite")); raw.pragma("foreign_keys = OFF"); raw.exec("DROP TABLE task_visual_baselines");
    raw.exec("ALTER TABLE task_workbench_artifacts RENAME TO artifact_new");
    raw.exec(`CREATE TABLE task_workbench_artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('preview_screenshot')), path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    raw.exec("INSERT INTO task_workbench_artifacts SELECT * FROM artifact_new"); raw.exec("DROP TABLE artifact_new"); raw.close();

    database = openDatabase(config);
    expect(database.prepare("SELECT kind FROM task_workbench_artifacts WHERE id = 'old-preview'").get()).toEqual({ kind: "preview_screenshot" });
    expect(() => database.prepare("INSERT INTO task_workbench_artifacts(id, task_id, kind, path, sha256, size_bytes) VALUES ('diff', 'task', 'visual_diff', '/tmp/diff.png', 'hash2', 1)").run()).not.toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
