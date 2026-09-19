import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { MfaService } from "../src/server/core/mfa";
import { CredentialVault } from "../src/server/services/credential-vault";
import { FullBackupService, restoreFullBackup } from "../src/server/services/full-backup";
import { createFullBackupRouter } from "../src/server/routes/full-backup-routes";
import type { AuthenticatedRequest } from "../src/server/core/auth";

const roots: string[] = [];
const passphrase = "correct horse battery staple backup";

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function sourceFixture(rowCount = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-full-backup-"));
  roots.push(root);
  const dataDir = path.join(root, "source");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const config = loadConfig();
  config.dataDir = dataDir;
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'password-hash-marker', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('backup-project', '/workspace/backup-project')").run().lastInsertRowid);
  const insertChat = database.prepare(`INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, busy)
    VALUES (?, 'claude', ?, ?, 'running', ?, 1)`);
  for (let index = 0; index < rowCount; index += 1) insertChat.run(projectId, `session-${index}`, `chat_backup_${index}`, `chat ${index}`);
  const chatId = Number((database.prepare("SELECT id FROM chats ORDER BY id LIMIT 1").get() as { id: number }).id);
  database.prepare(`INSERT INTO prompt_schedules(name, project_id, mode, provider, prompt, daily_time, timezone, created_by)
    VALUES ('daily', ?, 'new_chat', 'claude', 'run checks', '09:00', 'Asia/Seoul', 1)`).run(projectId);
  database.prepare("INSERT INTO agent_presets(id, project_id, name, task_kind, status, active_version, created_by) VALUES ('preset', ?, 'safe', 'implementation', 'active', 1, 1)").run(projectId);
  database.prepare("INSERT INTO agent_preset_versions(id, preset_id, version, config_snapshot_json, created_by) VALUES ('preset-v1', 'preset', 1, '{\"model\":\"safe\"}', 1)").run();
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, profile_version_id, created_by, state, goal) VALUES ('task', ?, ?, 'preset-v1', 1, 'running', 'restore me')").run(chatId, projectId);
  database.prepare("INSERT INTO web_sessions(user_id, token_hash, csrf_token, expires_at) VALUES (1, 'old-cookie-hash', 'csrf', datetime('now', '+1 day'))").run();
  const vault = new CredentialVault(database, dataDir);
  const vaultId = vault.put("system", "test", "backup", "api_key", "vault-secret-marker");
  const mfa = new MfaService(database, dataDir);
  mfa.beginSetup(1, "admin");
  fs.writeFileSync(path.join(dataDir, "one-time-code-secret"), Buffer.alloc(32, 7), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "hook-token"), "hook-secret-marker", { mode: 0o600 });
  return { root, dataDir, database, service: new FullBackupService(database, dataDir), vaultId, projectId, chatId };
}

