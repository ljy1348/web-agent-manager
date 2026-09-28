import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { createSessionLoader, createWebSession, requireAuth, requireCsrf } from "../src/server/core/auth";
import { authenticateFederationAgent, createFederationAgentToken, FederationService, normalizeFederationUrl } from "../src/server/services/federation";
import { CredentialVault } from "../src/server/services/credential-vault";
import { RealtimeHub } from "../src/server/services/realtime";
import { PushEventJournal } from "../src/server/services/push-event-journal";
import { createFederationRouter } from "../src/server/routes/federation-routes";
import type { Notifier } from "../src/server/services/notifier";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-federation-"));
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
  const config: AppConfig = { rootDir: root, homeDir: root, dataDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1:9999", allowedRoots: [root], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  return { root, dataDir, config, database, vault: new CredentialVault(database, dataDir) };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("optional WAM federation", () => {
  it("single-node default stays empty and limits plaintext credentials to internal IPs", () => {
    const value = fixture();
    try {
      const federation = new FederationService(value.database, value.vault, value.config.publicUrl);
      expect(federation.list()).toEqual([]);
      for (const address of ["10.0.0.3", "172.17.0.1", "172.31.255.254", "192.168.1.3", "100.64.0.1", "100.127.255.254"]) {
        expect(normalizeFederationUrl(`http://${address}:8000/`)).toBe(`http://${address}:8000`);
      }
      expect(normalizeFederationUrl("http://localhost:8000/")).toBe("http://localhost:8000");
      expect(normalizeFederationUrl("http://[fc00::1]:8000/")).toBe("http://[fc00::1]:8000");
      for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.254.169.254", "example.test", "node.tailnet.ts.net"]) {
        expect(() => normalizeFederationUrl(`http://${address}:8000/`)).toThrow(/HTTPS/);
      }
      expect(() => normalizeFederationUrl("https://example.test/private?token=secret")).toThrow(/경로/);
      expect(() => normalizeFederationUrl("http://user:pass@172.17.0.1:8000/")).toThrow(/경로/);
      expect(() => normalizeFederationUrl("http://172.17.0.1:8000/other")).toThrow(/경로/);
      expect(normalizeFederationUrl("https://example.test/")).toBe("https://example.test");
    } finally { value.database.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
  });

  it("pairs two installations, proxies only allowed APIs, stores no plaintext token and revokes access", async () => {
    const node = fixture(); const hub = fixture();
    const token = createFederationAgentToken(node.database, 1);
    const app = express(); app.use(express.json()); app.use(authenticateFederationAgent(node.database)); app.use("/api", requireAuth, requireCsrf);
    app.get("/api/federation/ping", (_request, response) => response.json({ protocol: 1 }));
    app.get("/api/projects", (_request, response) => response.json({ projects: [{ id: 7, name: "remote" }] }));
    app.post("/api/chats/9/messages", (request, response) => response.status(202).json({ text: request.body.text }));
    app.get("/api/logs/server", (request, response) => response.json({ date: request.query.date }));
    const server = http.createServer(app);
    const baseUrl = await listen(server);
    const federation = new FederationService(hub.database, hub.vault, hub.config.publicUrl);
    try {
      const nodeRecord = await federation.add("workstation", `${baseUrl}/`, token, 1);
      expect(federation.list()).toMatchObject([{ id: nodeRecord.id, name: "workstation", base_url: baseUrl }]);
      expect(JSON.stringify(hub.database.prepare("SELECT * FROM federation_nodes").all())).not.toContain(token);
      expect(JSON.stringify(hub.database.prepare("SELECT * FROM credential_vault_entries").all())).not.toContain(token);
      const projects = await federation.request(nodeRecord.id, "/projects");
      expect(JSON.parse(Buffer.from(projects.body).toString())).toEqual({ projects: [{ id: 7, name: "remote" }] });
      const sent = await federation.request(nodeRecord.id, "/chats/9/messages", "POST", { text: "hello" });
      expect(sent.status).toBe(202);
      expect(JSON.parse(Buffer.from(sent.body).toString())).toEqual({ text: "hello" });
      await expect(federation.request(nodeRecord.id, "/auth/sessions")).rejects.toThrow(/사용할 수 없습니다/);
      // 로그 조회(#116)는 읽기 경로만 중계하고 로그 쓰기 경로는 계속 막는다.
      const logs = await federation.request(nodeRecord.id, "/logs/server?date=2026-09-26");
      expect(logs.status).toBe(200);
      expect(JSON.parse(Buffer.from(logs.body).toString())).toEqual({ date: "2026-09-26" });
      await expect(federation.request(nodeRecord.id, "/logs/client", "POST", { entries: [] })).rejects.toThrow(/사용할 수 없습니다/);
      await expect(federation.request(nodeRecord.id, "/projects/../auth")).rejects.toThrow(/잘못된/);
      node.database.prepare("UPDATE federation_agent_tokens SET revoked_at = CURRENT_TIMESTAMP").run();
      expect((await federation.request(nodeRecord.id, "/projects")).status).toBe(401);
      expect(federation.remove(nodeRecord.id)).toBe(true);
      expect(federation.list()).toEqual([]);
      expect(hub.database.prepare("SELECT 1 FROM credential_vault_entries").get()).toBeUndefined();
    } finally {
      federation.close(); await close(server); node.database.close(); hub.database.close();
      fs.rmSync(node.root, { recursive: true, force: true }); fs.rmSync(hub.root, { recursive: true, force: true });
    }
  });

  it("원격 알림 이벤트는 연결 토큰으로 조회하되 본문 없이 해시 ID만 전달한다", async () => {
    const node = fixture(); const hub = fixture();
    const token = createFederationAgentToken(node.database, 1);
    const journal = new PushEventJournal(node.database);
    await (journal as Notifier).notify("chat:42:private-id", "approval_requested", "비밀 승인 본문");
    const app = express();
    app.use(authenticateFederationAgent(node.database));
    app.use("/api", requireAuth, requireCsrf);
    app.use("/api", createFederationRouter(node.database, new FederationService(node.database, node.vault, node.config.publicUrl), journal));
    const server = http.createServer(app);
    const baseUrl = await listen(server);
    const federation = new FederationService(hub.database, hub.vault, hub.config.publicUrl);
    try {
      const registered = await federation.add("remote-events", `${baseUrl}/`, token, 1);
      const reply = await federation.request(registered.id, "/federation/push-events?after=0");
      const result = JSON.parse(Buffer.from(reply.body).toString()) as { events: Array<{ seq: number; event_id: string; event_type: string }> };
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ seq: 1, event_type: "approval_requested" });
      expect(result.events[0].event_id).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(result)).not.toContain("비밀 승인 본문");
      node.database.prepare("UPDATE federation_agent_tokens SET revoked_at = CURRENT_TIMESTAMP").run();
      expect((await federation.request(registered.id, "/federation/push-events?after=0")).status).toBe(401);
    } finally {
      federation.close(); await close(server); node.database.close(); hub.database.close();
      fs.rmSync(node.root, { recursive: true, force: true }); fs.rmSync(hub.root, { recursive: true, force: true });
    }
  });

  it("relays terminal events over authenticated WebSockets and stops on token revocation", async () => {
    const node = fixture(); const hub = fixture();
    const token = createFederationAgentToken(node.database, 1);
    const nodeApp = express(); nodeApp.use(authenticateFederationAgent(node.database)); nodeApp.use("/api", requireAuth);
    nodeApp.get("/api/federation/ping", (_request, response) => response.json({ protocol: 1 }));
    const nodeServer = http.createServer(nodeApp);
    const nodeRealtime = new RealtimeHub(nodeServer, node.database, undefined, { intervalMs: 100, timeoutMs: 2_000, authRevalidateMs: 100 });
    nodeRealtime.setTerminalHandlers(() => undefined, (chatId) => nodeRealtime.terminal(chatId, "remote terminal"));
    const nodeUrl = await listen(nodeServer);
    const federation = new FederationService(hub.database, hub.vault, hub.config.publicUrl);
    const registered = await federation.add("node", `${nodeUrl}/`, token, 1);
    const hubServer = http.createServer();
    const hubRealtime = new RealtimeHub(hubServer, hub.database, undefined, { intervalMs: 100, timeoutMs: 2_000, authRevalidateMs: 100 }, 720, federation);
    const hubUrl = await listen(hubServer);
    const session = createWebSession(hub.database, hub.config, 1)!;
    const browser = new WebSocket(`${hubUrl.replace("http", "ws")}/ws?node=${registered.id}`, { headers: { Cookie: `web_agent_manager_session=${session.token}` } });
    try {
      await new Promise<void>((resolve, reject) => { browser.once("open", resolve); browser.once("error", reject); });
      browser.send(JSON.stringify({ type: "subscribe_terminal", chatId: 9 }));
      const output = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("terminal output timed out")), 3_000);
        browser.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === "terminal_output") { clearTimeout(timer); resolve(message.payload.data); }
        });
      });
      expect(output).toBe("remote terminal");
      node.database.prepare("UPDATE federation_agent_tokens SET revoked_at = CURRENT_TIMESTAMP").run();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("revoked socket remained open")), 3_000);
        browser.once("close", () => { clearTimeout(timer); resolve(); });
      });
    } finally {
      browser.terminate(); hubRealtime.close(); nodeRealtime.close(); federation.close();
      await close(hubServer); await close(nodeServer);
      node.database.close(); hub.database.close();
      fs.rmSync(node.root, { recursive: true, force: true }); fs.rmSync(hub.root, { recursive: true, force: true });
    }
  });
});
