import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { createSessionLoader, requireAuth, requireCsrf, type AuthenticatedRequest } from "../src/server/core/auth";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { DEFAULT_LOGIN_RATE_LIMIT_OPTIONS, LoginRateLimiter } from "../src/server/core/login-rate-limit";
import { hashToken } from "../src/server/core/security";
import { createMobileTrustBootstrapRouter, createMobileTrustRouter } from "../src/server/routes/mobile-trust-routes";
import { MobileDeviceTrustService } from "../src/server/services/mobile-device-trust";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

// 실제 SQLite 스키마와 관리자 웹 세션이 있는 격리 테스트 문맥을 만든다.
function createContext(): { database: AppDatabase; config: AppConfig; userId: number; sessionId: number; cookie: string; csrf: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-mobile-trust-root-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-mobile-trust-data-"));
  const config: AppConfig = {
    rootDir,
    homeDir: rootDir,
    dataDir,
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
  const userId = Number(database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('device-admin', 'hash', 'admin')").run().lastInsertRowid);
  const rawToken = "mobile-device-session-token";
  const csrf = "mobile-device-csrf";
  const sessionId = Number(database.prepare(`
    INSERT INTO web_sessions(user_id, token_hash, csrf_token, expires_at)
    VALUES (?, ?, ?, datetime('now', '+1 hour'))
  `).run(userId, hashToken(rawToken), csrf).lastInsertRowid);
  cleanup.push(() => {
    database.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { database, config, userId, sessionId, cookie: `web_agent_manager_session=${rawToken}`, csrf };
}

// Android Keystore와 같은 P-256 공개키·서명 쌍을 테스트용으로 만든다.
function createDeviceKey() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (challenge: string) => crypto.sign("sha256", Buffer.from(challenge, "utf8"), pair.privateKey).toString("base64"),
  };
}

// 실제 인증·CSRF 미들웨어를 포함한 모바일 기기 신뢰 API 서버를 연다.
async function serve(database: AppDatabase, config: AppConfig, trust: MobileDeviceTrustService, rateLimiter?: LoginRateLimiter): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.networkOriginTrusted = request.headers["x-test-internal"] === "1";
    request.trustedNetwork = request.networkOriginTrusted;
    next();
  });
  app.use(createSessionLoader(database));
  app.use("/api", createMobileTrustBootstrapRouter(database, config, trust, rateLimiter));
  app.use("/api", requireAuth, requireCsrf);
  app.use("/api", createMobileTrustRouter(database, trust));
  app.get("/probe", (request: AuthenticatedRequest, response) => response.json({ trusted: request.trustedNetwork === true, appTrusted: request.appTrusted === true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("Android 앱 기기 서명 신뢰", () => {
  it("등록된 P-256 기기 서명만 현재 웹 세션을 신뢰 상태로 승격하고 challenge를 재사용하지 못한다", () => {
    const { database, userId, sessionId } = createContext();
    const trust = new MobileDeviceTrustService(database);
    const device = createDeviceKey();
    const { deviceId } = trust.enroll(userId, device.publicKey, "Pixel test");
    expect(trust.resolve(userId, sessionId, device.publicKey)).toEqual({ deviceId, enrolled: true, sessionTrusted: false });
    const challenge = trust.createChallenge(userId, sessionId, deviceId);

    expect(trust.activate(userId, sessionId, deviceId, challenge, "invalid-signature")).toBe(false);
    expect(trust.activate(userId, sessionId, deviceId, challenge, device.sign(challenge))).toBe(true);
    expect(trust.activate(userId, sessionId, deviceId, challenge, device.sign(challenge))).toBe(false);
    expect(trust.status(userId, sessionId, deviceId)).toEqual({ enrolled: true, sessionTrusted: true });
    const otherSessionId = Number(database.prepare(`
      INSERT INTO web_sessions(user_id, token_hash, csrf_token, expires_at)
      VALUES (?, ?, 'other-csrf', datetime('now', '+1 hour'))
    `).run(userId, hashToken("other-mobile-session")).lastInsertRowid);
    expect(trust.status(userId, otherSessionId, deviceId)).toEqual({ enrolled: true, sessionTrusted: false });
    expect(trust.revoke(userId, deviceId)).toBe(true);
    expect(trust.status(userId, sessionId, deviceId)).toEqual({ enrolled: false, sessionTrusted: false });
  });

  it("외부망에서는 최초 등록을 거부하고 내부망 등록 뒤 외부 세션 서명 인증을 허용한다", async () => {
    const { database, config, cookie, csrf } = createContext();
    const trust = new MobileDeviceTrustService(database);
    const device = createDeviceKey();
    const baseUrl = await serve(database, config, trust);
    const headers = { "content-type": "application/json", cookie, "x-csrf-token": csrf };

    const denied = await fetch(`${baseUrl}/api/mobile/trust/enroll`, {
      method: "POST",
      headers,
      body: JSON.stringify({ publicKey: device.publicKey, label: "Pixel" }),
    });
    const enrolled = await fetch(`${baseUrl}/api/mobile/trust/enroll`, {
      method: "POST",
      headers: { ...headers, "x-test-internal": "1" },
      body: JSON.stringify({ publicKey: device.publicKey, label: "Pixel" }),
    });
    const { deviceId } = await enrolled.json() as { deviceId: string };
    const resolved = await fetch(`${baseUrl}/api/mobile/trust/resolve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ publicKey: device.publicKey }),
    });
    const resolvedBody = await resolved.json() as { deviceId: string; enrolled: boolean };
    const challengeResponse = await fetch(`${baseUrl}/api/mobile/trust/challenge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceId }),
    });
    const { challenge } = await challengeResponse.json() as { challenge: string };
    const activated = await fetch(`${baseUrl}/api/mobile/trust/activate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceId, challenge, signature: device.sign(challenge) }),
    });
    const probe = await (await fetch(`${baseUrl}/probe`, { headers: { cookie } })).json();

    expect(denied.status).toBe(403);
    expect(enrolled.status).toBe(201);
    expect(resolvedBody).toMatchObject({ deviceId, enrolled: true });
    expect(challengeResponse.status).toBe(200);
    expect(activated.status).toBe(200);
    expect(probe).toEqual({ trusted: true, appTrusted: true });
  });

  it("로그인 쿠키가 없는 새 외부 origin도 등록 기기 서명으로 신뢰 세션을 발급한다", async () => {
    const { database, config, userId } = createContext();
    const trust = new MobileDeviceTrustService(database);
    const device = createDeviceKey();
    const { deviceId } = trust.enroll(userId, device.publicKey, "Pixel external");
    const baseUrl = await serve(database, config, trust);
    const headers = { "content-type": "application/json" };

    const challengeResponse = await fetch(`${baseUrl}/api/mobile/trust/session/challenge`, {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceId, publicKey: device.publicKey }),
    });
    const { challenge } = await challengeResponse.json() as { challenge: string };
    const wrongOrigin = await fetch(`${baseUrl}/api/mobile/trust/session/activate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ deviceId, challenge, signature: device.sign(challenge) }),
    });
    const body = JSON.stringify({ deviceId, challenge, signature: device.sign(`wam-device-login-v1\n${baseUrl}\n${challenge}`) });
    const activated = await fetch(`${baseUrl}/api/mobile/trust/session/activate`, { method: "POST", headers, body });
    const cookie = activated.headers.get("set-cookie")?.split(";")[0] ?? "";
    const replay = await fetch(`${baseUrl}/api/mobile/trust/session/activate`, { method: "POST", headers, body });
    const probe = await (await fetch(`${baseUrl}/probe`, { headers: { cookie } })).json();

    expect(challengeResponse.status).toBe(200);
    expect(wrongOrigin.status).toBe(403);
    expect(activated.status).toBe(200);
    expect(cookie).toContain("web_agent_manager_session=");
    expect(replay.status).toBe(403);
    expect(probe).toEqual({ trusted: true, appTrusted: true });
  });

  it("무인증 기기 로그인 요청이 주소 한도를 넘으면 재시도 시간을 주고 차단한다", async () => {
    const { database, config, userId } = createContext();
    const trust = new MobileDeviceTrustService(database);
    const device = createDeviceKey();
    const { deviceId } = trust.enroll(userId, device.publicKey, "Pixel limited");
    const limiter = new LoginRateLimiter({ ...DEFAULT_LOGIN_RATE_LIMIT_OPTIONS, ipAttemptLimit: 2 });
    const baseUrl = await serve(database, config, trust, limiter);
    const headers = { "content-type": "application/json" };
    const body = JSON.stringify({ deviceId, publicKey: device.publicKey });

    expect((await fetch(`${baseUrl}/api/mobile/trust/session/challenge`, { method: "POST", headers, body })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/mobile/trust/session/challenge`, { method: "POST", headers, body })).status).toBe(200);
    const blocked = await fetch(`${baseUrl}/api/mobile/trust/session/challenge`, { method: "POST", headers, body });

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(database.prepare("SELECT action FROM audit_logs WHERE action = 'mobile.trust.session.rate_limited'").get())
      .toEqual({ action: "mobile.trust.session.rate_limited" });
  });

  it("RSA 등 허용하지 않은 키 형식은 등록하지 않는다", () => {
    const { database, userId } = createContext();
    const trust = new MobileDeviceTrustService(database);
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => trust.enroll(userId, rsa)).toThrow("P-256");
  });
});
