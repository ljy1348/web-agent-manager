import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../core/database";
import type { Provider } from "../../shared/types";

const KEY_BYTES = 32;
const LEASE_SECONDS = 30;

interface VaultRow {
  id: string;
  owner_type: "system" | "project";
  owner_id: string;
  purpose: string;
  secret_name: string;
  encrypted_value: string;
  nonce: string;
  auth_tag: string;
  version: number;
}

export interface McpSecretReferences {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  envVars?: string[];
  envHttpHeaders?: Record<string, string>;
}

// WAM이 직접 관리하는 비밀만 암호화한다. Claude/Codex/Grok 로그인 디렉터리는 읽지 않는다.
export class CredentialVault {
  private readonly keyPath: string;

  constructor(private readonly database: AppDatabase, dataDir: string) {
    this.keyPath = path.join(dataDir, "secrets", "credential-vault.key");
    const existing = this.database.prepare("SELECT * FROM credential_vault_entries LIMIT 1").get() as VaultRow | undefined;
    // 암호문이 있는데 key가 없거나 바뀌었으면 일부 기능만 조용히 망가뜨리지 말고 기동 시 실패한다.
    if (existing) this.decrypt(existing).fill(0);
  }

  has(id: string | null | undefined): boolean {
    return !!id && !!this.database.prepare("SELECT 1 FROM credential_vault_entries WHERE id = ?").get(id);
  }

  put(ownerType: "system" | "project", ownerId: string, purpose: string, secretName: string, value: string): string {
    if (!value) throw new Error("빈 자격증명은 vault에 저장할 수 없습니다.");
    const existing = this.database.prepare(`SELECT * FROM credential_vault_entries
      WHERE owner_type = ? AND owner_id = ? AND purpose = ? AND secret_name = ?`).get(ownerType, ownerId, purpose, secretName) as VaultRow | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const version = (existing?.version ?? 0) + 1;
    const encrypted = this.encrypt({ id, owner_type: ownerType, owner_id: ownerId, purpose, secret_name: secretName, version }, Buffer.from(value, "utf8"));
    this.database.prepare(`INSERT INTO credential_vault_entries(
      id, owner_type, owner_id, purpose, secret_name, encrypted_value, nonce, auth_tag, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET encrypted_value=excluded.encrypted_value, nonce=excluded.nonce,
      auth_tag=excluded.auth_tag, version=excluded.version, updated_at=CURRENT_TIMESTAMP`)
      .run(id, ownerType, ownerId, purpose, secretName, encrypted.encryptedValue, encrypted.nonce, encrypted.authTag, version);
    return id;
  }

  remove(id: string): void {
    this.database.prepare("DELETE FROM credential_vault_entries WHERE id = ?").run(id);
  }

