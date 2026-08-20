import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { hashToken } from "../src/server/core/security";
import { RealtimeHub } from "../src/server/services/realtime";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

// 실시간 허브 종료 테스트용 임시 DB와 로그인 세션 쿠키를 만든다.
function createTestContext(): { database: AppDatabase; cookie: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-realtime-root-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-realtime-data-"));
  const config: AppConfig = {
    rootDir,
    homeDir: rootDir,
    dataDir,
    projectsDir: rootDir,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    allowedRoots: [rootDir],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run("tester", "unused");
  const token = "realtime-shutdown-test-token";
  database.prepare(`
    INSERT INTO web_sessions (user_id, token_hash, csrf_token, expires_at)
    VALUES ((SELECT id FROM users WHERE username = 'tester'), ?, 'csrf', datetime('now', '+1 hour'))
  `).run(hashToken(token));
  cleanup.push(() => {
    database.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { database, cookie: `web_agent_manager_session=${token}` };
}

// 실시간 허브를 붙인 HTTP 서버를 띄우고 연결된 WebSocket 클라이언트를 함께 반환한다.
async function serveWithClient(): Promise<{ server: http.Server; realtime: RealtimeHub; client: WebSocket }> {
  const { database, cookie } = createTestContext();
  const server = http.createServer((_request, response) => response.end("ok"));
  const realtime = new RealtimeHub(server, database);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  await once(client, "open");
  cleanup.push(() => { client.terminate(); });
  return { server, realtime, client };
}

// 서버가 실제로 닫히는지 확인한다. 닫히지 않으면 정해진 시간 뒤 false가 되어 테스트가 실패한다.
function closeWithin(server: http.Server, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    server.close(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("실시간 연결이 열린 서버의 종료", () => {
  it("열린 WebSocket이 남아 있으면 서버가 닫히지 않는다", async () => {
    const { server } = await serveWithClient();
    // 이 상태가 종료 신호에서 프로세스가 매달리던 원인이다. 회귀하면 이 단언이 먼저 깨진다.
    expect(await closeWithin(server, 700)).toBe(false);
  });

  it("허브를 먼저 닫으면 서버가 정상적으로 닫힌다", async () => {
    const { server, realtime } = await serveWithClient();
    realtime.close();
    expect(await closeWithin(server, 2000)).toBe(true);
  });

  it("허브를 닫으면 연결된 클라이언트도 끊긴다", async () => {
    const { server, realtime, client } = await serveWithClient();
    const closed = once(client, "close");
    realtime.close();
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
    await closeWithin(server, 2000);
  });
});
