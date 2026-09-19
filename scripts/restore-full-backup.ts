import path from "node:path";
import { readSecretInput } from "../src/server/core/secret-input";
import { restoreFullBackup } from "../src/server/services/full-backup";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const archive = option("--backup");
  const dataDir = option("--data-dir");
  if (!archive || !dataDir) throw new Error("--backup <파일> --data-dir <빈 경로>가 필요합니다.");
  const passphrase = readSecretInput({
    valueEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE",
    fileEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE",
    label: "백업 passphrase",
    minimumLength: 16,
    maximumLength: 1024,
  });
  const result = await restoreFullBackup(path.resolve(archive), path.resolve(dataDir), passphrase);
  console.log(JSON.stringify({ restored: true, backupId: result.id, destination: path.resolve(dataDir), counts: result.counts }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
