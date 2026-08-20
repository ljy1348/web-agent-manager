import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_SKILL_NAMES } from "../src/server/services/agent-skill-installer";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import {
  AgentIntegrationManager,
  type AgentIntegrationRuntime,
} from "../src/server/services/agent-integration";

const temporaryRoots: string[] = [];
const databases: AppDatabase[] = [];

// 에이전트 연동 테스트용 web-agent-manager 루트·홈·데이터 경로를 구성한다.
function createFixture(): { config: AppConfig; database: AppDatabase; calls: Array<{ command: string; args: string[] }>; installedMcp: Set<string> } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-integration-"));
  temporaryRoots.push(rootDir);
  const homeDir = path.join(rootDir, "home");
  const dataDir = path.join(rootDir, "data");
  fs.mkdirSync(path.join(rootDir, "dist", "server", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "dist", "server", "scripts", "web-agent-manager-agent.js"), "");
  for (const name of AGENT_SKILL_NAMES) {
    fs.mkdirSync(path.join(rootDir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "skills", name, "SKILL.md"), name);
  }
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    rootDir,
    homeDir,
    dataDir,
    host: "127.0.0.1",
    port: 4317,
    publicUrl: "http://127.0.0.1:4317",
    allowedRoots: ["/"],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  databases.push(database);
  return {
    config,
    database,
    calls: [],
    installedMcp: new Set<string>(),
  };
}

// 설치 공급자와 호출 기록을 제어하는 가짜 CLI 런타임을 만든다.
function fakeRuntime(
  installedProviders: Set<string>,
  installedMcp: Set<string>,
  calls: Array<{ command: string; args: string[] }>,
): AgentIntegrationRuntime {
  return {
    findExecutable: (command) => installedProviders.has(command) ? `/usr/local/bin/${command}` : null,
    run: async (command, args) => {
      calls.push({ command, args });
      const provider = path.basename(command);
      if (args[0] === "--version") return { status: 0, stdout: `${provider} 1.0.0\n`, stderr: "" };
      if (args[0] === "mcp" && args[1] === "get") {
        return installedMcp.has(provider)
          ? { status: 0, stdout: "web-agent-manager\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "not found" };
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        installedMcp.delete(provider);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "mcp" && args[1] === "add") {
        installedMcp.add(provider);
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "지원하지 않는 명령" };
    },
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("에이전트 전역 연동 관리", () => {
  it("설치된 Codex에 전역 스킬과 stdio MCP를 함께 연결한다", async () => {
    const fixture = createFixture();
    const runtime = fakeRuntime(new Set(["codex"]), fixture.installedMcp, fixture.calls);
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, runtime);

    expect((await manager.status()).integrations).toEqual([
      expect.objectContaining({ provider: "codex", cliInstalled: true, ready: false }),
      expect.objectContaining({ provider: "claude", cliInstalled: false, ready: false }),
    ]);
    const result = await manager.install("codex");
    const addCall = fixture.calls.find((call) => call.args[0] === "mcp" && call.args[1] === "add");

    expect(result.integration).toMatchObject({ provider: "codex", skillsInstalled: true, mcpInstalled: true, ready: true });
    expect(addCall?.args).toEqual([
      "mcp", "add", "web-agent-manager",
      "--env", `WEB_AGENT_MANAGER_BRIDGE_SOCKET=${path.join(fixture.config.dataDir, "web-agent-manager-agent.sock")}`,
      "--", process.execPath, path.join(fixture.config.rootDir, "dist", "server", "scripts", "web-agent-manager-agent.js"), "--mcp",
    ]);
    expect(fs.realpathSync(path.join(fixture.config.homeDir, ".codex", "skills", "web-agent-manager-session-context"))).toBe(
      fs.realpathSync(path.join(fixture.config.rootDir, "skills", "web-agent-manager-session-context")),
    );
  });

  it("Claude는 사용자 범위 MCP와 Claude 전역 스킬 경로를 사용한다", async () => {
    const fixture = createFixture();
    const runtime = fakeRuntime(new Set(["claude"]), fixture.installedMcp, fixture.calls);
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, runtime);

    const result = await manager.install("claude");
    const addCall = fixture.calls.find((call) => call.args[0] === "mcp" && call.args[1] === "add");

    expect(result.integration.ready).toBe(true);
    expect(addCall?.args.slice(0, 7)).toEqual([
      "mcp", "add", "--scope", "user", "web-agent-manager", "-e",
      `WEB_AGENT_MANAGER_BRIDGE_SOCKET=${path.join(fixture.config.dataDir, "web-agent-manager-agent.sock")}`,
    ]);
    expect(fs.realpathSync(path.join(fixture.config.homeDir, ".claude", "skills", "web-agent-manager-delegate"))).toBe(
      fs.realpathSync(path.join(fixture.config.rootDir, "skills", "web-agent-manager-delegate")),
    );
  });

  it("공급자 CLI가 없으면 사용자 설정을 만들지 않고 실패한다", async () => {
    const fixture = createFixture();
    const manager = new AgentIntegrationManager(
      fixture.config,
      fixture.database,
      fakeRuntime(new Set(), fixture.installedMcp, fixture.calls),
    );

    await expect(manager.install("codex")).rejects.toThrow("codex CLI가 설치되어 있지 않습니다.");
    expect(fixture.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(fixture.config.homeDir, ".codex"))).toBe(false);
  });

  it("시작 시 실패한 연동 상태를 API 조회마다 다시 실행하지 않는다", async () => {
    const fixture = createFixture();
    const manager = new AgentIntegrationManager(
      fixture.config,
      fixture.database,
      fakeRuntime(new Set(["claude"]), fixture.installedMcp, fixture.calls),
    );

    expect((await manager.status()).integrations[1]).toMatchObject({ provider: "claude", cliInstalled: true, ready: false });
    expect(fixture.calls).toHaveLength(1);
    await manager.status();
    await manager.status();
    expect(fixture.calls).toHaveLength(1);
  });

  it("성공 상태를 저장해 다음 서버 시작에서는 CLI 검사를 생략한다", async () => {
    const fixture = createFixture();
    const installedProviders = new Set(["codex"]);
    const manager = new AgentIntegrationManager(
      fixture.config,
      fixture.database,
      fakeRuntime(installedProviders, fixture.installedMcp, fixture.calls),
    );
    await manager.install("codex");
    fixture.calls.length = 0;

    const restarted = new AgentIntegrationManager(
      fixture.config,
      fixture.database,
      fakeRuntime(installedProviders, fixture.installedMcp, fixture.calls),
    );
    expect((await restarted.status()).integrations[0]).toMatchObject({ provider: "codex", ready: true });
    expect(fixture.calls).toHaveLength(0);
  });

  it("버튼 클릭 시 이미 연결된 MCP는 제거하거나 다시 추가하지 않는다", async () => {
    const fixture = createFixture();
    fixture.installedMcp.add("claude");
    const manager = new AgentIntegrationManager(
      fixture.config,
      fixture.database,
      fakeRuntime(new Set(["claude"]), fixture.installedMcp, fixture.calls),
    );

    const result = await manager.install("claude");

    expect(result.integration.ready).toBe(true);
    expect(fixture.calls.some((call) => call.args[0] === "mcp" && ["remove", "add"].includes(call.args[1]))).toBe(false);
  });
});
