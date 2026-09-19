import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { CredentialVault } from "../src/server/services/credential-vault";
import { createSecureWebhookTransport, isPublicWebhookAddress, WebhookNotifier, type WebhookTransport } from "../src/server/services/webhook";

const roots: string[] = [];
const databases: AppDatabase[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length) await new Promise<void>((resolve, reject) => servers.pop()!.close((error) => error ? reject(error) : resolve()));
  while (databases.length) databases.pop()!.close();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { root: string; database: AppDatabase; vault: CredentialVault } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-webhook-"));
  roots.push(root);
  const database = openDatabase({ dataDir: root } as AppConfig);
  databases.push(database);
  return { root, database, vault: new CredentialVault(database, root) };
}

describe("signed outbound webhook", () => {
  it("vault 비밀 없이 고정 payload와 검증 가능한 HMAC을 실제 수신기에 한 번만 전송한다", async () => {
    const { database, vault } = fixture();
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => { received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") }); response.writeHead(204).end(); });
    });
    servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const receiver = `http://127.0.0.1:${(server.address() as AddressInfo).port}/receive`;
    const transport: WebhookTransport = {
      async send(input) {
        const response = await fetch(receiver, { method: "POST", headers: input.headers, body: input.body, signal: input.signal });
        return { statusCode: response.status };
      },
    };
    const notifier = new WebhookNotifier(database, vault, transport, 2_000);
    const endpointMarker = "ENDPOINT-PATH-QUERY-MARKER";
    const secret = "SIGNING-SECRET-MARKER-0123456789-abcdef";
    expect(notifier.updateSettings(`https://hooks.example.com/${endpointMarker}?token=${endpointMarker}`, secret, true)).toEqual({
      enabled: true, endpointConfigured: true, signingSecretConfigured: true, endpointHost: "hooks.example.com",
    });

    const startedAt = performance.now();
    await Promise.all([
      notifier.notify("event-1", "task_completed", "완료했습니다.", { title: "QA 완료" }),
      notifier.notify("event-1", "task_completed", "중복입니다.", { title: "중복" }),
    ]);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0].body);
    expect(Object.keys(payload)).toEqual(["eventId", "type", "title", "text", "timestamp"]);
    expect(payload).toMatchObject({ eventId: "event-1", type: "task_completed", title: "QA 완료", text: "완료했습니다." });
    expect(received[0].headers["x-wam-timestamp"]).toBe(payload.timestamp);
    const expected = crypto.createHmac("sha256", secret).update(`${payload.timestamp}.${received[0].body}`).digest("hex");
    expect(received[0].headers["x-wam-signature"]).toBe(`sha256=${expected}`);
    expect(received[0].headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(database.prepare("SELECT status, attempts, last_http_status, last_error FROM webhook_deliveries").get()).toEqual({ status: "sent", attempts: 1, last_http_status: 204, last_error: null });
    expect(database.prepare("SELECT endpoint_host, enabled FROM webhook_settings").get()).toEqual({ endpoint_host: "hooks.example.com", enabled: 1 });
    const publicDatabaseRows = JSON.stringify([
      ...database.prepare("SELECT * FROM webhook_settings").all(),
      ...database.prepare("SELECT * FROM webhook_deliveries").all(),
    ]);
    expect(publicDatabaseRows).not.toContain(endpointMarker);
    expect(publicDatabaseRows).not.toContain(secret);
    const encrypted = JSON.stringify(database.prepare("SELECT encrypted_value, nonce, auth_tag FROM credential_vault_entries").all());
    expect(encrypted).not.toContain(endpointMarker);
    expect(encrypted).not.toContain(secret);
    expect(database.prepare("SELECT COUNT(*) AS count FROM credential_vault_leases WHERE released_at IS NULL").get()).toEqual({ count: 0 });
    const duplicateStartedAt = performance.now();
    for (let index = 0; index < 500; index += 1) await notifier.notify("event-1", "task_completed", "duplicate");
    expect(performance.now() - duplicateStartedAt).toBeLessThan(1_000);
    expect(received).toHaveLength(1);
  });

  it("private·mixed DNS와 redirect를 전송 전에 막고 공개 DNS 주소를 dispatch에 pin한다", async () => {
    const dispatched: string[] = [];
    const privateTransport = createSecureWebhookTransport(async () => [{ address: "169.254.169.254", family: 4 }], async (_input, target) => { dispatched.push(target.address); return { statusCode: 204 }; });
    await expect(privateTransport.send({ url: "https://hooks.example.com/x", headers: {}, body: "{}", signal: AbortSignal.timeout(1_000) })).rejects.toThrow("non_public_address");
    const mixedTransport = createSecureWebhookTransport(async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], async (_input, target) => { dispatched.push(target.address); return { statusCode: 204 }; });
    await expect(mixedTransport.send({ url: "https://hooks.example.com/x", headers: {}, body: "{}", signal: AbortSignal.timeout(1_000) })).rejects.toThrow("non_public_address");
    expect(dispatched).toEqual([]);

    const publicTransport = createSecureWebhookTransport(async (hostname) => {
      expect(hostname).toBe("hooks.example.com"); return [{ address: "93.184.216.34", family: 4 }];
    }, async (_input, target) => { dispatched.push(target.address); return { statusCode: 204 }; });
    await expect(publicTransport.send({ url: "https://hooks.example.com/x", headers: {}, body: "{}", signal: AbortSignal.timeout(1_000) })).resolves.toEqual({ statusCode: 204 });
    expect(dispatched).toEqual(["93.184.216.34"]);

    const redirect = createSecureWebhookTransport(async () => [{ address: "93.184.216.34", family: 4 }], async () => ({ statusCode: 302 }));
    await expect(redirect.send({ url: "https://hooks.example.com/x", headers: {}, body: "{}", signal: AbortSignal.timeout(1_000) })).rejects.toThrow("redirect_blocked");
  });

  it("주소 입력 경계, timeout 오류 비노출, 실패 뒤 제한된 재시도를 검증한다", async () => {
    const { database, vault } = fixture();
    const notifier = new WebhookNotifier(database, vault, { async send(input) { await delay(200, undefined, { signal: input.signal }); return { statusCode: 204 }; } }, 30);
    const secret = "0123456789abcdef0123456789abcdef";
    for (const endpoint of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://user:pass@hooks.example.com/x", "https://hooks.example.com/x#fragment"]) {
      expect(() => notifier.updateSettings(endpoint, secret, true)).toThrow();
    }
    expect(() => notifier.updateSettings("https://hooks.example.com/x", "too-short", true)).toThrow("32~1024");
    expect(() => notifier.updateSettings("https://hooks.example.com/x", "가".repeat(342), true)).toThrow("32~1024");
    notifier.updateSettings("https://hooks.example.com/private/path?token=DO-NOT-LEAK", secret, true);
    await notifier.notify("slow-event", "test", "slow");
    expect(database.prepare("SELECT status, attempts, last_error FROM webhook_deliveries WHERE event_id='slow-event'").get()).toEqual({ status: "failed", attempts: 1, last_error: "timeout" });
    const rows = JSON.stringify(database.prepare("SELECT * FROM webhook_deliveries").all());
    expect(rows).not.toContain("DO-NOT-LEAK");
    expect(rows).not.toContain(secret);

    let sends = 0;
    const retry = new WebhookNotifier(database, vault, { async send() { sends += 1; return { statusCode: 204 }; } }, 1_000);
    await retry.notify("slow-event", "test", "retry");
    await retry.notify("slow-event", "test", "duplicate");
    expect(sends).toBe(1);
    expect(database.prepare("SELECT status, attempts FROM webhook_deliveries WHERE event_id='slow-event'").get()).toEqual({ status: "sent", attempts: 2 });
  });

  it("공개·비공개 IP 분류를 보수적으로 적용한다", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.51.100.5", "203.0.113.9", "224.0.0.1", "::1", "fc00::1", "fe80::1", "ff00::1", "2001:db8::1", "::ffff:127.0.0.1", "not-an-ip"]) expect(isPublicWebhookAddress(address)).toBe(false);
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPublicWebhookAddress(address)).toBe(true);
  });
});
