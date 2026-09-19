import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppDatabase } from "../core/database";

const MAGIC = Buffer.from("WAMBAK01");
const TAG_BYTES = 16;
const DIGEST_BYTES = 32;
const MAX_HEADER_BYTES = 1024 * 1024;
const MIN_PASSPHRASE_LENGTH = 16;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const CHUNK_BYTES = 1024 * 1024;
const BACKUP_ID = /^[A-Za-z0-9_-]{1,100}$/;

const OPTIONAL_SECRET_FILES = [
  "secrets/mfa-master.key",
  "secrets/credential-vault.key",
  "one-time-code-secret",
  "hook-token",
] as const;
const ALLOWED_ENTRIES = new Set<string>(["web-agent-manager.sqlite", ...OPTIONAL_SECRET_FILES]);

export interface FullBackupEntry {
  path: string;
  size: number;
  mode: number;
  sha256: string;
  kind: "database" | "key";
}

export interface FullBackupManifest {
  format: "wam-full-backup";
  schemaVersion: 1;
  id: string;
  createdAt: string;
  cipher: { algorithm: "aes-256-gcm"; nonce: string };
  kdf: { algorithm: "scrypt"; salt: string; N: number; r: number; p: number };
  entries: FullBackupEntry[];
  counts: Record<string, number>;
  externalRequirements: string[];
  ciphertextBytes: number;
}

export interface FullBackupSummary {
  id: string;
  createdAt: string;
  sizeBytes: number;
  entries: Array<Pick<FullBackupEntry, "path" | "size" | "kind">>;
  counts: Record<string, number>;
  externalRequirements: string[];
}

interface ParsedArchive {
  manifest: FullBackupManifest;
  header: Buffer;
  ciphertextOffset: number;
  tagOffset: number;
  digestOffset: number;
  size: number;
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH || passphrase.length > 1024) {
    throw new Error(`백업 passphrase는 ${MIN_PASSPHRASE_LENGTH}~1024자여야 합니다.`);
  }
}

function secureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("백업 디렉터리가 안전한 일반 디렉터리가 아닙니다.");
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
}

function writeAll(fd: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.length) offset += fs.writeSync(fd, value, offset, value.length - offset);
}

function readExact(fd: number, length: number, position: number): Buffer {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, result, offset, length - offset, position + offset);
    if (!count) throw new Error("백업 파일이 중간에서 끝났습니다.");
    offset += count;
  }
  return result;
}

