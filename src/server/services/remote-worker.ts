import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { redactVerificationOutput } from "./verification-service";
import type { CredentialVault } from "./credential-vault";

const CAPABILITIES = new Set(["build", "test", "verify", "preview", "artifact-read"]);
const DISPATCH_CAPABILITIES = new Set(["build", "test", "verify", "preview"]);
const DISPATCH_STATES = new Set(["queued", "running", "completed", "failed"]);
const MAX_OUTPUT = 64 * 1024;
const MAX_ACTIVE_PROBES = 4;

interface HostRow {
  id: string; name: string; hostname: string; port: number; username: string; workspace_root: string | null; host_key: string; host_key_fingerprint: string;
  private_key_credential_id: string; enabled: number; status: string; protocol_version: string | null; worker_version: string | null;
  capabilities_json: string; last_latency_ms: number | null; last_error: string | null; last_probed_at: string | null; updated_at: string;
}

export interface RemoteHostInput {
  name: unknown; hostname: unknown; port: unknown; username: unknown; workspaceRoot: unknown; hostKey: unknown; privateKey?: unknown; enabled?: unknown;
}

interface MappingRow {
  id: string; project_id: number; host_id: string; remote_path: string; enabled: number; created_at: string; updated_at: string;
  project_name?: string; host_name?: string; host_status?: string; host_capabilities_json?: string;
}

interface DispatchRow {
  id: string; task_id: string; mapping_id: string; host_id: string; capability: string; idempotency_key: string; state: string;
  remote_dispatch_id: string | null; summary: string | null; last_error: string | null; last_latency_ms: number | null;
  created_at: string; updated_at: string; host_name?: string; project_name?: string;
}

function required(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\0\r\n]/.test(value)) throw new Error(`${label}이(가) 올바르지 않습니다.`);
  return value.trim();
}