describe("전체 암호화 백업과 빈 환경 복구", () => {
  it("DB·key를 암호화 package로 만들고 manifest에는 메타데이터만 노출한다", async () => {
    const fixture = sourceFixture();
    const backup = await fixture.service.create(passphrase);
    expect(backup.counts).toMatchObject({ projects: 1, chats: 1, prompt_schedules: 1, agent_presets: 1, agent_preset_versions: 1, agent_tasks: 1 });
    expect(backup.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "web-agent-manager.sqlite", "secrets/mfa-master.key", "secrets/credential-vault.key", "one-time-code-secret", "hook-token",
    ]));
    const archive = fixture.service.file(backup.id);
    const bytes = fs.readFileSync(archive);
    for (const marker of ["password-hash-marker", "vault-secret-marker", "hook-secret-marker", "backup-project"]) {
      expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    expect(fixture.service.list()[0].id).toBe(backup.id);
  });

  it("잘못된 passphrase와 ciphertext 변조는 빈 대상에 어떤 파일도 남기지 않는다", async () => {
    const fixture = sourceFixture();
    const backup = await fixture.service.create(passphrase);
    const archive = fixture.service.file(backup.id);
    const wrongDestination = path.join(fixture.root, "wrong-restore");
    fs.mkdirSync(wrongDestination, { mode: 0o700 });
    await expect(restoreFullBackup(archive, wrongDestination, "this passphrase is definitely wrong")).rejects.toThrow();
    expect(fs.readdirSync(wrongDestination)).toEqual([]);

    const tampered = path.join(fixture.root, "tampered.wambackup");
    const bytes = fs.readFileSync(archive);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    fs.writeFileSync(tampered, bytes, { mode: 0o600 });
    const tamperedDestination = path.join(fixture.root, "tampered-restore");
    await expect(restoreFullBackup(tampered, tamperedDestination, passphrase)).rejects.toThrow();
    expect(fs.existsSync(tamperedDestination)).toBe(false);
  });

  it("빈 dataDir에 관계·session mapping·key를 복구하고 로그인 세션과 runtime 상태는 폐기한다", async () => {
    const fixture = sourceFixture();
    const backup = await fixture.service.create(passphrase);
    const archive = fixture.service.file(backup.id);
    const destination = path.join(fixture.root, "restored");
    const restored = await restoreFullBackup(archive, destination, passphrase);
    expect(restored.id).toBe(backup.id);
    expect(fs.existsSync(path.join(destination, "restore-manifest.json"))).toBe(true);

    const database = new Database(path.join(destination, "web-agent-manager.sqlite"));
    expect(database.prepare("SELECT name, path FROM projects").get()).toEqual({ name: "backup-project", path: "/workspace/backup-project" });
    expect(database.prepare("SELECT provider_session_id, status, busy FROM chats WHERE id = ?").get(fixture.chatId)).toEqual({ provider_session_id: "session-0", status: "stopped", busy: 0 });
    expect(database.prepare("SELECT profile_version_id, goal FROM agent_tasks WHERE id = 'task'").get()).toEqual({ profile_version_id: "preset-v1", goal: "restore me" });
    expect((database.prepare("SELECT COUNT(*) AS count FROM prompt_schedules").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM web_sessions").get() as { count: number }).count).toBe(0);
    const restoredVault = new CredentialVault(database, destination);
    let value = "";
    await restoredVault.withSecret(fixture.vaultId, "restore-test", async (secretValue) => { value = secretValue; });
    expect(value).toBe("vault-secret-marker");
    expect(() => new MfaService(database, destination)).not.toThrow();
    database.close();
  });

  it("비어 있지 않은 대상은 덮어쓰지 않고 백업 삭제는 package 하나만 제거한다", async () => {
    const fixture = sourceFixture();
    const backup = await fixture.service.create(passphrase);
    const destination = path.join(fixture.root, "occupied");
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "keep.txt"), "keep");
    await expect(restoreFullBackup(fixture.service.file(backup.id), destination, passphrase)).rejects.toThrow(/비어 있는/);
    expect(fs.readFileSync(path.join(destination, "keep.txt"), "utf8")).toBe("keep");
    fixture.service.delete(backup.id);
    expect(fixture.service.list()).toEqual([]);
  });

  it("관리자 API가 생성·목록·다운로드·삭제를 수행하되 passphrase를 응답·감사에 남기지 않는다", async () => {
    const fixture = sourceFixture();
    const app = express();
    app.use(express.json());
    app.use((request: AuthenticatedRequest, _response, next) => {
      request.authUser = { id: 1, username: "admin", role: "admin", access_scope: "standard" };
      request.trustedNetwork = true;
      next();
    });
    app.use("/api", createFullBackupRouter(fixture.database, fixture.service));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const created = await fetch(`${baseUrl}/api/admin/full-backups`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as { backup: { id: string } };
      expect(JSON.stringify(createdBody)).not.toContain(passphrase);
      const listed = await (await fetch(`${baseUrl}/api/admin/full-backups`)).json() as { backups: Array<{ id: string }> };
      expect(listed.backups[0].id).toBe(createdBody.backup.id);
      const downloaded = await fetch(`${baseUrl}/api/admin/full-backups/${createdBody.backup.id}/download`);
      expect(downloaded.status).toBe(200);
      expect((await downloaded.arrayBuffer()).byteLength).toBeGreaterThan(100);
      expect(JSON.stringify(fixture.database.prepare("SELECT * FROM audit_logs").all())).not.toContain(passphrase);
      expect((await fetch(`${baseUrl}/api/admin/full-backups/${createdBody.backup.id}`, { method: "DELETE" })).status).toBe(204);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("실사용 규모 5,000개 chat snapshot·암호화·복구를 5초 안에 완료한다", async () => {
    const fixture = sourceFixture(5_000);
    const startedAt = performance.now();
    const backup = await fixture.service.create(passphrase);
    const destination = path.join(fixture.root, "performance-restore");
    await restoreFullBackup(fixture.service.file(backup.id), destination, passphrase);
    const elapsed = performance.now() - startedAt;
    const restored = new Database(path.join(destination, "web-agent-manager.sqlite"), { readonly: true });
    expect((restored.prepare("SELECT COUNT(*) AS count FROM chats").get() as { count: number }).count).toBe(5_000);
    restored.close();
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});
