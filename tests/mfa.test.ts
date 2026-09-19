import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionLoader, type AuthenticatedRequest } from "../src/server/core/auth";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { MfaService, totpCode } from "../src/server/core/mfa";
import { hashPassword } from "../src/server/core/security";
import { createAuthRouter } from "../src/server/routes/auth-routes";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });

function context(): { database: AppDatabase; config: AppConfig; dataDir: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-mfa-root-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-mfa-data-"));
  const config: AppConfig = { rootDir, homeDir: rootDir, dataDir, host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1", allowedRoots: [rootDir], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" } };
  const database = openDatabase(config);
  cleanup.push(() => { database.close(); fs.rmSync(rootDir, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { database, config, dataDir };
}

async function serve(database: AppDatabase, config: AppConfig): Promise<string> {
  const app = express(); app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => { request.trustedNetwork = false; next(); });
  app.use(createSessionLoader(database)); app.use("/api/auth", createAuthRouter(database, config));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(baseUrl: string, pathName: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/auth${pathName}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("TOTP MFA", () => {
  it("RFC 6238 SHA-1 벡터를 6자리 코드로 계산한다", () => {
    expect(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000).code).toBe("287082");
  });

  it("seed를 AES-GCM으로 암호화하고 복구 코드를 해시로만 저장한다", async () => {
    const { database, dataDir } = context();
    const user = database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('mfa-user', 'unused', 'admin')").run();
    const service = new MfaService(database, dataDir);
    const setup = service.beginSetup(Number(user.lastInsertRowid), "mfa-user");
    const codes = service.confirmSetup(Number(user.lastInsertRowid), totpCode(setup.secret).code);
    const stored = database.prepare("SELECT encrypted_secret, nonce, auth_tag FROM user_mfa WHERE user_id = ?").get(Number(user.lastInsertRowid)) as Record<string, string>;
    const recovery = database.prepare("SELECT code_hash FROM user_mfa_recovery_codes WHERE user_id = ?").all(Number(user.lastInsertRowid)) as Array<{ code_hash: string }>;
    const keyPath = path.join(dataDir, "secrets", "mfa-master.key");

    expect(codes).toHaveLength(10);
    expect(JSON.stringify(stored)).not.toContain(setup.secret);
    expect(stored.encrypted_secret).not.toBe(setup.secret);
    expect(recovery).toHaveLength(10);
    expect(codes!.every((code) => recovery.every((row) => !row.code_hash.includes(code.replaceAll("-", ""))))).toBe(true);
    expect(fs.statSync(keyPath).size).toBe(32);
    expect(fs.statSync(keyPath).mode & 0o077).toBe(0);
    fs.rmSync(keyPath);
    expect(() => new MfaService(database, dataDir)).toThrow("master key가 없습니다");
  });

  it("비밀번호 뒤 MFA를 강제하고 TOTP replay·복구 코드 재사용·해제 후 세션을 차단한다", async () => {
    const { database, config } = context();
    database.prepare("INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')").run("mfa-admin", await hashPassword("correct-password"));
    const baseUrl = await serve(database, config);
    const initialLogin = await post(baseUrl, "/login", { username: "mfa-admin", password: "correct-password" });
    const initialBody = await initialLogin.json() as { csrfToken: string };
    const initialCookie = initialLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authHeaders = { cookie: initialCookie, "x-csrf-token": initialBody.csrfToken };

    const wrongSetup = await post(baseUrl, "/mfa/setup", { currentPassword: "wrong-password" }, authHeaders);
    expect(wrongSetup.status).toBe(401);
    const setupResponse = await post(baseUrl, "/mfa/setup", { currentPassword: "correct-password" }, authHeaders);
    const setup = await setupResponse.json() as { secret: string; otpauthUri: string };
    expect(setupResponse.status).toBe(200);
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    const confirm = await post(baseUrl, "/mfa/confirm", { code: totpCode(setup.secret).code }, authHeaders);
    const confirmed = await confirm.json() as { recoveryCodes: string[] };
    expect(confirm.status).toBe(200);
    expect(confirmed.recoveryCodes).toHaveLength(10);

    const passwordOnly = await post(baseUrl, "/login", { username: "mfa-admin", password: "correct-password" });
    const pending = await passwordOnly.json() as { mfaRequired: boolean; challengeToken: string };
    expect(passwordOnly.status).toBe(202);
    expect(passwordOnly.headers.get("set-cookie")).toBeNull();
    expect(pending.mfaRequired).toBe(true);
    const invalid = await post(baseUrl, "/login/mfa", { challengeToken: pending.challengeToken, code: "000000" });
    expect(invalid.status).toBe(401);
    const completed = await post(baseUrl, "/login/mfa", { challengeToken: pending.challengeToken, code: totpCode(setup.secret).code });
    const completedBody = await completed.json() as { csrfToken: string };
    const completedCookie = completed.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(completed.status).toBe(200);
    expect(completed.headers.get("set-cookie")).toContain("web_agent_manager_session=");

    database.prepare("UPDATE web_sessions SET reauthenticated_at = datetime('now', '-20 minutes') WHERE token_hash = (SELECT token_hash FROM web_sessions ORDER BY id DESC LIMIT 1)").run();
    const completedHeaders = { cookie: completedCookie, "x-csrf-token": completedBody.csrfToken };
    expect((await post(baseUrl, "/reauth", { currentPassword: "correct-password" }, completedHeaders)).status).toBe(401);
    expect((await post(baseUrl, "/reauth", { currentPassword: "correct-password", code: confirmed.recoveryCodes[0] }, completedHeaders)).status).toBe(200);

    const replayPassword = await post(baseUrl, "/login", { username: "mfa-admin", password: "correct-password" });
    const replayPending = await replayPassword.json() as { challengeToken: string };
    expect((await post(baseUrl, "/login/mfa", { challengeToken: replayPending.challengeToken, code: totpCode(setup.secret).code })).status).toBe(401);
    const recoveryLogin = await post(baseUrl, "/login/mfa", { challengeToken: replayPending.challengeToken, code: confirmed.recoveryCodes[1] });
    expect(recoveryLogin.status).toBe(200);

    const reusedPassword = await post(baseUrl, "/login", { username: "mfa-admin", password: "correct-password" });
    const reusedPending = await reusedPassword.json() as { challengeToken: string };
    expect((await post(baseUrl, "/login/mfa", { challengeToken: reusedPending.challengeToken, code: confirmed.recoveryCodes[1] })).status).toBe(401);

    const disabled = await post(baseUrl, "/mfa/disable", { currentPassword: "correct-password", code: confirmed.recoveryCodes[2] }, completedHeaders);
    expect(disabled.status).toBe(200);
    expect((database.prepare("SELECT COUNT(*) AS count FROM web_sessions").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM user_mfa").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM user_mfa_recovery_codes").get() as { count: number }).count).toBe(0);
    expect((await post(baseUrl, "/login", { username: "mfa-admin", password: "correct-password" })).status).toBe(200);
  });
});
