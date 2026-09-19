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

// 하트비트 테스트용 임시 DB와 로그인 세션 쿠키를 만든다.
function createTestContext(sessionTtl = "+1 hour"): { database: AppDatabase; cookie: string; temporaryCookie: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-heartbeat-root-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-heartbeat-data-"));
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
  const token = "realtime-heartbeat-test-token";
  database.prepare(`
    INSERT INTO web_sessions (user_id, token_hash, csrf_token, expires_at)
    VALUES ((SELECT id FROM users WHERE username = 'tester'), ?, 'csrf', datetime('now', ?))
  `).run(hashToken(token), sessionTtl);
  // 일회용 코드로 만들어지는 임시 세션(같은 role=user, temporary_expires_at만 다름)도 함께 준비한다.
  database.prepare(`
    INSERT INTO users (username, password_hash, role, temporary_expires_at)
    VALUES (?, 'temporary-login-disabled', 'user', datetime('now', '+1 hour'))
  `).run("임시-testguest");
  const temporaryToken = "realtime-heartbeat-temporary-token";
  database.prepare(`
    INSERT INTO web_sessions (user_id, token_hash, csrf_token, expires_at, network_access_allowed)
    VALUES ((SELECT id FROM users WHERE username = '임시-testguest'), ?, 'csrf', datetime('now', ?), 0)
  `).run(hashToken(temporaryToken), sessionTtl);
  cleanup.push(() => {
    database.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    database,
    cookie: `web_agent_manager_session=${token}`,
    temporaryCookie: `web_agent_manager_session=${temporaryToken}`,
  };
}

// 짧은 하트비트 주기를 쓰는 허브와 연결된 클라이언트를 함께 띄운다(실제 25초를 기다리지 않기 위함).
async function serve(heartbeat: { intervalMs: number; timeoutMs: number; authRevalidateMs?: number }, sessionTtl = "+1 hour", idleMinutes = 720): Promise<{ database: AppDatabase; realtime: RealtimeHub; connect: (asTemporary?: boolean) => Promise<WebSocket> }> {
  const { database, cookie, temporaryCookie } = createTestContext(sessionTtl);
  const server = http.createServer((_request, response) => response.end("ok"));
  const realtime = new RealtimeHub(server, database, undefined, heartbeat, idleMinutes);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  cleanup.push(async () => {
    realtime.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    database,
    realtime,
    async connect(asTemporary = false) {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: asTemporary ? temporaryCookie : cookie } });
      await once(client, "open");
      cleanup.push(() => { client.terminate(); });
      return client;
    },
  };
}

function waitForClose(client: WebSocket, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (client.readyState === WebSocket.CLOSED) return resolve(true);
    const timer = setTimeout(() => { client.off("close", onClose); resolve(false); }, timeoutMs);
    function onClose(): void { clearTimeout(timer); resolve(true); }
    client.once("close", onClose);
  });
}

// 지정한 타입의 메시지가 도착할 때까지 기다린다.
function waitForMessage(client: WebSocket, type: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { client.off("message", handler); resolve(false); }, timeoutMs);
    function handler(raw: Buffer): void {
      if (JSON.parse(raw.toString()).type !== type) return;
      clearTimeout(timer);
      client.off("message", handler);
      resolve(true);
    }
    client.on("message", handler);
  });
}

