import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { createRemoteWorkerRouter } from "../src/server/routes/remote-worker-routes";
import { CredentialVault } from "../src/server/services/credential-vault";
import { RemoteWorkerService } from "../src/server/services/remote-worker";

const keyAlgorithm = Buffer.from("ssh-ed25519");
const keyAlgorithmLength = Buffer.alloc(4); keyAlgorithmLength.writeUInt32BE(keyAlgorithm.length);
const keyPayloadLength = Buffer.alloc(4); keyPayloadLength.writeUInt32BE(32);
const hostKey = `ssh-ed25519 ${Buffer.concat([keyAlgorithmLength, keyAlgorithm, keyPayloadLength, Buffer.alloc(32, 8)]).toString("base64")}`;
const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nROUTE-PRIVATE-MARKER\n-----END OPENSSH PRIVATE KEY-----\n";
const roots: string[] = [];
const databases: AppDatabase[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (databases.length) databases.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

async function fixture(trusted = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-remote-routes-")); roots.push(root);
  const executable = path.join(root, "fake-ssh.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.slice(-2).join(' ')==='capabilities --json') process.stdout.write(JSON.stringify({protocol:'wam-worker/v1',version:'3.0.0',capabilities:['test']}));
else { const encoded=args[args.indexOf('--request-base64')+1]; const input=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')); if(input.command||input.projectPath!=='/srv/wam/projects/api') process.exit(41); process.stdout.write(JSON.stringify({protocol:'wam-worker/v1',requestId:input.requestId,dispatchId:'api-remote-1',state:'queued',summary:'queued safely'})); }
`, { mode: 0o700 });
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
  const config = { rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:0", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false, sshExecutable: executable, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } } as AppConfig;
  const database = openDatabase(config); databases.push(database);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('API project', '/tmp/api-project')").run().lastInsertRowid);
  const chatId = Number(database.prepare("INSERT INTO chats(project_id, provider, tmux_name, title) VALUES (?, 'codex', 'api-remote-chat', 'API remote')").run(projectId).lastInsertRowid);
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state) VALUES ('api-task', ?, ?, 'running')").run(chatId, projectId);
  const service = new RemoteWorkerService(database, config, new CredentialVault(database, dataDir), 2_000);
  const host = service.save(null, { name: "API worker", hostname: "worker.example.test", port: 22, username: "wam_worker", workspaceRoot: "/srv/wam/projects", hostKey, privateKey }, 1) as any;
  await service.probe(host.id);
  const app = express(); app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => { request.authUser = { id: 1, username: "admin", role: "admin", access_scope: "standard" }; request.trustedNetwork = trusted; next(); });
  app.use("/api", createRemoteWorkerRouter(database, service));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(Number((error as any)?.statusCode) || 400).json({ error: error instanceof Error ? error.message : "error" }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  closers.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { database, projectId, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("remote worker mapping/dispatch API", () => {
  it("고정 mapping과 task dispatch를 202로 접수하고 replay와 최소 감사를 보존한다", async () => {
    const { database, projectId, base } = await fixture();
    const hostId = String((database.prepare("SELECT id FROM remote_worker_hosts").get() as any).id);
    const mappingResponse = await fetch(`${base}/api/projects/${projectId}/remote-worker-mapping`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId, remotePath: "/srv/wam/projects/api", enabled: true }) });
    expect(mappingResponse.status).toBe(200);
    const mapping = (await mappingResponse.json()).mapping;
    expect(mapping).toMatchObject({ projectId, hostId, remotePath: "/srv/wam/projects/api" });

    const options = { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "api-key-1" }, body: JSON.stringify({ capability: "test", command: "rm -rf /" }) };
    const first = await fetch(`${base}/api/tasks/api-task/remote-dispatches`, options);
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ replayed: false, dispatch: { state: "queued", remoteDispatchId: "api-remote-1", capability: "test" } });
    const replay = await fetch(`${base}/api/tasks/api-task/remote-dispatches`, options);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ replayed: true, dispatch: { id: firstBody.dispatch.id } });
    const listed = await fetch(`${base}/api/tasks/api-task/remote-dispatches`);
    await expect(listed.json()).resolves.toMatchObject({ mapping: { id: mapping.id }, dispatches: [{ id: firstBody.dispatch.id }] });

    const audit = JSON.stringify(database.prepare("SELECT action, target_type, target_id, details FROM audit_logs ORDER BY id").all());
    expect(audit).toContain("remote_worker.mapping.update"); expect(audit).toContain("remote_worker.dispatch");
    expect(audit).not.toContain("/srv/wam/projects/api"); expect(audit).not.toContain("rm -rf"); expect(audit).not.toContain("ROUTE-PRIVATE-MARKER");
  });

  it("신뢰하지 않은 네트워크는 mapping·dispatch 전에 차단한다", async () => {
    const { database, projectId, base } = await fixture(false);
    const hostId = String((database.prepare("SELECT id FROM remote_worker_hosts").get() as any).id);
    const mapping = await fetch(`${base}/api/projects/${projectId}/remote-worker-mapping`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId, remotePath: "/srv/wam/projects/api", enabled: true }) });
    const dispatch = await fetch(`${base}/api/tasks/api-task/remote-dispatches`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": "blocked" }, body: JSON.stringify({ capability: "test" }) });
    expect([mapping.status, dispatch.status]).toEqual([403, 403]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_worker_project_mappings").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_worker_dispatches").get()).toEqual({ count: 0 });
  });
});
