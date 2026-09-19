import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { loadConfig } from "../src/server/core/config";
import { readSecretInput } from "../src/server/core/secret-input";
import { FullBackupService, restoreFullBackup } from "../src/server/services/full-backup";

async function main(): Promise<void> {
  const passphrase = readSecretInput({
    valueEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE",
    fileEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE",
    label: "백업 passphrase",
    minimumLength: 16,
    maximumLength: 1024,
  });
  const config = loadConfig();
  const databaseFile = path.join(config.dataDir, "web-agent-manager.sqlite");
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  const service = new FullBackupService(database, config.dataDir);
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wam-pre-migration-backup-"));
  const startedAt = performance.now();
  let backupId: string | null = null;
  try {
    const backup = await service.create(passphrase);
    backupId = backup.id;
    const archive = service.file(backup.id);
    const verification = await restoreFullBackup(archive, path.join(verificationRoot, "restored"), passphrase);
    if (verification.id !== backup.id || JSON.stringify(verification.counts) !== JSON.stringify(backup.counts)) {
      throw new Error("백업 생성 결과와 복구 검증 결과가 일치하지 않습니다.");
    }
    process.stdout.write(`${JSON.stringify({
      created: true,
      verifiedRestorable: true,
      backupId: backup.id,
      archive,
      sizeBytes: backup.sizeBytes,
      counts: backup.counts,
      elapsedMs: Math.round(performance.now() - startedAt),
    }, null, 2)}\n`);
  } catch (error) {
    if (backupId) {
      try { service.delete(backupId); } catch { /* 이번 호출의 검증 실패 package만 best-effort 정리한다. */ }
    }
    throw error;
  } finally {
    database.close();
    fs.rmSync(verificationRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "전체 백업 생성 실패"}\n`);
  process.exitCode = 1;
});