function hostFingerprint(hostKey: string): string {
  const [kind, encoded, ...rest] = hostKey.split(/\s+/);
  if (rest.length || !["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"].includes(kind)) {
    throw new Error("SSH host key는 comment 없는 Ed25519 또는 ECDSA 공개키여야 합니다.");
  }
  let bytes: Buffer;
  try { bytes = Buffer.from(encoded, "base64"); } catch { throw new Error("SSH host key base64가 올바르지 않습니다."); }
  if (bytes.length < 32 || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("SSH host key base64가 올바르지 않습니다.");
  const algorithmLength = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
  if (algorithmLength < 1 || algorithmLength > 64 || 4 + algorithmLength > bytes.length || bytes.subarray(4, 4 + algorithmLength).toString("ascii") !== kind) {
    throw new Error("SSH host key의 선언 알고리즘과 key blob이 일치하지 않습니다.");
  }
  return `SHA256:${crypto.createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}

function validHostname(value: string): boolean {
  if (isIP(value)) return true;
  if (value === "localhost") return true;
  return value.length <= 253 && value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function workspacePath(value: unknown, label = "remote workspace root"): string {
  const raw = required(value, label, 1_024).replaceAll("\\", "/");
  if (!raw.startsWith("/") || raw === "/" || raw.split("/").includes("..")) throw new Error(`${label}은(는) /가 아닌 absolute POSIX 경로여야 합니다.`);
  const normalized = path.posix.normalize(raw);
  if (normalized === "/" || !normalized.startsWith("/") || normalized !== raw.replace(/\/$/, "")) throw new Error(`${label}이(가) 정규화된 경로가 아닙니다.`);
  return normalized;
}

function isWithinWorkspace(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

function parseInput(input: RemoteHostInput, requireKey: boolean): { name: string; hostname: string; port: number; username: string; workspaceRoot: string; hostKey: string; fingerprint: string; privateKey?: string; enabled: boolean } {
  const name = required(input.name, "host 이름", 80);
  const hostname = required(input.hostname, "hostname", 253).toLowerCase();
  if (!validHostname(hostname)) throw new Error("hostname 형식이 올바르지 않습니다.");
  const port = Number(input.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SSH port는 1~65535 정수여야 합니다.");
  const username = required(input.username, "SSH username", 32);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username) || username.startsWith("-")) throw new Error("SSH username 형식이 올바르지 않습니다.");
  const hostKey = required(input.hostKey, "SSH host key", 4_096);
  const workspaceRoot = workspacePath(input.workspaceRoot);
  const fingerprint = hostFingerprint(hostKey);
  const privateKey = input.privateKey === undefined ? undefined : String(input.privateKey);
  if (requireKey && !privateKey) throw new Error("전용 SSH private key가 필요합니다.");
  if (privateKey && (privateKey.length > 65_536 || privateKey.includes("\0") || !/^-----BEGIN (?:OPENSSH |EC |)PRIVATE KEY-----\n/.test(privateKey))) {
    throw new Error("SSH private key 형식이 올바르지 않습니다.");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled는 boolean이어야 합니다.");
  return { name, hostname, port, username, workspaceRoot, hostKey, fingerprint, privateKey, enabled: input.enabled !== false };
}

function publicHost(row: HostRow): Record<string, unknown> {
  return { id: row.id, name: row.name, hostname: row.hostname, port: row.port, username: row.username,
    workspaceRoot: row.workspace_root,
    hostKeyFingerprint: row.host_key_fingerprint, keyConfigured: true, enabled: Boolean(row.enabled), status: row.status,
    protocolVersion: row.protocol_version, workerVersion: row.worker_version, capabilities: JSON.parse(row.capabilities_json || "[]"),
    lastLatencyMs: row.last_latency_ms, lastError: row.last_error, lastProbedAt: row.last_probed_at, updatedAt: row.updated_at };
}

function publicMapping(row: MappingRow): Record<string, unknown> {
  return { id: row.id, projectId: row.project_id, projectName: row.project_name ?? null, hostId: row.host_id,
    hostName: row.host_name ?? null, remotePath: row.remote_path, enabled: Boolean(row.enabled), hostStatus: row.host_status ?? null,
    capabilities: JSON.parse(row.host_capabilities_json || "[]"), createdAt: row.created_at, updatedAt: row.updated_at };
}

function publicDispatch(row: DispatchRow): Record<string, unknown> {
  return { id: row.id, taskId: row.task_id, mappingId: row.mapping_id, hostId: row.host_id, hostName: row.host_name ?? null,
    projectName: row.project_name ?? null, capability: row.capability, state: row.state, remoteDispatchId: row.remote_dispatch_id,
    summary: row.summary, lastError: row.last_error, lastLatencyMs: row.last_latency_ms, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class RemoteWorkerService {
  private readonly activeHosts = new Set<string>();
  private activeProbes = 0;

  constructor(private readonly database: AppDatabase, private readonly config: AppConfig, private readonly vault: CredentialVault, private readonly timeoutMs = 10_000) {
    this.recoverInterruptedDispatches();
  }

  list(): Array<Record<string, unknown>> {
    return (this.database.prepare("SELECT * FROM remote_worker_hosts ORDER BY name, id").all() as HostRow[]).map(publicHost);
  }

  listMappings(): Array<Record<string, unknown>> {
    return (this.database.prepare(`SELECT m.*, p.name AS project_name, h.name AS host_name, h.status AS host_status,
      h.capabilities_json AS host_capabilities_json FROM remote_worker_project_mappings m
      JOIN projects p ON p.id=m.project_id JOIN remote_worker_hosts h ON h.id=m.host_id ORDER BY p.name, m.id`).all() as MappingRow[]).map(publicMapping);
  }

  saveMapping(projectId: number, raw: { hostId?: unknown; remotePath?: unknown; enabled?: unknown }, userId: number): Record<string, unknown> {
    if (!Number.isInteger(projectId) || projectId < 1) throw new Error("유효한 프로젝트 ID가 필요합니다.");
    const project = this.database.prepare("SELECT id FROM projects WHERE id=? AND active=1").get(projectId);
    if (!project) throw new Error("활성 프로젝트를 찾을 수 없습니다.");
    const hostId = required(raw.hostId, "remote worker host", 100);
    const host = this.requireHost(hostId);
    if (!host.enabled) throw Object.assign(new Error("비활성 remote worker에는 프로젝트를 연결할 수 없습니다."), { statusCode: 409 });
    if (!host.workspace_root) throw Object.assign(new Error("host의 remote workspace root를 먼저 설정해야 합니다."), { statusCode: 409 });
    const remotePath = workspacePath(raw.remotePath, "remote project path");
    if (!isWithinWorkspace(host.workspace_root, remotePath)) throw new Error("remote project path는 host workspace root 내부여야 합니다.");
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled는 boolean이어야 합니다.");
    const existing = this.database.prepare("SELECT id FROM remote_worker_project_mappings WHERE project_id=?").get(projectId) as { id: string } | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    this.database.prepare(`INSERT INTO remote_worker_project_mappings(id, project_id, host_id, remote_path, enabled, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET host_id=excluded.host_id, remote_path=excluded.remote_path,
      enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
      .run(id, projectId, hostId, remotePath, raw.enabled === false ? 0 : 1, userId, userId);
    return publicMapping(this.requireMappingForProject(projectId));
  }

  removeMapping(projectId: number): void {
    const result = this.database.prepare("DELETE FROM remote_worker_project_mappings WHERE project_id=?").run(projectId);
    if (!result.changes) throw new Error("프로젝트의 remote mapping을 찾을 수 없습니다.");
  }

  listDispatches(taskId: string): { mapping: Record<string, unknown> | null; dispatches: Array<Record<string, unknown>> } {
    const task = this.requireTask(taskId);
    const mapping = this.mappingForProject(task.project_id);
    const rows = this.database.prepare(`SELECT d.*, h.name AS host_name, p.name AS project_name FROM remote_worker_dispatches d
      JOIN remote_worker_hosts h ON h.id=d.host_id JOIN agent_tasks t ON t.id=d.task_id JOIN projects p ON p.id=t.project_id
      WHERE d.task_id=? ORDER BY d.created_at DESC, d.id DESC LIMIT 20`).all(taskId) as DispatchRow[];
    return { mapping: mapping ? publicMapping(mapping) : null, dispatches: rows.map(publicDispatch) };
  }

  async dispatch(taskId: string, capabilityValue: unknown, idempotencyValue: unknown, userId: number): Promise<{ dispatch: Record<string, unknown>; replayed: boolean }> {
    const capability = required(capabilityValue, "remote capability", 32);
    if (!DISPATCH_CAPABILITIES.has(capability)) throw new Error("허용되지 않은 remote capability입니다.");
    const idempotencyKey = required(idempotencyValue, "Idempotency-Key", 160);
    if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new Error("Idempotency-Key 형식이 올바르지 않습니다.");
    const existing = this.database.prepare("SELECT * FROM remote_worker_dispatches WHERE task_id=? AND idempotency_key=?").get(taskId, idempotencyKey) as DispatchRow | undefined;
    if (existing) return { dispatch: publicDispatch(existing), replayed: true };
    const task = this.requireTask(taskId);
    if (["cancelled", "budget_exceeded"].includes(task.state)) throw Object.assign(new Error("종료된 task는 remote dispatch할 수 없습니다."), { statusCode: 409 });
    const mapping = this.mappingForProject(task.project_id);
    if (!mapping || !mapping.enabled) throw Object.assign(new Error("이 프로젝트에 활성 remote mapping이 없습니다."), { statusCode: 409 });
    const host = this.requireHost(mapping.host_id);
    this.assertDispatchReady(host, capability);
    if (this.activeHosts.has(host.id)) throw Object.assign(new Error("remote worker에서 다른 작업이 진행 중입니다."), { statusCode: 409 });
    if (this.activeProbes >= MAX_ACTIVE_PROBES) throw Object.assign(new Error("remote worker 동시 실행 상한에 도달했습니다."), { statusCode: 429 });
    this.activeHosts.add(host.id); this.activeProbes += 1;
    const id = crypto.randomUUID();
    try {
      this.database.transaction(() => {
        this.database.prepare(`INSERT INTO remote_worker_dispatches(id, task_id, mapping_id, host_id, capability, idempotency_key, state, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'dispatching', ?)`).run(id, taskId, mapping.id, host.id, capability, idempotencyKey, userId);
        this.appendTaskEvent(taskId, `remote-dispatch:${id}:requested`, "task.remote_dispatch_requested", { dispatchId: id, mappingId: mapping.id, hostId: host.id, capability });
      })();
    } catch (error) {
      this.activeHosts.delete(host.id); this.activeProbes -= 1;
      throw error;
    }
    const startedAt = performance.now();
    try {
      const requestPayload = Buffer.from(JSON.stringify({ protocol: "wam-worker/v1", requestId: id, taskId, capability, projectPath: mapping.remote_path }), "utf8").toString("base64url");
      let output = "";
      await this.vault.withSecret(host.private_key_credential_id, `remote-worker:${host.id}:dispatch`, async (privateKey) => {
        output = await this.runWorker(host, privateKey, ["tasks", "start", "--protocol", "wam-worker/v1", "--request-base64", requestPayload], "dispatch");
      });
      const result = this.parseDispatchResponse(output, id);
      const latency = Math.round(performance.now() - startedAt);
      this.database.transaction(() => {
        this.database.prepare(`UPDATE remote_worker_dispatches SET state=?, remote_dispatch_id=?, summary=?, last_error=NULL,
          last_latency_ms=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(result.state, result.dispatchId, result.summary, latency, id);
        this.appendTaskEvent(taskId, `remote-dispatch:${id}:accepted`, "task.remote_dispatch_updated", { dispatchId: id, hostId: host.id, capability, state: result.state, remoteDispatchId: result.dispatchId, latencyMs: latency });
      })();
      return { dispatch: publicDispatch(this.requireDispatch(id)), replayed: false };
    } catch (error) {
      return this.markDispatchUnknown(id, taskId, this.safeWorkerError(error), Math.round(performance.now() - startedAt));
    } finally {
      this.activeHosts.delete(host.id); this.activeProbes -= 1;
    }
  }

  async refreshDispatch(taskId: string, id: string): Promise<Record<string, unknown>> {
    const dispatch = this.requireDispatch(id);
    if (dispatch.task_id !== taskId) throw new Error("remote dispatch가 task와 일치하지 않습니다.");
    if (!dispatch.remote_dispatch_id) throw Object.assign(new Error("수락 여부가 불명확한 dispatch는 자동 조회하지 않습니다."), { statusCode: 409 });
    if (["completed", "failed"].includes(dispatch.state)) return publicDispatch(dispatch);
    const host = this.requireHost(dispatch.host_id);
    this.assertDispatchReady(host, dispatch.capability);
    if (this.activeHosts.has(host.id)) throw Object.assign(new Error("remote worker에서 다른 작업이 진행 중입니다."), { statusCode: 409 });
    if (this.activeProbes >= MAX_ACTIVE_PROBES) throw Object.assign(new Error("remote worker 동시 실행 상한에 도달했습니다."), { statusCode: 429 });
    this.activeHosts.add(host.id); this.activeProbes += 1;
    const startedAt = performance.now();
    try {
      let output = "";
      await this.vault.withSecret(host.private_key_credential_id, `remote-worker:${host.id}:status`, async (privateKey) => {
        output = await this.runWorker(host, privateKey, ["tasks", "status", "--protocol", "wam-worker/v1", "--dispatch-id", dispatch.remote_dispatch_id!], "status");
      });
      const result = this.parseDispatchResponse(output, undefined, dispatch.remote_dispatch_id);
      const latency = Math.round(performance.now() - startedAt);
      this.database.transaction(() => {
        this.database.prepare("UPDATE remote_worker_dispatches SET state=?, summary=?, last_error=NULL, last_latency_ms=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(result.state, result.summary, latency, id);
        this.appendTaskEvent(taskId, `remote-dispatch:${id}:refresh:${crypto.randomUUID()}`, "task.remote_dispatch_updated", { dispatchId: id, hostId: host.id, capability: dispatch.capability, state: result.state, remoteDispatchId: dispatch.remote_dispatch_id, latencyMs: latency });
      })();
      return publicDispatch(this.requireDispatch(id));
    } catch (error) {
      const message = this.safeWorkerError(error);
      this.database.prepare("UPDATE remote_worker_dispatches SET last_error=?, last_latency_ms=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(message, Math.round(performance.now() - startedAt), id);
      throw Object.assign(new Error(message), { statusCode: 409 });
    } finally {
      this.activeHosts.delete(host.id); this.activeProbes -= 1;
    }
  }

  save(id: string | null, raw: RemoteHostInput, userId: number): Record<string, unknown> {
    if (id && this.activeHosts.has(id)) throw Object.assign(new Error("probe 중인 host는 수정할 수 없습니다."), { statusCode: 409 });
    const existing = id ? this.database.prepare("SELECT * FROM remote_worker_hosts WHERE id = ?").get(id) as HostRow | undefined : undefined;
    if (id && !existing) throw new Error("원격 worker host를 찾을 수 없습니다.");
    const input = parseInput(existing ? {
      ...raw,
      name: raw.name ?? existing.name,
      hostname: raw.hostname ?? existing.hostname,
      port: raw.port ?? existing.port,
      username: raw.username ?? existing.username,
      workspaceRoot: raw.workspaceRoot ?? existing.workspace_root,
      hostKey: raw.hostKey ?? existing.host_key,
      enabled: raw.enabled ?? Boolean(existing.enabled),
    } : raw, !existing);
    if (existing) {
      const mappings = this.database.prepare("SELECT remote_path FROM remote_worker_project_mappings WHERE host_id=?").all(existing.id) as Array<{ remote_path: string }>;
      if (mappings.some((mapping) => !isWithinWorkspace(input.workspaceRoot, mapping.remote_path))) {
        throw Object.assign(new Error("기존 project mapping이 새 workspace root 밖에 있어 host를 변경할 수 없습니다."), { statusCode: 409 });
      }
    }
    const hostId = existing?.id ?? crypto.randomUUID();
    this.database.transaction(() => {
      let credentialId = existing?.private_key_credential_id;
      if (input.privateKey) credentialId = this.vault.put("system", hostId, "remote-worker:ssh-private-key", "identity", input.privateKey);
      this.database.prepare(`INSERT INTO remote_worker_hosts(id, name, hostname, port, username, workspace_root, host_key, host_key_fingerprint, private_key_credential_id, enabled, status, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, hostname=excluded.hostname, port=excluded.port, username=excluded.username, workspace_root=excluded.workspace_root,
          host_key=excluded.host_key, host_key_fingerprint=excluded.host_key_fingerprint, private_key_credential_id=excluded.private_key_credential_id,
          enabled=excluded.enabled, status='unverified', protocol_version=NULL, worker_version=NULL, capabilities_json='[]', last_latency_ms=NULL,
          last_error=NULL, last_probed_at=NULL, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
        .run(hostId, input.name, input.hostname, input.port, input.username, input.workspaceRoot, input.hostKey, input.fingerprint, credentialId, input.enabled ? 1 : 0, userId, userId);
    })();
    return publicHost(this.requireHost(hostId));
  }

  remove(id: string): void {
    if (this.activeHosts.has(id)) throw Object.assign(new Error("probe 중인 host는 삭제할 수 없습니다."), { statusCode: 409 });
    const host = this.requireHost(id);
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM remote_worker_hosts WHERE id = ?").run(id);
      this.vault.remove(host.private_key_credential_id);
    })();
  }

  async probe(id: string): Promise<Record<string, unknown>> {
    const host = this.requireHost(id);
    if (!host.enabled) throw Object.assign(new Error("비활성 remote worker는 probe할 수 없습니다."), { statusCode: 409 });
    if (this.activeHosts.has(id)) throw Object.assign(new Error("이 host의 probe가 이미 진행 중입니다."), { statusCode: 409 });
    if (this.activeProbes >= MAX_ACTIVE_PROBES) throw Object.assign(new Error("remote worker probe 동시 실행 상한에 도달했습니다."), { statusCode: 429 });
    this.activeHosts.add(id); this.activeProbes += 1;
    const startedAt = performance.now();
    try {
      let output = "";
      await this.vault.withSecret(host.private_key_credential_id, `remote-worker:${id}:probe`, async (privateKey) => {
        output = await this.runProbe(host, privateKey);
      });
      let parsed: any;
      try { parsed = JSON.parse(output); } catch { throw Object.assign(new Error("remote worker가 유효한 JSON을 반환하지 않았습니다."), { incompatible: true }); }
      const capabilities = Array.isArray(parsed.capabilities) ? [...new Set(parsed.capabilities.filter((item: unknown) => typeof item === "string" && CAPABILITIES.has(item)))] : [];
      if (parsed.protocol !== "wam-worker/v1" || typeof parsed.version !== "string" || !parsed.version || parsed.version.length > 64 || !Array.isArray(parsed.capabilities)) {
        throw Object.assign(new Error("remote worker protocol이 wam-worker/v1과 호환되지 않습니다."), { incompatible: true });
      }
      const latency = Math.round(performance.now() - startedAt);
      this.database.prepare(`UPDATE remote_worker_hosts SET status='ready', protocol_version='wam-worker/v1', worker_version=?, capabilities_json=?,
        last_latency_ms=?, last_error=NULL, last_probed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(parsed.version, JSON.stringify(capabilities), latency, id);
      return publicHost(this.requireHost(id));
    } catch (error) {
      const message = redactVerificationOutput(error instanceof Error ? error.message : String(error), this.config.homeDir).text.slice(0, 500);
      const incompatible = Boolean((error as { incompatible?: boolean })?.incompatible);
      this.database.prepare(`UPDATE remote_worker_hosts SET status=?, protocol_version=NULL, worker_version=NULL, capabilities_json='[]',
        last_latency_ms=?, last_error=?, last_probed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(incompatible ? "incompatible" : "unreachable", Math.round(performance.now() - startedAt), message, id);
      throw Object.assign(new Error(message), { statusCode: 409 });
    } finally {
      this.activeHosts.delete(id); this.activeProbes -= 1;
    }
  }

  private requireHost(id: string): HostRow {
    const row = this.database.prepare("SELECT * FROM remote_worker_hosts WHERE id = ?").get(id) as HostRow | undefined;
    if (!row) throw new Error("원격 worker host를 찾을 수 없습니다.");
    return row;
  }

  private requireTask(id: string): { id: string; project_id: number; state: string } {
    if (!id || id.length > 100 || /[\0\r\n]/.test(id)) throw new Error("유효한 task ID가 필요합니다.");
    const row = this.database.prepare("SELECT id, project_id, state FROM agent_tasks WHERE id=?").get(id) as { id: string; project_id: number; state: string } | undefined;
    if (!row) throw new Error("task를 찾을 수 없습니다.");
    return row;
  }

  private mappingForProject(projectId: number): MappingRow | undefined {
    return this.database.prepare(`SELECT m.*, p.name AS project_name, h.name AS host_name, h.status AS host_status,
      h.capabilities_json AS host_capabilities_json FROM remote_worker_project_mappings m
      JOIN projects p ON p.id=m.project_id JOIN remote_worker_hosts h ON h.id=m.host_id WHERE m.project_id=?`).get(projectId) as MappingRow | undefined;
  }

  private requireMappingForProject(projectId: number): MappingRow {
    const row = this.mappingForProject(projectId);
    if (!row) throw new Error("프로젝트의 remote mapping을 찾을 수 없습니다.");
    return row;
  }

  private requireDispatch(id: string): DispatchRow {
    if (!id || id.length > 100 || /[\0\r\n]/.test(id)) throw new Error("유효한 remote dispatch ID가 필요합니다.");
    const row = this.database.prepare(`SELECT d.*, h.name AS host_name, p.name AS project_name FROM remote_worker_dispatches d
      JOIN remote_worker_hosts h ON h.id=d.host_id JOIN agent_tasks t ON t.id=d.task_id JOIN projects p ON p.id=t.project_id WHERE d.id=?`).get(id) as DispatchRow | undefined;
    if (!row) throw new Error("remote dispatch를 찾을 수 없습니다.");
    return row;
  }

  private assertDispatchReady(host: HostRow, capability: string): void {
    if (!host.enabled || !host.workspace_root || host.status !== "ready" || host.protocol_version !== "wam-worker/v1") {
      throw Object.assign(new Error("remote worker가 mapping dispatch 준비 상태가 아닙니다."), { statusCode: 409 });
    }
    const capabilities = JSON.parse(host.capabilities_json || "[]") as unknown;
    if (!Array.isArray(capabilities) || !capabilities.includes(capability)) throw Object.assign(new Error("remote worker가 요청 capability를 선언하지 않았습니다."), { statusCode: 409 });
  }

  private parseDispatchResponse(output: string, requestId?: string, expectedDispatchId?: string): { dispatchId: string; state: string; summary: string | null } {
    let parsed: any;
    try { parsed = JSON.parse(output); } catch { throw new Error("remote worker가 유효한 task JSON을 반환하지 않았습니다."); }
    if (parsed.protocol !== "wam-worker/v1" || (requestId && parsed.requestId !== requestId)) throw new Error("remote worker task 응답 protocol/request가 일치하지 않습니다.");
    if (typeof parsed.dispatchId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(parsed.dispatchId) || expectedDispatchId && parsed.dispatchId !== expectedDispatchId) {
      throw new Error("remote worker dispatch ID가 올바르지 않습니다.");
    }
    if (typeof parsed.state !== "string" || !DISPATCH_STATES.has(parsed.state)) throw new Error("remote worker task 상태가 올바르지 않습니다.");
    const summary = typeof parsed.summary === "string"
      ? redactVerificationOutput(parsed.summary, this.config.homeDir).text.slice(0, 500)
      : null;
    return { dispatchId: parsed.dispatchId, state: parsed.state, summary };
  }

  private appendTaskEvent(taskId: string, idempotencyKey: string, type: string, payload: Record<string, unknown>): void {
    const sequence = Number((this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM agent_task_events WHERE task_id=?").get(taskId) as { value: number }).value);
    this.database.prepare("INSERT INTO agent_task_events(id, task_id, sequence, idempotency_key, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, sequence, idempotencyKey, type, JSON.stringify(payload));
  }

  private safeWorkerError(error: unknown): string {
    return redactVerificationOutput(error instanceof Error ? error.message : String(error), this.config.homeDir).text.slice(0, 500);
  }

  private recoverInterruptedDispatches(): void {
    const rows = this.database.prepare("SELECT id, task_id FROM remote_worker_dispatches WHERE state='dispatching'").all() as Array<{ id: string; task_id: string }>;
    if (!rows.length) return;
    this.database.transaction(() => {
      for (const row of rows) {
        this.database.prepare("UPDATE remote_worker_dispatches SET state='unknown', last_error='interrupted_before_ack', updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='dispatching'").run(row.id);
        this.appendTaskEvent(row.task_id, `remote-dispatch:${row.id}:startup-unknown`, "task.remote_dispatch_updated", { dispatchId: row.id, state: "unknown", errorCode: "interrupted_before_ack" });
      }
    })();
  }

  private markDispatchUnknown(id: string, taskId: string, message: string, latency = 0): { dispatch: Record<string, unknown>; replayed: boolean } {
    const safe = this.safeWorkerError(message);
    this.database.transaction(() => {
      this.database.prepare("UPDATE remote_worker_dispatches SET state='unknown', last_error=?, last_latency_ms=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(safe, latency, id);
      this.appendTaskEvent(taskId, `remote-dispatch:${id}:unknown`, "task.remote_dispatch_updated", { dispatchId: id, state: "unknown", errorCode: "delivery_unknown", latencyMs: latency });
    })();
    return { dispatch: publicDispatch(this.requireDispatch(id)), replayed: false };
  }

  private sshExecutable(): string {
    const executable = fs.realpathSync(this.config.sshExecutable ?? "/usr/bin/ssh");
    const stat = fs.statSync(executable);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0) throw new Error("SSH 실행 파일은 다른 사용자가 쓸 수 없는 일반 파일이어야 합니다.");
    return executable;
  }

  private async runProbe(host: HostRow, privateKey: string): Promise<string> {
    return this.runWorker(host, privateKey, ["capabilities", "--json"], "probe");
  }

  private async runWorker(host: HostRow, privateKey: string, workerArgs: string[], purpose: string): Promise<string> {
    const tempRoot = path.join(this.config.dataDir, "remote-worker-tmp");
    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(tempRoot, 0o700);
    const directory = fs.mkdtempSync(path.join(tempRoot, `${purpose}-`)); fs.chmodSync(directory, 0o700);
    const identity = path.join(directory, "identity");
    const knownHosts = path.join(directory, "known_hosts");
    try {
      fs.writeFileSync(identity, privateKey, { flag: "wx", mode: 0o600 });
      const pin = `${host.host_key}\n`;
      fs.writeFileSync(knownHosts, `${host.hostname} ${pin}[${host.hostname}]:${host.port} ${pin}`, { flag: "wx", mode: 0o600 });
      const args = ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
        "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1",
        "-p", String(host.port), "-i", identity, "--", `${host.username}@${host.hostname}`, "web-agent-manager-worker", ...workerArgs];
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(this.sshExecutable(), args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = ""; let stderr = ""; let exceeded = false; let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, this.timeoutMs);
        const add = (current: string, chunk: Buffer): string => { const next = current + chunk.toString("utf8"); if (Buffer.byteLength(next) > MAX_OUTPUT) { exceeded = true; child.kill("SIGKILL"); } return next.slice(0, MAX_OUTPUT); };
        child.stdout.on("data", (chunk: Buffer) => { stdout = add(stdout, chunk); }); child.stderr.on("data", (chunk: Buffer) => { stderr = add(stderr, chunk); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => { clearTimeout(timer); if (timedOut) reject(new Error("remote worker 작업이 제한 시간 안에 응답하지 않았습니다."));
          else if (exceeded) reject(new Error("remote worker 응답이 64KiB를 초과했습니다.")); else if (code !== 0) reject(new Error((stderr || `SSH 종료 코드 ${code}`).trim())); else resolve(stdout.trim()); });
      });
    } finally {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* 매 probe 전용 디렉터리만 정리한다. */ }
    }
  }
}
