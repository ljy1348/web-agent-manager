import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { MfaService } from "../src/server/core/mfa";
import { readSecretInput } from "../src/server/core/secret-input";
import { CredentialVault } from "../src/server/services/credential-vault";
import { restoreFullBackup } from "../src/server/services/full-backup";

const COUNT_TABLES = ["projects", "chats", "prompt_schedules", "agent_presets", "agent_preset_versions", "agent_tasks", "verification_runs"] as const;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const archive = option("--backup");
  if (!archive) throw new Error("--backup <파일>이 필요합니다.");
  const passphrase = readSecretInput({
    valueEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE",
    fileEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE",
    label: "백업 passphrase",
    minimumLength: 16,
    maximumLength: 1024,
  });
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wam-restore-drill-"));
  const destination = path.join(workRoot, "restored");
  const startedAt = performance.now();
  try {
    const backup = await restoreFullBackup(path.resolve(archive), destination, passphrase);
    const database = new Database(path.join(destination, "web-agent-manager.sqlite"));
    try {
      for (const table of COUNT_TABLES) {
        const actual = (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
        if (actual !== backup.counts[table]) throw new Error(`복구 훈련 건수가 manifest와 다릅니다: ${table}`);
      }
      if (fs.existsSync(path.join(destination, "secrets", "mfa-master.key"))) new MfaService(database, destination);
      if (fs.existsSync(path.join(destination, "secrets", "credential-vault.key"))) new CredentialVault(database, destination);
    } finally { database.close(); }
    console.log(JSON.stringify({
      drillPassed: true,
      backupId: backup.id,
      counts: backup.counts,
      elapsedMs: Math.round(performance.now() - startedAt),
    }, null, 2));
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
