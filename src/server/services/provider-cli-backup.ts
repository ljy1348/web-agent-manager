import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../../shared/types";

interface BackupFile {
  kind: "binary" | "config";
  sourceRelative: string;
  backupRelative: string;
  sha256: string;
  mode: number;
}

export interface ProviderBackupManifest {
  schemaVersion: 1;
  provider: Provider;
  command: string;
  commandWasSymlink: boolean;
  files: BackupFile[];
  excludedCredentialFiles: true;
}

const CONFIG_FILES: Record<Provider, string[]> = {
  codex: [".codex/config.toml"],
  claude: [".claude/settings.json"],
  grok: [".grok/config.toml", ".grok/trusted_folders.toml"],
};

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveCommand(command: string, searchPath = process.env.PATH ?? ""): string {
  if (!/^[a-z0-9._-]+$/i.test(command)) throw new Error("CLI command 이름이 올바르지 않습니다.");
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) return candidate;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 다음 PATH 항목 */ }
  }
  throw new Error("CLI 실행 파일을 찾을 수 없습니다.");
}

export class ProviderCliBackupService {
  private readonly root: string;

  constructor(private readonly dataDir: string, private readonly homeDir: string, private readonly commandResolver = resolveCommand) {
    this.root = path.join(dataDir, "provider-cli-backups");
  }

  prepare(runId: string, provider: Provider, command: string): ProviderBackupManifest {
    if (!/^[0-9a-f-]{8,64}$/i.test(runId)) throw new Error("update run ID가 올바르지 않습니다.");
    const runRoot = path.join(this.root, runId);
    if (!inside(this.root, runRoot)) throw new Error("backup 경로가 허용 범위를 벗어났습니다.");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
    const commandPath = path.resolve(this.commandResolver(command));
    const commandStat = fs.lstatSync(commandPath);
    const binarySource = fs.realpathSync(commandPath);
    const binaryStat = fs.statSync(binarySource);
    if (!binaryStat.isFile()) throw new Error("CLI 대상이 일반 파일이 아닙니다.");
    const files: BackupFile[] = [];
    const copy = (kind: BackupFile["kind"], source: string, sourceRelative: string, name: string): void => {
      const target = path.join(runRoot, name);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      files.push({ kind, sourceRelative, backupRelative: name, sha256: hashFile(target), mode: fs.statSync(source).mode & 0o777 });
    };
    copy("binary", binarySource, "", "cli-binary");
    for (const relative of CONFIG_FILES[provider]) {
      const source = path.resolve(this.homeDir, relative);
      if (!inside(this.homeDir, source) || !fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      copy("config", source, relative, `config-${files.length}`);
    }
    const manifest: ProviderBackupManifest = { schemaVersion: 1, provider, command, commandWasSymlink: commandStat.isSymbolicLink(), files, excludedCredentialFiles: true };
    fs.writeFileSync(path.join(runRoot, "manifest.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    return manifest;
  }

  restore(runId: string, manifest: ProviderBackupManifest): void {
    const runRoot = path.join(this.root, runId);
    if (!inside(this.root, runRoot) || manifest.schemaVersion !== 1 || !manifest.excludedCredentialFiles) throw new Error("backup manifest가 올바르지 않습니다.");
    const binary = manifest.files.find((file) => file.kind === "binary");
    if (!binary) throw new Error("복구할 CLI binary가 없습니다.");
    for (const file of manifest.files) {
      const backupPath = path.join(runRoot, file.backupRelative);
      if (!inside(runRoot, backupPath) || hashFile(backupPath) !== file.sha256) throw new Error("backup hash 검증에 실패했습니다.");
    }
    const restoreFile = (file: BackupFile, target: string): void => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.wam-rollback-${crypto.randomUUID()}`;
      try {
        fs.copyFileSync(path.join(runRoot, file.backupRelative), temporary, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(temporary, file.mode);
        fs.renameSync(temporary, target);
      } finally {
        try { fs.unlinkSync(temporary); } catch { /* rename 성공 또는 임시 파일 없음 */ }
      }
    };
    if (manifest.commandWasSymlink) {
      const commandPath = path.resolve(this.commandResolver(manifest.command));
      const managedBinary = path.join(runRoot, "restored-cli");
      if (!fs.existsSync(managedBinary)) restoreFile(binary, managedBinary);
      const temporaryLink = `${commandPath}.wam-rollback-${crypto.randomUUID()}`;
      try {
        fs.symlinkSync(managedBinary, temporaryLink);
        fs.renameSync(temporaryLink, commandPath);
      } finally {
        try { fs.unlinkSync(temporaryLink); } catch { /* rename 성공 또는 임시 링크 없음 */ }
      }
    } else restoreFile(binary, path.resolve(this.commandResolver(manifest.command)));
    for (const file of manifest.files.filter((item) => item.kind === "config")) {
      const target = path.resolve(this.homeDir, file.sourceRelative);
      if (!inside(this.homeDir, target)) throw new Error("config 복구 경로가 허용 범위를 벗어났습니다.");
      restoreFile(file, target);
    }
  }
}