// 모바일에서는 NAT 유휴 타임아웃 등으로 TCP가 close 프레임 없이 조용히 끊긴다. 하트비트가 없으면
// 서버는 죽은 클라이언트를 계속 들고 있고 클라이언트도 좀비 소켓을 붙잡는다(#54).
describe("실시간 연결 하트비트", () => {
  it("서버가 주기적으로 ping을 보낸다", async () => {
    const { connect } = await serve({ intervalMs: 60, timeoutMs: 5_000 });
    const client = await connect();
    expect(await waitForMessage(client, "ping", 2_000)).toBe(true);
  });

  it("클라이언트가 먼저 ping을 보내면 pong으로 답한다", async () => {
    const { connect } = await serve({ intervalMs: 60_000, timeoutMs: 60_000 });
    const client = await connect();
    client.send(JSON.stringify({ type: "ping" }));
    expect(await waitForMessage(client, "pong", 2_000)).toBe(true);
  });

  it("pong으로 답하는 클라이언트는 끊기지 않는다", async () => {
    const { connect } = await serve({ intervalMs: 40, timeoutMs: 200 });
    const client = await connect();
    client.on("message", (raw: Buffer) => {
      if (JSON.parse(raw.toString()).type === "ping") client.send(JSON.stringify({ type: "pong" }));
    });
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 800);
      client.once("close", () => { clearTimeout(timer); resolve(true); });
    });
    expect(closed).toBe(false);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("응답이 끊긴 좀비 연결은 정리한다", async () => {
    // 아무 응답도 하지 않는 클라이언트 — 조용히 죽은 모바일 연결과 같은 상태다.
    const { connect } = await serve({ intervalMs: 40, timeoutMs: 120 });
    const client = await connect();
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000);
      client.once("close", () => { clearTimeout(timer); resolve(true); });
    });
    expect(closed).toBe(true);
  });

  it("연결 중 로그인 세션이 만료되면 응답 여부와 관계없이 끊는다", async () => {
    const { connect } = await serve({ intervalMs: 40, timeoutMs: 5_000 }, "+2 seconds");
    const client = await connect();
    client.on("message", (raw: Buffer) => {
      if (JSON.parse(raw.toString()).type === "ping") client.send(JSON.stringify({ type: "pong" }));
    });
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4_000);
      client.once("close", () => { clearTimeout(timer); resolve(true); });
    });
    expect(closed).toBe(true);
  });

  it("DB에서 세션을 폐기하면 입력을 처리하지 않고 다음 인증 검사에서 연결을 끊는다", async () => {
    const { database, realtime, connect } = await serve({ intervalMs: 60_000, timeoutMs: 60_000, authRevalidateMs: 50 });
    const client = await connect();
    let inputCount = 0;
    realtime.setTerminalHandlers(() => { inputCount += 1; }, () => undefined);
    const closing = waitForClose(client);
    database.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(hashToken("realtime-heartbeat-test-token"));
    client.send(JSON.stringify({ type: "terminal_input", chatId: 1, data: "should-not-run" }));

    expect(await closing).toBe(true);
    expect(inputCount).toBe(0);
  });

  it("idle timeout을 넘긴 열린 소켓은 새 명령 없이도 종료한다", async () => {
    const { database, connect } = await serve({ intervalMs: 60_000, timeoutMs: 60_000, authRevalidateMs: 50 }, "+1 hour", 5);
    const client = await connect();
    const closing = waitForClose(client);
    database.prepare("UPDATE web_sessions SET last_seen_at = datetime('now', '-6 minutes') WHERE token_hash = ?")
      .run(hashToken("realtime-heartbeat-test-token"));
    expect(await closing).toBe(true);
  });

  it("사용자 역할이 바뀌면 기존 관리자 소켓을 재사용하지 못하게 종료한다", async () => {
    const { database, realtime, connect } = await serve({ intervalMs: 60_000, timeoutMs: 60_000, authRevalidateMs: 50 });
    const client = await connect();
    let inputCount = 0;
    realtime.setTerminalHandlers(() => { inputCount += 1; }, () => undefined);
    const closing = waitForClose(client);
    database.prepare("UPDATE users SET role = 'user' WHERE username = 'tester'").run();
    client.send(JSON.stringify({ type: "terminal_input", chatId: 1, data: "stale-admin" }));

    expect(await closing).toBe(true);
    expect(inputCount).toBe(0);
  });

  it("연결된 신뢰 기기를 비활성화하면 열린 소켓도 짧은 주기 안에 종료한다", async () => {
    const { database, connect } = await serve({ intervalMs: 60_000, timeoutMs: 60_000, authRevalidateMs: 50 });
    const user = database.prepare("SELECT id FROM users WHERE username = 'tester'").get() as { id: number };
    database.prepare(`INSERT INTO mobile_trusted_devices(id, user_id, public_key, key_fingerprint, label)
      VALUES ('device-1', ?, 'public-key', 'fingerprint-1', '테스트 기기')`).run(user.id);
    database.prepare("UPDATE web_sessions SET mobile_trusted_device_id = 'device-1' WHERE token_hash = ?")
      .run(hashToken("realtime-heartbeat-test-token"));
    const client = await connect();
    const closing = waitForClose(client);
    database.prepare("UPDATE web_sessions SET mobile_trusted_device_id = NULL WHERE token_hash = ?")
      .run(hashToken("realtime-heartbeat-test-token"));
    database.prepare("UPDATE mobile_trusted_devices SET active = 0 WHERE id = 'device-1'").run();

    expect(await closing).toBe(true);
  });

  it("임시 로그인 세션 소켓에는 승인 요청 payload를 보내지 않는다", async () => {
    const { realtime, connect } = await serve({ intervalMs: 10_000, timeoutMs: 30_000 });
    const admin = await connect();
    const guest = await connect(true);

    realtime.broadcast("approval_requested", { id: "a1", payload: { command: "cat /etc/shadow" } }, { skipTemporary: true });
    expect(await waitForMessage(admin, "approval_requested", 500)).toBe(true);
    expect(await waitForMessage(guest, "approval_requested", 500)).toBe(false);

    // 옵션 없는 일반 이벤트는 임시 세션도 그대로 받아야 화면이 갱신된다.
    realtime.broadcast("chat_status", { chatId: 1 });
    expect(await waitForMessage(guest, "chat_status", 500)).toBe(true);
  });

  it("허브를 닫으면 하트비트 타이머도 멈춘다", async () => {
    const { realtime, connect } = await serve({ intervalMs: 40, timeoutMs: 5_000 });
    const client = await connect();
    realtime.close();
    // 닫힌 뒤에는 더 이상 ping이 오지 않아야 한다.
    expect(await waitForMessage(client, "ping", 300)).toBe(false);
  });
});
