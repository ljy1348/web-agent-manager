import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { CredentialVault } from "../src/server/services/credential-vault";
import { SlackNotifier } from "../src/server/services/slack";
import { createToolRouter, tomlServerBlock } from "../src/server/routes/tool-routes";

function fixture(): { dataDir: string; database: AppDatabase; vault: CredentialVault; config: ReturnType<typeof loadConfig> } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-vault-"));
  const config = loadConfig();
  config.dataDir = dataDir;
  const database = openDatabase(config);
  return { dataDir, database, vault: new CredentialVault(database, dataDir), config };
}

describe("WAM credential vault", () => {
  it("AES-GCM 암호문만 저장하고 callback lease 뒤 접근 메타데이터만 남긴다", async () => {
    const { dataDir, database, vault } = fixture();
    const secret = "xoxb-super-secret-value";
    const id = vault.put("system", "slack", "notification", "bot_token", secret);
    const row = database.prepare("SELECT * FROM credential_vault_entries WHERE id = ?").get(id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.version).toBe(1);

    let observed = "";
    await vault.withSecret(id, "test:slack", async (value) => { observed = value; });
    expect(observed).toBe(secret);
    const lease = database.prepare("SELECT consumer, released_at FROM credential_vault_leases WHERE credential_id = ?").get(id) as { consumer: string; released_at: string | null };
    expect(lease.consumer).toBe("test:slack");
    expect(lease.released_at).not.toBeNull();

    const key = path.join(dataDir, "secrets", "credential-vault.key");
    expect(fs.statSync(key).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(key)).mode & 0o777).toBe(0o700);
  });

  it("암호문이 있는데 master key가 사라지거나 AAD가 변조되면 fail-fast 한다", () => {
    const first = fixture();
    first.vault.put("system", "slack", "notification", "bot_token", "never-plaintext");
    fs.unlinkSync(path.join(first.dataDir, "secrets", "credential-vault.key"));
    expect(() => new CredentialVault(first.database, first.dataDir)).toThrow(/master key/);

    const second = fixture();
    const id = second.vault.put("system", "slack", "notification", "bot_token", "tamper-test");
    second.database.prepare("UPDATE credential_vault_entries SET purpose = 'other' WHERE id = ?").run(id);
    expect(() => new CredentialVault(second.database, second.dataDir)).toThrow();
  });

  it("기존 Slack 평문을 시작 시 vault로 옮기고 알림 전송에만 짧게 빌린다", async () => {
    const { database, vault, config } = fixture();
    database.prepare("INSERT INTO slack_settings(id, bot_token, channel_id) VALUES (1, ?, ?)").run("legacy-xoxb", "C123");
    const slack = new SlackNotifier(config, database, vault);
    const migrated = database.prepare("SELECT bot_token, bot_token_vault_id FROM slack_settings WHERE id = 1").get() as { bot_token: string | null; bot_token_vault_id: string | null };
    expect(migrated.bot_token).toBeNull();
    expect(migrated.bot_token_vault_id).toBeTruthy();
    expect(JSON.stringify(database.prepare("SELECT * FROM credential_vault_entries").all())).not.toContain("legacy-xoxb");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await slack.notify("vault-slack-test", "test", "hello");
    expect((fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer legacy-xoxb");
    fetchSpy.mockRestore();
  });

  it("Claude·Grok에는 환경변수 placeholder, Codex에는 공식 env 참조만 만든다", () => {
    const { database, vault } = fixture();
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', '/tmp/p')").run().lastInsertRowid);
    const claude = vault.replaceMcpSecrets("claude", projectId, "api", { API_KEY: "claude-secret" }, { Authorization: "Bearer claude-secret" });
    const grok = vault.replaceMcpSecrets("grok", projectId, "api", { API_KEY: "grok-secret" }, { Authorization: "Bearer grok-secret" });
    const codexStdio = vault.replaceMcpSecrets("codex", projectId, "stdio-api", { API_KEY: "codex-secret" }, undefined);
    const codexHttp = vault.replaceMcpSecrets("codex", projectId, "http-api", undefined, { Authorization: "Bearer codex-secret" });
    expect(claude.env?.API_KEY).toMatch(/^\$\{WAM_VAULT_/);
    expect(grok.headers?.Authorization).toMatch(/^\$\{WAM_VAULT_/);
    expect(codexStdio.envVars).toEqual(["API_KEY"]);
    expect(codexHttp.envHttpHeaders?.Authorization).toMatch(/^WAM_VAULT_/);

    const stdioBlock = tomlServerBlock({ name: "stdio-api", command: "node", envVars: codexStdio.envVars }, "codex");
    const httpBlock = tomlServerBlock({ name: "http-api", url: "https://example.com/mcp", envHttpHeaders: codexHttp.envHttpHeaders }, "codex");
    expect(stdioBlock).toContain('env_vars = ["API_KEY"]');
    expect(httpBlock).toContain("env_http_headers");
    expect(`${stdioBlock}${httpBlock}`).not.toContain("codex-secret");

    let environment: Record<string, string> = {};
    vault.withMcpEnvironment("claude", projectId, "test:launch", (value) => { environment = { ...value }; });
    expect(Object.values(environment)).toContain("claude-secret");
    expect(Object.values(environment)).not.toContain("codex-secret");
  });

  it("Codex stdio의 같은 env 이름이 서로 다른 비밀을 요구하면 실행 전에 거부한다", () => {
    const { database, vault } = fixture();
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', '/tmp/p')").run().lastInsertRowid);
    vault.replaceMcpSecrets("codex", projectId, "one", { API_KEY: "one" }, undefined);
    expect(() => vault.replaceMcpSecrets("codex", projectId, "two", { API_KEY: "two" }, undefined)).toThrow(/서로 다른 값/);
  });

  it("Claude MCP 저장 API가 설정·감사 로그·응답 어디에도 평문을 남기지 않는다", async () => {
    const { dataDir, database, vault } = fixture();
    const projectRoot = path.join(dataDir, "project");
    fs.mkdirSync(projectRoot);
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(projectRoot).lastInsertRowid);
    database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).authUser = { id: 1, username: "admin", role: "admin", accessScope: "standard" }; next(); });
    app.use("/api", createToolRouter(database, vault));

    const secret = "route-plaintext-must-disappear";
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 서버 주소를 확인하지 못했습니다.");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tools/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude", projectId, name: "secure", transport: "stdio", command: "node", env: { API_KEY: secret } }),
    });
    const body = await response.json();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    expect(response.status).toBe(201);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(fs.readFileSync(path.join(projectRoot, ".mcp.json"), "utf8")).not.toContain(secret);
    expect(JSON.stringify(database.prepare("SELECT * FROM audit_logs").all())).not.toContain(secret);
    expect(JSON.stringify(database.prepare("SELECT * FROM credential_vault_entries").all())).not.toContain(secret);
  });

  it("실사용 규모 100개 비밀의 launch lease 준비를 1초 안에 끝낸다", () => {
    const { database, vault } = fixture();
    const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', '/tmp/p')").run().lastInsertRowid);
    for (let index = 0; index < 100; index += 1) vault.replaceMcpSecrets("claude", projectId, `server-${index}`, { TOKEN: `secret-${index}` }, undefined);
    const startedAt = performance.now();
    let count = 0;
    vault.withMcpEnvironment("claude", projectId, "performance:launch", (environment) => { count = Object.keys(environment).length; });
    expect(count).toBe(100);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
