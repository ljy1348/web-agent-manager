import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { CredentialVault } from "../src/server/services/credential-vault";
import { RemoteWorkerService } from "../src/server/services/remote-worker";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
const keyAlgorithm = Buffer.from("ssh-ed25519");
const keyAlgorithmLength = Buffer.alloc(4); keyAlgorithmLength.writeUInt32BE(keyAlgorithm.length);
const keyPayloadLength = Buffer.alloc(4); keyPayloadLength.writeUInt32BE(32);
const hostKey = `ssh-ed25519 ${Buffer.concat([keyAlgorithmLength, keyAlgorithm, keyPayloadLength, Buffer.alloc(32, 7)]).toString("base64")}`;
const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nTEST-REMOTE-SECRET\n-----END OPENSSH PRIVATE KEY-----\n";

function fixture(script: string, timeout = 2_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-remote-worker-")); roots.push(root);
  const executable = path.join(root, "fake-ssh.mjs"); fs.writeFileSync(executable, `#!/usr/bin/env node\n${script.replaceAll("__ROOT_JSON__", JSON.stringify(root))}\n`, { mode: 0o700 });
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
  const config: AppConfig = { rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false, sshExecutable: executable, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } };
  const database = openDatabase(config); database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const vault = new CredentialVault(database, dataDir); const service = new RemoteWorkerService(database, config, vault, timeout);
  return { root, dataDir, database, config, vault, service };
}

function create(service: RemoteWorkerService) {
  return service.save(null, { name: "QA worker", hostname: "worker.example.test", port: 2222, username: "wam_worker", workspaceRoot: "/srv/wam/projects", hostKey, privateKey }, 1) as any;
}

function createTask(database: ReturnType<typeof openDatabase>, id = "task-remote-1"): { projectId: number; taskId: string } {
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('Remote project', '/tmp/remote-project')").run().lastInsertRowid);
  const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, tmux_name, title) VALUES (?, 'codex', 'remote-task-chat', 'Remote task')").run(projectId).lastInsertRowid);
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state, goal) VALUES (?, ?, ?, 'running', 'remote fixture')").run(id, chatId, projectId);
  return { projectId, taskId: id };
}