  // 복호화 값은 callback 밖으로 반환하지 못하게 타입을 void로 고정하고 lease 메타데이터만 보존한다.
  async withSecret(id: string, consumer: string, callback: (secret: string) => Promise<void>): Promise<void> {
    const row = this.requireRow(id);
    const leaseId = crypto.randomUUID();
    this.database.prepare(`INSERT INTO credential_vault_leases(id, credential_id, consumer, expires_at)
      VALUES (?, ?, ?, datetime('now', ?))`).run(leaseId, id, consumer.slice(0, 160), `+${LEASE_SECONDS} seconds`);
    const bytes = this.decrypt(row);
    try {
      await callback(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
      this.database.prepare("UPDATE credential_vault_leases SET released_at = CURRENT_TIMESTAMP WHERE id = ?").run(leaseId);
      this.cleanupLeases();
    }
  }

  // CLI 실행에 필요한 프로젝트 MCP 비밀을 callback 동안만 빌린다. tmux 생성 뒤 WAM 메모리 참조는
  // 즉시 해제되지만, 자식 CLI 환경은 해당 세션 수명 동안 값을 보유한다.
  withMcpEnvironment<T>(provider: Provider, projectId: number, consumer: string, callback: (environment: Record<string, string>) => T): T {
    const rows = this.database.prepare(`SELECT e.*,
        b.env_var AS binding_env_var
      FROM credential_vault_mcp_bindings b
      JOIN credential_vault_entries e ON e.id = b.credential_id
      WHERE b.provider = ? AND b.project_id = ?
      ORDER BY b.server_name, b.field_kind, b.field_name`).all(provider, projectId) as Array<VaultRow & { binding_env_var: string }>;
    if (!rows.length) return callback({});
    const leaseIds: string[] = [];
    const buffers: Buffer[] = [];
    const environment: Record<string, string> = {};
    try {
      for (const row of rows) {
        const bytes = this.decrypt(row);
        buffers.push(bytes);
        const value = bytes.toString("utf8");
        const previous = environment[row.binding_env_var];
        if (previous !== undefined && previous !== value) {
          throw new Error(`Codex MCP 환경변수 ${row.binding_env_var}가 같은 프로젝트에서 서로 다른 값을 요구합니다.`);
        }
        environment[row.binding_env_var] = value;
        const leaseId = crypto.randomUUID();
        leaseIds.push(leaseId);
        this.database.prepare(`INSERT INTO credential_vault_leases(id, credential_id, consumer, expires_at)
          VALUES (?, ?, ?, datetime('now', ?))`).run(leaseId, row.id, consumer.slice(0, 160), `+${LEASE_SECONDS} seconds`);
      }
      return callback(environment);
    } finally {
      for (const bytes of buffers) bytes.fill(0);
      if (leaseIds.length) {
        const release = this.database.prepare("UPDATE credential_vault_leases SET released_at = CURRENT_TIMESTAMP WHERE id = ?");
        for (const leaseId of leaseIds) release.run(leaseId);
      }
      for (const key of Object.keys(environment)) environment[key] = "";
      this.cleanupLeases();
    }
  }

  // 명시적으로 전달된 env/header만 교체한다. undefined는 기존 참조를 유지하고 빈 객체는 모두 지운다.
  replaceMcpSecrets(provider: Provider, projectId: number, serverName: string, env?: Record<string, string>, headers?: Record<string, string>): McpSecretReferences {
    const result: McpSecretReferences = {};
    if (env !== undefined) result.env = this.replaceMcpKind(provider, projectId, serverName, "env", env);
    if (headers !== undefined) result.headers = this.replaceMcpKind(provider, projectId, serverName, "header", headers);
    const bindings = this.database.prepare(`SELECT field_kind, field_name, env_var FROM credential_vault_mcp_bindings
      WHERE provider = ? AND project_id = ? AND server_name = ? ORDER BY field_kind, field_name`).all(provider, projectId, serverName) as Array<{ field_kind: "env" | "header"; field_name: string; env_var: string }>;
    const envBindings = bindings.filter((row) => row.field_kind === "env");
    const headerBindings = bindings.filter((row) => row.field_kind === "header");
    if (provider === "codex") {
      if (env !== undefined || envBindings.length) {
        result.env = undefined;
        result.envVars = envBindings.map((row) => row.env_var);
      }
      if (headers !== undefined || headerBindings.length) {
        result.headers = undefined;
        result.envHttpHeaders = Object.fromEntries(headerBindings.map((row) => [row.field_name, row.env_var]));
      }
    } else {
      if (env !== undefined || envBindings.length) result.env = Object.fromEntries(envBindings.map((row) => [row.field_name, `\${${row.env_var}}`]));
      if (headers !== undefined || headerBindings.length) result.headers = Object.fromEntries(headerBindings.map((row) => [row.field_name, `\${${row.env_var}}`]));
    }
    return result;
  }

  removeMcpServer(provider: Provider, projectId: number, serverName: string): void {
    const ids = this.database.prepare(`SELECT credential_id FROM credential_vault_mcp_bindings
      WHERE provider = ? AND project_id = ? AND server_name = ?`).all(provider, projectId, serverName) as Array<{ credential_id: string }>;
    this.database.prepare("DELETE FROM credential_vault_mcp_bindings WHERE provider = ? AND project_id = ? AND server_name = ?").run(provider, projectId, serverName);
    for (const { credential_id: id } of ids) this.database.prepare(`DELETE FROM credential_vault_entries
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM credential_vault_mcp_bindings WHERE credential_id = ?)`).run(id, id);
  }

  private replaceMcpKind(provider: Provider, projectId: number, serverName: string, kind: "env" | "header", values: Record<string, string>): Record<string, string> {
    const old = this.database.prepare(`SELECT credential_id FROM credential_vault_mcp_bindings
      WHERE provider = ? AND project_id = ? AND server_name = ? AND field_kind = ?`).all(provider, projectId, serverName, kind) as Array<{ credential_id: string }>;
    this.database.prepare(`DELETE FROM credential_vault_mcp_bindings
      WHERE provider = ? AND project_id = ? AND server_name = ? AND field_kind = ?`).run(provider, projectId, serverName, kind);
    const references: Record<string, string> = {};
    for (const [fieldName, value] of Object.entries(values)) {
      if (!fieldName.trim() || !value) throw new Error(`${kind} 자격증명 이름과 값은 비어 있을 수 없습니다.`);
      if (value.includes("\0")) throw new Error("자격증명 값에는 NUL 문자를 넣을 수 없습니다.");
      if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) throw new Error("MCP env 이름은 유효한 환경변수 이름이어야 합니다.");
      if (kind === "header" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(fieldName)) throw new Error("MCP header 이름이 올바르지 않습니다.");
      if (kind === "header" && /[\r\n]/.test(value)) throw new Error("MCP header 값에는 줄바꿈을 넣을 수 없습니다.");
      const envVar = provider === "codex" && kind === "env"
        ? this.validateCodexEnvName(fieldName)
        : this.scopedEnvVar(provider, projectId, serverName, kind, fieldName);
      if (provider === "codex" && kind === "env") this.assertCodexEnvCompatible(projectId, serverName, envVar, value);
      const credentialId = this.put("project", String(projectId), `mcp:${provider}:${serverName}:${kind}`, fieldName, value);
      this.database.prepare(`INSERT INTO credential_vault_mcp_bindings(
        provider, project_id, server_name, field_kind, field_name, env_var, credential_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(provider, projectId, serverName, kind, fieldName, envVar, credentialId);
      references[fieldName] = provider === "codex" && kind === "header" ? envVar : `\${${envVar}}`;
    }
    for (const { credential_id: id } of old) this.database.prepare(`DELETE FROM credential_vault_entries
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM credential_vault_mcp_bindings WHERE credential_id = ?)`).run(id, id);
    return references;
  }

  private validateCodexEnvName(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Codex stdio MCP env 이름은 유효한 환경변수 이름이어야 합니다.");
    return value;
  }

  private assertCodexEnvCompatible(projectId: number, serverName: string, envVar: string, value: string): void {
    const rows = this.database.prepare(`SELECT e.* FROM credential_vault_mcp_bindings b
      JOIN credential_vault_entries e ON e.id = b.credential_id
      WHERE b.provider = 'codex' AND b.project_id = ? AND b.env_var = ? AND b.server_name <> ?`).all(projectId, envVar, serverName) as VaultRow[];
    for (const row of rows) {
      const bytes = this.decrypt(row);
      try {
        if (bytes.toString("utf8") !== value) throw new Error(`Codex MCP 환경변수 ${envVar}가 같은 프로젝트에서 서로 다른 값을 요구합니다.`);
      } finally {
        bytes.fill(0);
      }
    }
  }

  private scopedEnvVar(provider: Provider, projectId: number, server: string, kind: string, name: string): string {
    const digest = crypto.createHash("sha256").update(`${provider}\0${projectId}\0${server}\0${kind}\0${name}`).digest("hex").slice(0, 24).toUpperCase();
    return `WAM_VAULT_${digest}`;
  }

  private requireRow(id: string): VaultRow {
    const row = this.database.prepare("SELECT * FROM credential_vault_entries WHERE id = ?").get(id) as VaultRow | undefined;
    if (!row) throw new Error("vault 자격증명을 찾을 수 없습니다.");
    return row;
  }

  private aad(row: Pick<VaultRow, "id" | "owner_type" | "owner_id" | "purpose" | "secret_name" | "version">): Buffer {
    return Buffer.from(`wam-credential:${row.id}:${row.owner_type}:${row.owner_id}:${row.purpose}:${row.secret_name}:${row.version}`);
  }

  private encrypt(row: Pick<VaultRow, "id" | "owner_type" | "owner_id" | "purpose" | "secret_name" | "version">, value: Buffer): { encryptedValue: string; nonce: string; authTag: string } {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.loadOrCreateKey(), nonce);
    cipher.setAAD(this.aad(row));
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return { encryptedValue: encrypted.toString("base64"), nonce: nonce.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
  }

  private decrypt(row: VaultRow): Buffer {
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.loadOrCreateKey(), Buffer.from(row.nonce, "base64"));
    decipher.setAAD(this.aad(row));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.encrypted_value, "base64")), decipher.final()]);
  }

  private cleanupLeases(): void {
    // 원문·token 없이 접근 주체와 짧은 유효기간만 하루 보존해 장애·오남용을 추적할 수 있게 한다.
    this.database.prepare("DELETE FROM credential_vault_leases WHERE created_at <= datetime('now', '-1 day')").run();
  }

  private loadOrCreateKey(): Buffer {
    const directory = path.dirname(this.keyPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) throw new Error("credential vault key 디렉터리는 소유자 전용이어야 합니다.");
    if (!fs.existsSync(this.keyPath)) {
      if (this.database.prepare("SELECT 1 FROM credential_vault_entries LIMIT 1").get()) throw new Error("기존 credential vault 데이터의 master key가 없습니다.");
      try {
        const descriptor = fs.openSync(this.keyPath, "wx", 0o600);
        try { fs.writeSync(descriptor, crypto.randomBytes(KEY_BYTES)); } finally { fs.closeSync(descriptor); }
      } catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(this.keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== KEY_BYTES || (stat.mode & 0o077) !== 0) throw new Error("credential vault master key가 안전하지 않습니다.");
    return fs.readFileSync(this.keyPath);
  }
}
