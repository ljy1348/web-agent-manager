import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { FullBackupService } from "../src/server/services/full-backup";

const roots: string[] = [];

function cliArgs(source: string, compiledEnvironmentName: string): string[] {
  const compiled = process.env[compiledEnvironmentName];
  return compiled
    ? [path.resolve(compiled)]
    : [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve(source)];
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("전체 백업 offline 복구 CLI", () => {
  it("pre-migration DB를 read-only로 열어 백업하고 실제 복구 검증한 package만 남긴다", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-pre-migration-backup-cli-"));
    roots.push(root);
    const dataDir = path.join(root, "source");
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const databaseFile = path.join(dataDir, "web-agent-manager.sqlite");
    const legacy = new Database(databaseFile);
    legacy.exec(`
      CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
      CREATE TABLE chats(id INTEGER PRIMARY KEY, project_id INTEGER, status TEXT NOT NULL, busy INTEGER NOT NULL);
      INSERT INTO projects(id, name, path) VALUES (1, 'legacy-project-marker', '/workspace/legacy');
      INSERT INTO chats(id, project_id, status, busy) VALUES (1, 1, 'running', 1);
    `);
    legacy.close();
    fs.chmodSync(databaseFile, 0o600);
    const before = fs.readFileSync(databaseFile);
    const backupPassphrase = "pre migration backup passphrase";
    const passphraseFile = path.join(root, "backup-passphrase");
    fs.writeFileSync(passphraseFile, `${backupPassphrase}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      ...cliArgs("scripts/create-full-backup.ts", "WAM_TEST_CREATE_BACKUP_CLI_ENTRY"),
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        WEB_AGENT_MANAGER_DATA_DIR: dataDir,
        WEB_AGENT_MANAGER_BACKUP_PASSPHRASE: undefined,
        WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE: passphraseFile,
      },
      encoding: "utf8",
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { verifiedRestorable: boolean; archive: string; counts: Record<string, number> };
    expect(output.verifiedRestorable).toBe(true);
    expect(output.counts).toMatchObject({ projects: 1, chats: 1, agent_tasks: 0, verification_runs: 0 });
    expect(path.dirname(output.archive)).toBe(path.join(dataDir, "full-backups"));
    expect(fs.statSync(output.archive).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(databaseFile).equals(before)).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, "full-backups")).filter((name) => name.endsWith(".wambackup"))).toHaveLength(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(backupPassphrase);
    expect(fs.readFileSync(output.archive).includes(Buffer.from("legacy-project-marker"))).toBe(false);
  }, 20_000);

  it("실제 tsx 프로세스가 passphrase env로 새 dataDir를 복구하고 원문을 출력하지 않는다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-full-backup-cli-"));
    roots.push(root);
    const source = path.join(root, "source");
    fs.mkdirSync(source, { mode: 0o700 });
    const config = loadConfig();
    config.dataDir = source;
    const database = openDatabase(config);
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('admin', 'cli-password-marker', 'admin')").run();
    database.prepare("INSERT INTO projects(name, path) VALUES ('CLI 복구 프로젝트', '/workspace/cli-restore')").run();
    const service = new FullBackupService(database, source);
    const passphrase = "offline restore CLI passphrase";
    const backup = await service.create(passphrase);
    const archive = service.file(backup.id);
    database.close();

    const destination = path.join(root, "restored");
    const result = spawnSync(process.execPath, [
      ...cliArgs("scripts/restore-full-backup.ts", "WAM_TEST_RESTORE_CLI_ENTRY"),
      "--backup", archive,
      "--data-dir", destination,
    ], {
      cwd: path.resolve("."),
      env: { ...process.env, WEB_AGENT_MANAGER_BACKUP_PASSPHRASE: passphrase },
      encoding: "utf8",
      timeout: 15_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`"backupId": "${backup.id}"`);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(passphrase);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("cli-password-marker");
    const restored = new Database(path.join(destination, "web-agent-manager.sqlite"), { readonly: true });
    expect(restored.prepare("SELECT name, path FROM projects").get()).toEqual({ name: "CLI 복구 프로젝트", path: "/workspace/cli-restore" });
    expect((restored.prepare("SELECT COUNT(*) AS count FROM web_sessions").get() as { count: number }).count).toBe(0);
    restored.close();

    const drill = spawnSync(process.execPath, [
      ...cliArgs("scripts/drill-full-backup.ts", "WAM_TEST_DRILL_CLI_ENTRY"),
      "--backup", archive,
    ], {
      cwd: path.resolve("."),
      env: { ...process.env, WEB_AGENT_MANAGER_BACKUP_PASSPHRASE: passphrase },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(drill.error).toBeUndefined();
    expect(drill.status, drill.stderr).toBe(0);
    expect(drill.stdout).toContain('"drillPassed": true');
    expect(drill.stdout).toContain(`"backupId": "${backup.id}"`);
    expect(`${drill.stdout}\n${drill.stderr}`).not.toContain(passphrase);
    expect(`${drill.stdout}\n${drill.stderr}`).not.toContain("cli-password-marker");
  }, 20_000);
});
