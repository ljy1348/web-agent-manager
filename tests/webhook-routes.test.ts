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
import { createWebhookRouter } from "../src/server/routes/webhook-routes";
import { CredentialVault } from "../src/server/services/credential-vault";
import { WebhookNotifier, type WebhookTransport } from "../src/server/services/webhook";

const roots: string[] = [];
const databases: AppDatabase[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (databases.length) databases.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(transport: WebhookTransport, trusted = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-webhook-routes-")); roots.push(root);
  const database = openDatabase({ dataDir: root } as AppConfig); databases.push(database);
  database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('admin', 'x', 'admin')").run();
  const webhook = new WebhookNotifier(database, new CredentialVault(database, root), transport, 1_000);
  const app = express(); app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin", access_scope: "standard" };
    request.trustedNetwork = trusted; next();
  });
  app.use("/api", createWebhookRouter(database, webhook));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(Number((error as any)?.statusCode) || 400).json({ error: error instanceof Error ? error.message : "error" }));
  const server = app.listen(0, "127.0.0.1");
  closers.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return once(server, "listening").then(() => ({ database, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
}

describe("webhook settings API", () => {
  it("설정·테스트를 수행하고 API와 감사에는 endpoint path·secret을 남기지 않는다", async () => {
    let sends = 0;
    const { database, base } = await fixture({ async send() { sends += 1; return { statusCode: 202 }; } });
    const endpointMarker = "API-ENDPOINT-MARKER";
    const secret = "API-SIGNING-SECRET-0123456789-abcdef";
    const saved = await fetch(`${base}/api/admin/webhook-settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpointUrl: `https://hooks.example.com/${endpointMarker}?token=${endpointMarker}`, signingSecret: secret, enabled: true }) });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody).toEqual({ enabled: true, endpointConfigured: true, signingSecretConfigured: true, endpointHost: "hooks.example.com" });
    expect(JSON.stringify(savedBody)).not.toContain(endpointMarker);
    expect(JSON.stringify(savedBody)).not.toContain(secret);

    const tested = await fetch(`${base}/api/webhook/test`, { method: "POST" });
    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toEqual({ sent: true });
    expect(sends).toBe(1);
    const audits = JSON.stringify(database.prepare("SELECT action, target_type, target_id, details FROM audit_logs ORDER BY id").all());
    expect(audits).toContain("webhook.settings.update");
    expect(audits).toContain("webhook.test");
    expect(audits).not.toContain(endpointMarker);
    expect(audits).not.toContain(secret);
  });

  it("외부망에서는 service 호출 전에 설정과 테스트를 거부한다", async () => {
    let sends = 0;
    const { database, base } = await fixture({ async send() { sends += 1; return { statusCode: 204 }; } }, false);
    const update = await fetch(`${base}/api/admin/webhook-settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpointUrl: "https://hooks.example.com/x", signingSecret: "0123456789abcdef0123456789abcdef", enabled: true }) });
    const test = await fetch(`${base}/api/webhook/test`, { method: "POST" });
    expect([update.status, test.status]).toEqual([403, 403]);
    expect(sends).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM webhook_settings").get()).toEqual({ count: 0 });
  });
});
