import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express, { type NextFunction, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { requireAuth, requireCsrf, type AuthenticatedRequest } from "../src/server/core/auth";
import { authenticateFederationAgent, createFederationAgentToken, FederationService } from "../src/server/services/federation";
import { CredentialVault } from "../src/server/services/credential-vault";
import { GithubProjectService } from "../src/server/services/github-projects";
import { ProjectTransferReceiver, ProjectTransferSender, scanProject } from "../src/server/services/project-transfer";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { createProjectTransferRouter } from "../src/server/routes/project-transfer-routes";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function put(root: string, relative: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content, mode ? { mode } : undefined);
}

// Git 밖 파일·실행 권한·symlink·재구성 대상 환경이 섞인 원본 프로젝트.
function sourceProject(): string {
  const root = tempDir("wam-transfer-src-");
  put(root, ".git/HEAD", "ref: refs/heads/main\n");
  put(root, ".git/worktrees/chat-1/gitdir", "/somewhere/data/git-worktrees/chat-1/.git\n");
  put(root, ".env", "SECRET_FOR_APP=1\n");
  put(root, "scripts/run.sh", "#!/bin/sh\necho ok\n", 0o755);
  put(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", private: true }));
  put(root, "package-lock.json", JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "1.0.0" } } }));
  put(root, "node_modules/left-pad/index.js", "native build output");
  put(root, "packages/a/package.json", "{}");
  put(root, "packages/a/node_modules/x/index.js", "workspace member");
  put(root, "tools/web/package.json", "{}");
  put(root, "tools/web/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put(root, "tools/web/node_modules/y/index.js", "own lockfile");
  put(root, ".venv/pyvenv.cfg", "home = /usr/bin\ninclude-system-site-packages = false\n");
  put(root, ".venv/bin/python", "broken absolute interpreter");
  put(root, "app/__pycache__/m.cpython-312.pyc", "cache");
  put(root, "app/main.py", "print('hi')\n");
  fs.symlinkSync("app/main.py", path.join(root, "main-link.py"));
  fs.symlinkSync("/etc/hostname", path.join(root, "outside-link"));
  return root;
}

