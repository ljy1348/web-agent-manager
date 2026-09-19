import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tomlServerBlock } from "../src/server/routes/tool-routes";

const roots: string[] = [];
const secret = "wam-real-cli-secret-must-not-print";

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporaryRoot(provider: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wam-vault-${provider}-cli-`));
  roots.push(root);
  return root;
}

function installed(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0;
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}

describe("설치된 공급자 CLI의 vault 참조 실사용 smoke", () => {
  it.skipIf(!installed("codex"))("Codex가 env_vars/env_http_headers 설정을 실제로 파싱하고 원문을 출력하지 않는다", () => {
    const root = temporaryRoot("codex");
    fs.writeFileSync(path.join(root, "config.toml"), `${tomlServerBlock({
      name: "vault-stdio",
      command: "/bin/true",
      envVars: ["VAULT_TOKEN"],
    }, "codex")}\n\n${tomlServerBlock({
      name: "vault-http",
      url: "https://example.com/mcp",
      envHttpHeaders: { Authorization: "WAM_VAULT_HEADER" },
    }, "codex")}\n`, { mode: 0o600 });
    const result = spawnSync("codex", ["mcp", "get", "vault-stdio", "--json"], {
      env: { ...process.env, CODEX_HOME: root, VAULT_TOKEN: secret, WAM_VAULT_HEADER: `Bearer ${secret}` },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain("vault-stdio");
    expect(output(result)).not.toContain(secret);
    const httpResult = spawnSync("codex", ["mcp", "get", "vault-http", "--json"], {
      env: { ...process.env, CODEX_HOME: root, VAULT_TOKEN: secret, WAM_VAULT_HEADER: `Bearer ${secret}` },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(httpResult.status, output(httpResult)).toBe(0);
    expect(output(httpResult)).not.toContain(secret);
  });

  it.skipIf(!installed("claude"))("Claude가 .mcp.json ${VAR} 참조를 실제로 읽고 원문을 출력하지 않는다", () => {
    const root = temporaryRoot("claude");
    const project = path.join(root, "project");
    const configDir = path.join(root, "config");
    fs.mkdirSync(project);
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(project, ".mcp.json"), `${JSON.stringify({ mcpServers: {
      "vault-test": { type: "stdio", command: "/bin/true", env: { VAULT_TOKEN: "\${VAULT_TOKEN}" } },
    } }, null, 2)}\n`, { mode: 0o600 });
    const result = spawnSync("claude", ["mcp", "get", "vault-test"], {
      cwd: project,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, VAULT_TOKEN: secret },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain("vault-test");
    expect(output(result)).not.toContain(secret);
  });

  it.skipIf(!installed("grok"))("Grok이 config.toml ${VAR} 참조를 실제로 읽되 WAM 상태 조회에는 원문 환경을 주입하지 않는다", () => {
    const root = temporaryRoot("grok");
    fs.writeFileSync(path.join(root, "config.toml"), `${tomlServerBlock({
      name: "vault-test",
      command: "/bin/true",
      env: { VAULT_TOKEN: "\${VAULT_TOKEN}" },
    }, "grok")}\n`, { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = { ...process.env, GROK_HOME: root };
    delete environment.VAULT_TOKEN;
    const result = spawnSync("grok", ["mcp", "list", "--json"], {
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain("vault-test");
    expect(output(result)).not.toContain(secret);
  });
});