function hashFile(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(CHUNK_BYTES);
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    buffer.fill(0);
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function validateSourceFile(file: string, label: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}은 symlink가 아닌 일반 파일이어야 합니다.`);
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) throw new Error(`${label} 권한은 소유자가 읽을 수 있는 소유자 전용이어야 합니다.`);
  return stat;
}

function tableCounts(database: Database.Database): Record<string, number> {
  const tables = ["projects", "chats", "prompt_schedules", "agent_presets", "agent_preset_versions", "agent_tasks", "verification_runs"];
  return Object.fromEntries(tables.map((table) => {
    const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", table);
    const count = exists ? (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count : 0;
    return [table, count];
  }));
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", table));
}

function parseArchive(file: string): ParsedArchive {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("백업은 symlink가 아닌 일반 파일이어야 합니다.");
  const minimum = MAGIC.length + 4 + 2 + TAG_BYTES + DIGEST_BYTES;
  if (stat.size < minimum) throw new Error("백업 파일이 너무 짧습니다.");
  const fd = fs.openSync(file, "r");
  try {
    if (!readExact(fd, MAGIC.length, 0).equals(MAGIC)) throw new Error("지원하지 않는 백업 형식입니다.");
    const headerLength = readExact(fd, 4, MAGIC.length).readUInt32BE(0);
    if (headerLength <= 1 || headerLength > MAX_HEADER_BYTES) throw new Error("백업 manifest 크기가 올바르지 않습니다.");
    const header = readExact(fd, headerLength, MAGIC.length + 4);
    const manifest = JSON.parse(header.toString("utf8")) as FullBackupManifest;
    if (manifest.format !== "wam-full-backup" || manifest.schemaVersion !== 1 || !BACKUP_ID.test(manifest.id)) throw new Error("백업 manifest 형식이 올바르지 않습니다.");
    if (manifest.cipher?.algorithm !== "aes-256-gcm" || manifest.kdf?.algorithm !== "scrypt"
      || manifest.kdf.N !== SCRYPT_N || manifest.kdf.r !== SCRYPT_R || manifest.kdf.p !== SCRYPT_P) throw new Error("지원하지 않는 백업 암호화 설정입니다.");
    if (Buffer.from(manifest.cipher.nonce, "base64").length !== 12
      || Buffer.from(manifest.kdf.salt, "base64").length !== 16) throw new Error("백업 nonce 또는 KDF salt가 올바르지 않습니다.");
    if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error("백업 항목이 없습니다.");
    const paths = new Set<string>();
    let ciphertextBytes = 0;
    for (const entry of manifest.entries) {
      if (!ALLOWED_ENTRIES.has(entry.path) || paths.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || !Number.isInteger(entry.mode) || entry.mode < 0o400 || entry.mode > 0o700 || (entry.mode & 0o077) !== 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || !["database", "key"].includes(entry.kind)) throw new Error("백업 항목 manifest가 올바르지 않습니다.");
      paths.add(entry.path);
      ciphertextBytes += entry.size;
    }
    if (!paths.has("web-agent-manager.sqlite") || manifest.ciphertextBytes !== ciphertextBytes) throw new Error("백업 DB 또는 크기 manifest가 올바르지 않습니다.");
    const ciphertextOffset = MAGIC.length + 4 + headerLength;
    const tagOffset = ciphertextOffset + ciphertextBytes;
    const digestOffset = tagOffset + TAG_BYTES;
    if (digestOffset + DIGEST_BYTES !== stat.size) throw new Error("백업 파일 전체 길이가 manifest와 다릅니다.");
    return { manifest, header, ciphertextOffset, tagOffset, digestOffset, size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function summary(file: string, parsed = parseArchive(file)): FullBackupSummary {
  return {
    id: parsed.manifest.id,
    createdAt: parsed.manifest.createdAt,
    sizeBytes: parsed.size,
    entries: parsed.manifest.entries.map(({ path: entryPath, size, kind }) => ({ path: entryPath, size, kind })),
    counts: parsed.manifest.counts,
    externalRequirements: parsed.manifest.externalRequirements,
  };
}

function deriveKey(passphrase: string, manifest: FullBackupManifest): Buffer {
  return crypto.scryptSync(passphrase, Buffer.from(manifest.kdf.salt, "base64"), KEY_BYTES, {
    N: manifest.kdf.N, r: manifest.kdf.r, p: manifest.kdf.p, maxmem: 64 * 1024 * 1024,
  });
}

function validateRestoredDatabase(file: string, entries: FullBackupEntry[]): void {
  const database = new Database(file);
  try {
    const result = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (result[0]?.integrity_check !== "ok") throw new Error("복구 DB integrity_check가 실패했습니다.");
    const hasMfa = tableExists(database, "user_mfa") && !!database.prepare("SELECT 1 FROM user_mfa LIMIT 1").get();
    const hasVault = tableExists(database, "credential_vault_entries") && !!database.prepare("SELECT 1 FROM credential_vault_entries LIMIT 1").get();
    const paths = new Set(entries.map((entry) => entry.path));
    if (hasMfa && !paths.has("secrets/mfa-master.key")) throw new Error("MFA 데이터에 필요한 key가 백업에 없습니다.");
    if (hasVault && !paths.has("secrets/credential-vault.key")) throw new Error("credential vault 데이터에 필요한 key가 백업에 없습니다.");
    // 이전 cookie/challenge를 새 호스트에서 부활시키지 않고, tmux가 없는 채팅은 정지 상태로 시작한다.
    database.transaction(() => {
      for (const table of ["web_sessions", "mfa_login_challenges", "mobile_trust_challenges", "mobile_trust_login_challenges", "one_time_login_codes", "credential_vault_leases"]) {
        if (tableExists(database, table)) database.prepare(`DELETE FROM ${table}`).run();
      }
      if (tableExists(database, "chats")) database.prepare("UPDATE chats SET status = 'stopped', busy = 0").run();
    })();
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

export async function restoreFullBackup(archive: string, destinationDataDir: string, passphrase: string): Promise<FullBackupSummary> {
  assertPassphrase(passphrase);
  const archivePath = path.resolve(archive);
  const destination = path.resolve(destinationDataDir);
  const parsed = parseArchive(archivePath);
  const existing = fs.existsSync(destination);
  if (existing) {
    const stat = fs.lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(destination).length) throw new Error("복구 대상 dataDir는 비어 있는 일반 디렉터리여야 합니다.");
  }
  const parent = path.dirname(destination);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("복구 대상의 상위 경로가 안전한 일반 디렉터리가 아닙니다.");
  const staging = path.join(parent, `.${path.basename(destination)}.restore-${crypto.randomUUID()}`);
  secureDirectory(staging);
  const fd = fs.openSync(archivePath, "r");
  const ciphertextHash = crypto.createHash("sha256");
  const key = deriveKey(passphrase, parsed.manifest);
  let currentFd: number | null = null;
  try {
    const storedDigest = readExact(fd, DIGEST_BYTES, parsed.digestOffset);
    const nonce = Buffer.from(parsed.manifest.cipher.nonce, "base64");
    if (nonce.length !== 12) throw new Error("백업 nonce가 올바르지 않습니다.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(parsed.header);
    decipher.setAuthTag(readExact(fd, TAG_BYTES, parsed.tagOffset));
    let encryptedPosition = parsed.ciphertextOffset;
    let remainingCiphertext = parsed.manifest.ciphertextBytes;
    let entryIndex = 0;
    let entryRemaining = parsed.manifest.entries[0].size;
    let entryHash = crypto.createHash("sha256");

    const finishEntry = (): void => {
      if (currentFd !== null) { fs.closeSync(currentFd); currentFd = null; }
      const entry = parsed.manifest.entries[entryIndex];
      if (entryHash.digest("hex") !== entry.sha256) throw new Error(`복구 항목 hash가 일치하지 않습니다: ${entry.path}`);
      entryIndex += 1;
      if (entryIndex < parsed.manifest.entries.length) {
        entryRemaining = parsed.manifest.entries[entryIndex].size;
        entryHash = crypto.createHash("sha256");
      }
    };
    const writePlaintext = (plaintext: Buffer): void => {
      let offset = 0;
      while (offset < plaintext.length || (entryIndex < parsed.manifest.entries.length && entryRemaining === 0)) {
        if (entryIndex >= parsed.manifest.entries.length) throw new Error("복구 payload가 manifest보다 큽니다.");
        const entry = parsed.manifest.entries[entryIndex];
        if (currentFd === null && entryRemaining > 0) {
          const target = path.join(staging, entry.path);
          if (!target.startsWith(`${staging}${path.sep}`)) throw new Error("복구 경로가 staging을 벗어났습니다.");
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          currentFd = fs.openSync(target, "wx", entry.mode & 0o700);
        }
        if (entryRemaining === 0) { finishEntry(); continue; }
        const length = Math.min(entryRemaining, plaintext.length - offset);
        if (length <= 0) break;
        const part = plaintext.subarray(offset, offset + length);
        writeAll(currentFd!, part);
        entryHash.update(part);
        offset += length;
        entryRemaining -= length;
        if (entryRemaining === 0) finishEntry();
      }
    };

    while (remainingCiphertext > 0) {
      const length = Math.min(CHUNK_BYTES, remainingCiphertext);
      const encrypted = readExact(fd, length, encryptedPosition);
      encryptedPosition += length;
      remainingCiphertext -= length;
      ciphertextHash.update(encrypted);
      writePlaintext(decipher.update(encrypted));
    }
    writePlaintext(decipher.final());
    if (entryIndex !== parsed.manifest.entries.length) throw new Error("복구 payload가 manifest보다 짧습니다.");
    if (!crypto.timingSafeEqual(Buffer.from(ciphertextHash.digest("hex"), "hex"), storedDigest)) throw new Error("백업 ciphertext hash가 일치하지 않습니다.");
    validateRestoredDatabase(path.join(staging, "web-agent-manager.sqlite"), parsed.manifest.entries);
    fs.writeFileSync(path.join(staging, "restore-manifest.json"), `${JSON.stringify({
      backupId: parsed.manifest.id, restoredAt: new Date().toISOString(), sourceSha256: hashFile(archivePath),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (existing) fs.rmdirSync(destination);
    fs.renameSync(staging, destination);
    return summary(archivePath, parsed);
  } catch (error) {
    if (currentFd !== null) fs.closeSync(currentFd);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
    fs.closeSync(fd);
  }
}

export class FullBackupService {
  private readonly root: string;

  constructor(private readonly database: AppDatabase, private readonly dataDir: string) {
    this.root = path.join(dataDir, "full-backups");
    secureDirectory(this.root);
    for (const entry of fs.readdirSync(this.root)) {
      if (entry.startsWith(".creating-") || entry.endsWith(".tmp")) {
        const target = path.join(this.root, entry);
        try { if (fs.lstatSync(target).isFile()) fs.unlinkSync(target); } catch { /* 다음 기동에서 재시도 */ }
      }
    }
  }

  async create(passphrase: string): Promise<FullBackupSummary> {
    assertPassphrase(passphrase);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    const snapshot = path.join(this.root, `.creating-${id}.sqlite`);
    const temporary = path.join(this.root, `${id}.wambackup.tmp`);
    const target = path.join(this.root, `${id}.wambackup`);
    await this.database.backup(snapshot);
    fs.chmodSync(snapshot, 0o600);
    try {
      const snapshotDb = new Database(snapshot, { readonly: true });
      let counts: Record<string, number>;
      try {
        const integrity = snapshotDb.pragma("integrity_check") as Array<{ integrity_check: string }>;
        if (integrity[0]?.integrity_check !== "ok") throw new Error("백업 DB integrity_check가 실패했습니다.");
        counts = tableCounts(snapshotDb);
      } finally { snapshotDb.close(); }
      const sources: Array<{ entryPath: string; source: string; kind: "database" | "key" }> = [
        { entryPath: "web-agent-manager.sqlite", source: snapshot, kind: "database" },
      ];
      for (const relative of OPTIONAL_SECRET_FILES) {
        const source = path.join(this.dataDir, relative);
        if (fs.existsSync(source)) sources.push({ entryPath: relative, source, kind: "key" });
      }
      const entries: FullBackupEntry[] = sources.map(({ entryPath, source, kind }) => {
        const stat = validateSourceFile(source, entryPath);
        return { path: entryPath, size: stat.size, mode: stat.mode & 0o700, sha256: hashFile(source), kind };
      });
      const salt = crypto.randomBytes(16);
      const nonce = crypto.randomBytes(12);
      const manifest: FullBackupManifest = {
        format: "wam-full-backup", schemaVersion: 1, id, createdAt: new Date().toISOString(),
        cipher: { algorithm: "aes-256-gcm", nonce: nonce.toString("base64") },
        kdf: { algorithm: "scrypt", salt: salt.toString("base64"), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
        entries, counts,
        externalRequirements: process.env.WEB_AGENT_MANAGER_ONE_TIME_CODE_SECRET ? ["WEB_AGENT_MANAGER_ONE_TIME_CODE_SECRET"] : [],
        ciphertextBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      };
      const header = Buffer.from(JSON.stringify(manifest), "utf8");
      if (header.length > MAX_HEADER_BYTES) throw new Error("백업 manifest가 너무 큽니다.");
      const key = deriveKey(passphrase, manifest);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(header);
      const ciphertextHash = crypto.createHash("sha256");
      const outputFd = fs.openSync(temporary, "wx", 0o600);
      try {
        const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
        writeAll(outputFd, MAGIC); writeAll(outputFd, length); writeAll(outputFd, header);
        for (const source of sources) {
          const sourceFd = fs.openSync(source.source, "r");
          const buffer = Buffer.alloc(CHUNK_BYTES);
          try {
            while (true) {
              const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
              if (!count) break;
              const encrypted = cipher.update(buffer.subarray(0, count));
              ciphertextHash.update(encrypted); writeAll(outputFd, encrypted);
            }
          } finally { buffer.fill(0); fs.closeSync(sourceFd); }
        }
        const final = cipher.final(); ciphertextHash.update(final); writeAll(outputFd, final);
        writeAll(outputFd, cipher.getAuthTag());
        writeAll(outputFd, ciphertextHash.digest());
        fs.fsyncSync(outputFd);
      } finally { key.fill(0); fs.closeSync(outputFd); }
      fs.renameSync(temporary, target);
      return summary(target);
    } finally {
      try { fs.unlinkSync(snapshot); } catch { /* 기동 정리가 남은 임시 snapshot을 처리한다 */ }
      try { fs.unlinkSync(temporary); } catch { /* 완성 rename 뒤에는 존재하지 않는다 */ }
    }
  }

  list(): FullBackupSummary[] {
    return fs.readdirSync(this.root).filter((name) => name.endsWith(".wambackup")).flatMap((name) => {
      try { return [summary(path.join(this.root, name))]; } catch { return []; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  file(id: string): string {
    if (!BACKUP_ID.test(id)) throw new Error("백업 ID가 올바르지 않습니다.");
    const file = path.join(this.root, `${id}.wambackup`);
    const parsed = parseArchive(file);
    if (parsed.manifest.id !== id) throw new Error("백업 ID와 manifest가 다릅니다.");
    return file;
  }

  delete(id: string): void {
    const file = this.file(id);
    fs.unlinkSync(file);
  }
}