describe("remote worker SSH 고정 probe", () => {
  it("고정 argv·0600 key/known_hosts로 capability만 읽고 secret 원문을 남기지 않는다", async () => {
    const value = fixture(`
      import fs from 'node:fs';
      const args = process.argv.slice(2); const option = (prefix) => args.find((item) => item.startsWith(prefix))?.slice(prefix.length);
      const identity = args[args.indexOf('-i') + 1]; const known = option('UserKnownHostsFile=');
      const required = ['BatchMode=yes','PasswordAuthentication=no','KbdInteractiveAuthentication=no','IdentitiesOnly=yes','StrictHostKeyChecking=yes','ForwardAgent=no','ClearAllForwardings=yes','PermitLocalCommand=no'];
      if (!required.every((item) => args.includes(item)) || args.slice(-4).join(' ') !== 'wam_worker@worker.example.test web-agent-manager-worker capabilities --json') process.exit(21);
      if ((fs.statSync(identity).mode & 0o777) !== 0o600 || (fs.statSync(known).mode & 0o777) !== 0o600) process.exit(22);
      if (!fs.readFileSync(identity, 'utf8').includes('TEST-REMOTE-SECRET') || !fs.readFileSync(known, 'utf8').includes('${hostKey}')) process.exit(23);
      process.stdout.write(JSON.stringify({ protocol: 'wam-worker/v1', version: '1.2.3', capabilities: ['test', 'verify', 'unknown-root-shell'] }));`);
    const host = create(value.service);
    expect(host).toMatchObject({ status: "unverified", keyConfigured: true });
    expect(JSON.stringify(host)).not.toContain("TEST-REMOTE-SECRET");
    const probed = await value.service.probe(host.id) as any;
    expect(probed).toMatchObject({ status: "ready", protocolVersion: "wam-worker/v1", workerVersion: "1.2.3", capabilities: ["test", "verify"] });
    expect(probed.lastLatencyMs).toBeLessThan(2_000);
    const stored = JSON.stringify(value.database.prepare("SELECT * FROM remote_worker_hosts").all()) + JSON.stringify(value.database.prepare("SELECT * FROM credential_vault_entries").all());
    expect(stored).not.toContain("TEST-REMOTE-SECRET");
    expect(fs.readdirSync(path.join(value.dataDir, "remote-worker-tmp"))).toEqual([]);
    const lease = value.database.prepare("SELECT consumer, released_at FROM credential_vault_leases ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(lease.consumer).toContain(`remote-worker:${host.id}:probe`); expect(lease.released_at).not.toBeNull();
    value.database.close();
  });

  it("timeout·비호환 JSON을 상태로 남기고 다음 probe 슬롯을 반환한다", async () => {
    const timeoutValue = fixture("setTimeout(() => process.stdout.write('{}'), 1000);", 100);
    const timeoutHost = create(timeoutValue.service);
    await expect(timeoutValue.service.probe(timeoutHost.id)).rejects.toThrow(/제한 시간/);
    expect(timeoutValue.service.list()[0]).toMatchObject({ status: "unreachable" }); timeoutValue.database.close();

    const invalidValue = fixture("process.stdout.write(JSON.stringify({ protocol: 'other/v1', version: '1', capabilities: [] }));");
    const invalidHost = create(invalidValue.service);
    await expect(invalidValue.service.probe(invalidHost.id)).rejects.toThrow(/호환되지/);
    expect(invalidValue.service.list()[0]).toMatchObject({ status: "incompatible" }); invalidValue.database.close();
  });

  it("hostname·username·host key·private key 형식을 저장 전에 거부한다", () => {
    const value = fixture("process.stdout.write('{}');");
    const base = { name: "bad", hostname: "-oProxyCommand=bad", port: 22, username: "worker", workspaceRoot: "/srv/wam/projects", hostKey, privateKey };
    expect(() => value.service.save(null, base, 1)).toThrow(/hostname/);
    expect(() => value.service.save(null, { ...base, hostname: "host.test", username: "-root" }, 1)).toThrow(/username/);
    expect(() => value.service.save(null, { ...base, hostname: "host.test", hostKey: "ssh-rsa bad" }, 1)).toThrow(/host key/);
    expect(() => value.service.save(null, { ...base, hostname: "host.test", hostKey: `ssh-ed25519 ${Buffer.alloc(40, 7).toString("base64")}` }, 1)).toThrow(/알고리즘/);
    expect(() => value.service.save(null, { ...base, hostname: "host.test", privateKey: "secret" }, 1)).toThrow(/private key/);
    expect(() => value.service.save(null, { ...base, hostname: "host.test", enabled: 0 }, 1)).toThrow(/boolean/);
    expect(() => value.service.save(null, { ...base, hostname: "::::" }, 1)).toThrow(/hostname/);
    expect(() => value.service.save(null, { ...base, hostname: "host.test", workspaceRoot: "/" }, 1)).toThrow(/workspace root/);
    expect(() => value.service.save(null, { ...base, hostname: "host.test", workspaceRoot: "/srv/../etc" }, 1)).toThrow(/workspace root/);
    expect(value.service.list()).toEqual([]); value.database.close();
  });

  it("workspace 내부 mapping의 선언 capability만 고정 task argv로 한 번 dispatch하고 상태를 조회한다", async () => {
    const invocationFileName = "worker-invocations.jsonl";
    const value = fixture(`
      import fs from 'node:fs';
      const args = process.argv.slice(2); fs.appendFileSync(__ROOT_JSON__ + '/' + ${JSON.stringify(invocationFileName)}, JSON.stringify(args) + '\\n');
      if (args.slice(-2).join(' ') === 'capabilities --json') {
        process.stdout.write(JSON.stringify({ protocol: 'wam-worker/v1', version: '2.0.0', capabilities: ['test', 'verify'] }));
      } else if (args.includes('start')) {
        const encoded = args[args.indexOf('--request-base64') + 1]; const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (request.protocol !== 'wam-worker/v1' || request.capability !== 'verify' || request.projectPath !== '/srv/wam/projects/app' || Object.keys(request).sort().join(',') !== 'capability,projectPath,protocol,requestId,taskId') process.exit(31);
        process.stdout.write(JSON.stringify({ protocol: 'wam-worker/v1', requestId: request.requestId, dispatchId: 'remote-run-123', state: 'running', summary: 'verification queued' }));
      } else if (args.includes('status')) {
        if (args[args.indexOf('--dispatch-id') + 1] !== 'remote-run-123') process.exit(32);
        process.stdout.write(JSON.stringify({ protocol: 'wam-worker/v1', dispatchId: 'remote-run-123', state: 'completed', summary: 'all checks passed' }));
      } else process.exit(33);`);
    const invocationFile = path.join(value.root, invocationFileName);
    const host = create(value.service); await value.service.probe(host.id);
    const { projectId, taskId } = createTask(value.database);
    expect(() => value.service.saveMapping(projectId, { hostId: host.id, remotePath: "/srv/wam/elsewhere" }, 1)).toThrow(/workspace root/);
    expect(() => value.service.saveMapping(projectId, { hostId: host.id, remotePath: "/srv/wam/projects//app" }, 1)).toThrow(/정규화/);
    const mapping = value.service.saveMapping(projectId, { hostId: host.id, remotePath: "/srv/wam/projects/app", enabled: true }, 1) as any;
    expect(mapping).toMatchObject({ projectId, hostId: host.id, remotePath: "/srv/wam/projects/app", hostStatus: "ready", capabilities: ["test", "verify"] });
    expect(() => value.service.save(host.id, { workspaceRoot: "/srv/other" } as any, 1)).toThrow(/기존 project mapping/);

    const startedAt = performance.now();
    const first = await value.service.dispatch(taskId, "verify", "dispatch-key-1", 1);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(first).toMatchObject({ replayed: false, dispatch: { taskId, capability: "verify", state: "running", remoteDispatchId: "remote-run-123", summary: "verification queued" } });
    const replay = await value.service.dispatch(taskId, "verify", "dispatch-key-1", 1);
    expect(replay).toMatchObject({ replayed: true, dispatch: { id: (first.dispatch as any).id, state: "running" } });
    const refreshed = await value.service.refreshDispatch(taskId, String((first.dispatch as any).id));
    expect(refreshed).toMatchObject({ state: "completed", remoteDispatchId: "remote-run-123", summary: "all checks passed" });
    const invocations = fs.readFileSync(invocationFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(invocations).toHaveLength(3);
    expect(invocations[1].slice(-7, -1)).toEqual(["web-agent-manager-worker", "tasks", "start", "--protocol", "wam-worker/v1", "--request-base64"]);
    expect(invocations[2].slice(-7)).toEqual(["web-agent-manager-worker", "tasks", "status", "--protocol", "wam-worker/v1", "--dispatch-id", "remote-run-123"]);
    const events = value.database.prepare("SELECT type, payload_json FROM agent_task_events WHERE task_id=? ORDER BY sequence").all(taskId) as Array<{ type: string; payload_json: string }>;
    expect(events.map((event) => event.type)).toEqual(["task.remote_dispatch_requested", "task.remote_dispatch_updated", "task.remote_dispatch_updated"]);
    expect(JSON.stringify(events)).not.toContain("/srv/wam/projects/app");
    expect(JSON.stringify(value.service.listDispatches(taskId))).not.toContain(privateKey);
    value.database.close();
  });

  it("timeout 뒤 delivery_unknown을 보존하고 같은 멱등 키를 자동 재전송하지 않는다", async () => {
    const countFileName = "dispatch-count";
    const value = fixture(`
      import fs from 'node:fs'; const args = process.argv.slice(2);
      if (args.slice(-2).join(' ') === 'capabilities --json') process.stdout.write(JSON.stringify({ protocol: 'wam-worker/v1', version: '2.0.0', capabilities: ['test'] }));
      else { fs.appendFileSync(__ROOT_JSON__ + '/' + ${JSON.stringify(countFileName)}, '1'); setTimeout(() => process.stdout.write('{}'), 1000); }`, 500);
    const host = create(value.service); await value.service.probe(host.id);
    const { projectId, taskId } = createTask(value.database, "task-remote-unknown");
    value.service.saveMapping(projectId, { hostId: host.id, remotePath: "/srv/wam/projects/app" }, 1);
    const pending = value.service.dispatch(taskId, "test", "unknown-key", 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(value.service.dispatch(taskId, "test", "concurrent-key", 1)).rejects.toThrow(/다른 작업/);
    const unknown = await pending;
    expect(unknown).toMatchObject({ replayed: false, dispatch: { state: "unknown", lastError: expect.stringMatching(/제한 시간/) } });
    const replay = await value.service.dispatch(taskId, "test", "unknown-key", 1);
    expect(replay).toMatchObject({ replayed: true, dispatch: { state: "unknown" } });
    expect(fs.readFileSync(path.join(value.root, countFileName), "utf8")).toBe("1");
    expect(value.database.prepare("SELECT COUNT(*) AS count FROM remote_worker_dispatches WHERE task_id=?").get(taskId)).toEqual({ count: 1 });
    await expect(value.service.refreshDispatch(taskId, String((unknown.dispatch as any).id))).rejects.toThrow(/자동 조회하지/);
    await expect(value.service.dispatch(taskId, "build", "bad-capability", 1)).rejects.toThrow(/선언하지/);
    value.database.close();
  });

  it("재시작 때 ACK 전 dispatch를 한 번만 unknown으로 복구하고 재전송하지 않는다", async () => {
    const value = fixture("process.stdout.write(JSON.stringify({ protocol: 'wam-worker/v1', version: '2.0.0', capabilities: ['test'] }));");
    const host = create(value.service); await value.service.probe(host.id);
    const { projectId, taskId } = createTask(value.database, "task-remote-recovery");
    const mapping = value.service.saveMapping(projectId, { hostId: host.id, remotePath: "/srv/wam/projects/recovery" }, 1) as any;
    value.database.prepare(`INSERT INTO remote_worker_dispatches(id, task_id, mapping_id, host_id, capability, idempotency_key, state, created_by)
      VALUES ('interrupted-dispatch', ?, ?, ?, 'test', 'recovery-key', 'dispatching', 1)`).run(taskId, mapping.id, host.id);
    new RemoteWorkerService(value.database, value.config, value.vault, 2_000);
    expect(value.database.prepare("SELECT state, last_error FROM remote_worker_dispatches WHERE id='interrupted-dispatch'").get()).toEqual({ state: "unknown", last_error: "interrupted_before_ack" });
    const count = () => (value.database.prepare("SELECT COUNT(*) AS count FROM agent_task_events WHERE task_id=? AND idempotency_key='remote-dispatch:interrupted-dispatch:startup-unknown'").get(taskId) as any).count;
    expect(count()).toBe(1);
    new RemoteWorkerService(value.database, value.config, value.vault, 2_000);
    expect(count()).toBe(1);
    const replay = await value.service.dispatch(taskId, "test", "recovery-key", 1);
    expect(replay).toMatchObject({ replayed: true, dispatch: { state: "unknown" } });
    expect(value.database.pragma("foreign_key_check")).toEqual([]);
    value.database.close();
  });
});