describe("project transfer to a connected computer", () => {
  it("skips rebuildable environments and plans installs from lockfiles", () => {
    const scan = scanProject(sourceProject());
    expect(scan.entries).toEqual(expect.arrayContaining([".env", ".git/HEAD", "scripts/run.sh", "main-link.py", "app/main.py"]));
    expect(scan.entries.some((entry) => /node_modules|__pycache__|\.venv/.test(entry))).toBe(false);
    expect(scan.steps).toEqual([
      { kind: "python", dir: "", venvName: ".venv" },
      { kind: "node", dir: "" },
      { kind: "node", dir: "tools/web" },
    ]);
    expect(scan.warnings).toEqual([expect.stringContaining("outside-link")]);
  });

  it("copies the project through the relay, registers it and rebuilds node/python environments", async () => {
    const hubData = tempDir("wam-transfer-hub-");
    const nodeData = tempDir("wam-transfer-node-");
    const nodeProjects = tempDir("wam-transfer-projects-");
    const config = (dataDir: string, projectsDir?: string): AppConfig => ({ rootDir: dataDir, homeDir: dataDir, dataDir, projectsDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:9999", allowedRoots: ["/"], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } });
    const hubDb = openDatabase(config(hubData));
    const nodeConfig = config(nodeData, nodeProjects);
    const nodeDb = openDatabase(nodeConfig);
    for (const db of [hubDb, nodeDb]) db.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
    const source = sourceProject();
    // 테스트에서는 네트워크가 필요한 pnpm 설치 대상을 빼고 npm ci·venv 재구성만 실제로 실행한다.
    fs.rmSync(path.join(source, "tools"), { recursive: true });
    // 압축되지 않는 20MiB 파일로 16MiB 조각 두 개 이상에 나눠 보내지는지 확인한다.
    fs.writeFileSync(path.join(source, "assets.bin"), crypto.randomBytes(20 * 1024 * 1024));
    const projectId = Number(hubDb.prepare("INSERT INTO projects(name, path) VALUES ('fixture', ?)").run(source).lastInsertRowid);

    const nodeProjectsService = new GithubProjectService(nodeDb, nodeConfig);
    const receiver = new ProjectTransferReceiver(nodeConfig, async (projectPath, name) => (await nodeProjectsService.registerLocal({ projectPath, name })).project as { id: number; path: string });
    const nodeApp = express();
    nodeApp.use(express.json());
    nodeApp.use(authenticateFederationAgent(nodeDb));
    nodeApp.use("/api", requireAuth, requireCsrf);
    nodeApp.get("/api/federation/ping", (_request, response) => response.json({ protocol: 1 }));
    const nodeFederation = new FederationService(nodeDb, new CredentialVault(nodeDb, nodeData), "http://127.0.0.1:9998");
    nodeApp.use("/api", createProjectTransferRouter(nodeDb, nodeFederation, new ProjectTransferSender(nodeFederation), receiver));
    nodeApp.use((error: Error & { statusCode?: number }, _request: express.Request, response: Response, _next: NextFunction) => response.status(error.statusCode ?? 500).json({ error: error.message }));
    const nodeServer = http.createServer(nodeApp);
    await new Promise<void>((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));

    const federation = new FederationService(hubDb, new CredentialVault(hubDb, hubData), "http://127.0.0.1:9999");
    const hubApp = express();
    hubApp.use(express.json());
    hubApp.use((request: AuthenticatedRequest, _response: Response, next: NextFunction) => {
      request.authUser = { id: 1, username: "admin", role: "admin" } as AuthenticatedRequest["authUser"];
      request.authSession = { id: 1, csrfToken: "", expiresAt: "", temporary: false, reauthenticatedAt: null };
      next();
    });
    hubApp.use("/api", createProjectTransferRouter(hubDb, federation, new ProjectTransferSender(federation), new ProjectTransferReceiver(config(hubData), async () => { throw new Error("unused"); })));
    hubApp.use((error: Error & { statusCode?: number }, _request: express.Request, response: Response, _next: NextFunction) => response.status(error.statusCode ?? 500).json({ error: error.message }));
    const hubServer = http.createServer(hubApp);
    await new Promise<void>((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
    const hubUrl = `http://127.0.0.1:${(hubServer.address() as { port: number }).port}`;
    const post = (body: unknown) => fetch(`${hubUrl}/api/projects/${projectId}/transfer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const node = await federation.add("sub", `http://127.0.0.1:${(nodeServer.address() as { port: number }).port}/`, createFederationAgentToken(nodeDb, 1), 1);
      const preview = await (await fetch(`${hubUrl}/api/projects/${projectId}/transfer-preview`)).json();
      expect(preview).toMatchObject({ steps: [{ kind: "python" }, { kind: "node", dir: "" }], busyChats: [] });

      hubDb.prepare("INSERT INTO chats(id, project_id, provider, tmux_name, title, busy) VALUES (77, ?, 'claude', 'wam-77', 'busy', 1)").run(projectId);
      const busy = await post({ nodeId: node.id });
      expect(busy.status).toBe(409);
      expect((await busy.json()).error).toContain("#77");
      hubDb.prepare("UPDATE chats SET busy = 0 WHERE id = 77").run();

      const sent = await post({ nodeId: node.id, name: "moved-app" });
      const sentBody = await sent.json();
      expect(sent.status, JSON.stringify(sentBody)).toBe(202);
      let transfer = sentBody.transfer;
      for (let attempt = 0; attempt < 240 && ["uploading", "extracting"].includes(transfer.state); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        transfer = (await (await fetch(`${hubUrl}/api/project-transfers/${transfer.id}`)).json()).transfer;
      }
      expect(transfer.state, transfer.error).toBe("done");
      expect(transfer.sentBytes).toBeGreaterThan(20 * 1024 * 1024);
      const destination = path.join(nodeProjects, "moved-app");
      expect(transfer.remoteJob.projectPath).toBe(fs.realpathSync(destination));
      expect(fs.readFileSync(path.join(destination, "assets.bin")).equals(fs.readFileSync(path.join(source, "assets.bin")))).toBe(true);
      expect(fs.readFileSync(path.join(destination, ".env"), "utf8")).toBe("SECRET_FOR_APP=1\n");
      expect(fs.statSync(path.join(destination, "scripts/run.sh")).mode & 0o111).not.toBe(0);
      expect(fs.readlinkSync(path.join(destination, "main-link.py"))).toBe("app/main.py");
      expect(fs.existsSync(path.join(destination, "app/__pycache__"))).toBe(false);
      expect(nodeDb.prepare("SELECT name FROM projects WHERE path = ?").get(fs.realpathSync(destination))).toEqual({ name: "moved-app" });
      expect(fs.readdirSync(path.join(nodeData, "project-transfers", "uploads"))).toEqual([]);

      let job = transfer.remoteJob;
      for (let attempt = 0; attempt < 240 && job.status === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        job = JSON.parse(Buffer.from((await federation.request(node.id, `/project-transfer/jobs/${job.id}`)).body).toString()).job;
      }
      expect(job.steps.map((step: { label: string; status: string }) => [step.label, step.status]), JSON.stringify(job.steps)).toEqual([
        ["Git worktree 기록 정리", expect.any(String)],
        ["Python 가상환경 재구성 (루트/.venv)", "succeeded"],
        ["Node 의존성 설치 (루트)", "succeeded"],
      ]);
      expect(fs.existsSync(path.join(destination, ".venv/pyvenv.cfg"))).toBe(true);
      expect(fs.readFileSync(path.join(destination, ".venv/bin/python")).toString()).not.toBe("broken absolute interpreter");
      expect(fs.existsSync(path.join(destination, "node_modules/left-pad"))).toBe(false);

      // 같은 이름으로 다시 보내면 업로드 전에 대상 경로 충돌로 거부한다.
      const conflict = await post({ nodeId: node.id, name: "moved-app" });
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).error).toContain("이미 있습니다");
    } finally {
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
      await new Promise<void>((resolve) => hubServer.close(() => resolve()));
      hubDb.close(); nodeDb.close();
    }
  }, 120_000);

  it("rejects out-of-order chunks and discards the partial upload", async () => {
    const data = tempDir("wam-transfer-order-");
    const receiver = new ProjectTransferReceiver({ rootDir: data, homeDir: data, dataDir: data, projectsDir: path.join(data, "projects"), host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:9999", allowedRoots: ["/"], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } }, async () => ({ id: 1, path: data }));
    const { uploadId, destination } = receiver.startUpload({ name: "x", sourcePath: "/src", steps: [] });
    expect(destination).toBe(path.join(data, "projects", "x"));
    await receiver.appendChunk(uploadId, 0, Readable.from([Buffer.from("abc")]));
    await expect(receiver.appendChunk(uploadId, 2, Readable.from([Buffer.from("def")]))).rejects.toThrow(/순서/);
    await expect(receiver.completeUpload(uploadId)).rejects.toThrow(/업로드를 찾을 수 없습니다/);
    expect(() => receiver.startUpload({ name: "x", sourcePath: "/src", steps: [{ kind: "node", dir: "../escape" }] })).toThrow(/형식/);
    expect(() => receiver.startUpload({ name: "x", sourcePath: "/src", destinationPath: "relative/path", steps: [] })).toThrow(/절대 경로/);
  });
});
