import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express, { type NextFunction, type Response } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { requireAuth, requireCsrf, type AuthenticatedRequest } from "../src/server/core/auth";
import { authenticateFederationAgent, createFederationAgentToken, FederationService } from "../src/server/services/federation";
import { CredentialVault } from "../src/server/services/credential-vault";
import { applyCredential, credentialFile, readCredential } from "../src/server/services/credential-sync";
import { createCredentialSyncRouter } from "../src/server/routes/credential-sync-routes";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
// CI 러너처럼 GH_CONFIG_DIR·XDG_CONFIG_HOME이 설정된 환경에서도 가짜 홈의 gh 파일을 읽도록 테스트 동안 비운다.
const ghEnvKeys = ["GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;
const savedGhEnv = new Map<string, string | undefined>();
beforeAll(() => { for (const key of ghEnvKeys) { savedGhEnv.set(key, process.env[key]); delete process.env[key]; } });
afterAll(() => { for (const [key, value] of savedGhEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// 테스트용 가짜 인증 값. 실제 자격증명이 아니다.
const FAKE_GH = "github.com:\n    user: fixture\n    oauth_token: fake-gh-token-for-test\n    git_protocol: https\n";
const FAKE_CODEX = JSON.stringify({ tokens: { access_token: "fake-codex-token-for-test" } });

function dirsWith(files: { gh?: string; codex?: string }) {
  const homeDir = tempDir("wam-cred-home-");
  const codexHome = tempDir("wam-cred-codex-");
  const dirs = { homeDir, codexHome };
  const env = {} as NodeJS.ProcessEnv;
  if (files.gh !== undefined) { fs.mkdirSync(path.dirname(credentialFile("github", dirs, env)), { recursive: true }); fs.writeFileSync(credentialFile("github", dirs, env), files.gh); }
  if (files.codex !== undefined) fs.writeFileSync(credentialFile("codex", dirs, env), files.codex);
  return dirs;
}

describe("credential sync to connected computers", () => {
  it("uses WAM's CODEX_HOME and refuses keyring-only gh or malformed files", () => {
    const dirs = dirsWith({ codex: FAKE_CODEX });
    expect(credentialFile("codex", dirs, {})).toBe(path.join(dirs.codexHome, "auth.json"));
    expect(credentialFile("github", dirs, { GH_CONFIG_DIR: "/custom/gh" })).toBe("/custom/gh/hosts.yml");
    expect(readCredential("codex", dirs)).toBe(FAKE_CODEX);
    expect(() => readCredential("github", dirs)).toThrow(/로그인 정보가 없습니다/);
    const keyring = dirsWith({ gh: "github.com:\n    user: fixture\n    git_protocol: https\n" });
    expect(() => readCredential("github", keyring)).toThrow(/키링/);
    expect(() => applyCredential("codex", "not json", dirs)).toThrow(/형식/);
  });

  it("writes 0600 files, keeps the previous file as a backup and prunes old backups", () => {
    const dirs = dirsWith({ codex: "{\"old\":true}" });
    for (let index = 0; index < 7; index += 1) applyCredential("codex", JSON.stringify({ tokens: { n: index } }), dirs);
    const file = credentialFile("codex", dirs, {});
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ tokens: { n: 6 } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const backups = fs.readdirSync(dirs.codexHome).filter((name) => name.startsWith("auth.json.wam-backup-"));
    expect(backups).toHaveLength(5);
    for (const name of backups) expect(fs.statSync(path.join(dirs.codexHome, name)).mode & 0o777).toBe(0o600);
  });

  it("copies gh/Codex credentials through the relay without echoing values, and rejects Claude", async () => {
    const hubData = tempDir("wam-cred-hub-");
    const nodeData = tempDir("wam-cred-node-");
    const config = (dataDir: string): AppConfig => ({ rootDir: dataDir, homeDir: dataDir, dataDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:9999", allowedRoots: [dataDir], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } });
    const hubDb = openDatabase(config(hubData));
    const nodeDb = openDatabase(config(nodeData));
    for (const db of [hubDb, nodeDb]) db.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
    const hubDirs = dirsWith({ gh: FAKE_GH, codex: FAKE_CODEX });
    const nodeDirs = dirsWith({});
    const refreshed: string[] = [];
    const nodeApp = express();
    nodeApp.use(express.json());
    nodeApp.use(authenticateFederationAgent(nodeDb));
    nodeApp.use("/api", requireAuth, requireCsrf);
    nodeApp.get("/api/federation/ping", (_request, response) => response.json({ protocol: 1 }));
    nodeApp.get("/api/cli-auth", (_request, response) => response.json({ providers: [] }));
    nodeApp.use("/api", createCredentialSyncRouter(nodeDb, new FederationService(nodeDb, new CredentialVault(nodeDb, nodeData), "http://127.0.0.1:9998"), nodeDirs, async (provider) => { refreshed.push(provider); }));
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
    hubApp.use("/api", createCredentialSyncRouter(hubDb, federation, hubDirs, async () => undefined));
    hubApp.use((error: Error & { statusCode?: number }, _request: express.Request, response: Response, _next: NextFunction) => response.status(error.statusCode ?? 500).json({ error: error.message }));
    const hubServer = http.createServer(hubApp);
    await new Promise<void>((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
    const hubUrl = `http://127.0.0.1:${(hubServer.address() as { port: number }).port}`;
    try {
      const node = await federation.add("sub", `http://127.0.0.1:${(nodeServer.address() as { port: number }).port}/`, createFederationAgentToken(nodeDb, 1), 1);
      for (const provider of ["github", "codex"]) {
        const reply = await fetch(`${hubUrl}/api/federation/nodes/${node.id}/credentials/${provider}/sync`, { method: "POST" });
        const text = await reply.text();
        expect(reply.status, text).toBe(200);
        expect(text).not.toContain("fake-");
      }
      expect(fs.readFileSync(credentialFile("github", nodeDirs, {}), "utf8")).toBe(FAKE_GH);
      expect(fs.readFileSync(credentialFile("codex", nodeDirs, {}), "utf8")).toBe(FAKE_CODEX);
      expect(refreshed).toEqual(["github", "codex"]);
      for (const db of [hubDb, nodeDb]) expect(JSON.stringify(db.prepare("SELECT * FROM audit_logs").all())).not.toContain("fake-");
      const claude = await fetch(`${hubUrl}/api/federation/nodes/${node.id}/credentials/claude/sync`, { method: "POST" });
      expect(claude.status).toBe(400);
      // 원격 로그인에 쓰는 CLI 인증 API가 중계 허용 목록에 있다.
      expect((await federation.request(node.id, "/cli-auth")).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => nodeServer.close(() => resolve()));
      await new Promise<void>((resolve) => hubServer.close(() => resolve()));
      hubDb.close(); nodeDb.close();
    }
  });
});
