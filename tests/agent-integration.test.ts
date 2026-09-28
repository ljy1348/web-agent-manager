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
    run: async (command, args, env) => {
      calls.push({ command, args });
      const provider = path.basename(command);
      if (args[0] === "--version") return { status: 0, stdout: `${provider} 1.0.0\n`, stderr: "" };
      if (args[0] === "mcp" && args[1] === "get") {
        return installedMcp.has(provider)
          ? { status: 0, stdout: "web-agent-manager\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "not found" };
      }
      if (args[0] === "mcp" && args[1] === "list") {
        // 실제 `grok mcp list --json` 형식. 서버가 없어도 종료 코드는 0이다.
        const servers = installedMcp.has(provider)
          ? [{ name: "web-agent-manager", command: "node", args: ["agent.js", "--mcp"], enabled: true, scope: "user" }]
          : [];
        return { status: 0, stdout: `${JSON.stringify(servers)}\n`, stderr: "" };
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        installedMcp.delete(provider);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "mcp" && args[1] === "add") {
        installedMcp.add(provider);
        // 실제 Codex처럼 CODEX_HOME의 config.toml에 등록 항목을 남긴다.
        if (provider === "codex" && env?.CODEX_HOME) {
          fs.mkdirSync(env.CODEX_HOME, { recursive: true });
          fs.appendFileSync(path.join(env.CODEX_HOME, "config.toml"), "[mcp_servers.web-agent-manager]\ncommand = \"node\"\n");
        }
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

describe("에이전트 연동 설치 위치 (#148)", () => {
  it("Claude 스킬은 프로세스 HOME에, Codex 스킬은 설치 계정 홈에 두고 Codex MCP 명령에는 CODEX_HOME을 붙인다", async () => {
    const fixture = createFixture();
    const processHome = path.join(fixture.config.rootDir, "process-home");
    fs.mkdirSync(processHome);
    const envs: Array<{ provider: string; env?: Record<string, string> }> = [];
    const base = fakeRuntime(new Set(["claude", "codex"]), fixture.installedMcp, fixture.calls);
    const runtime: AgentIntegrationRuntime = { ...base, run: (command, args, env) => { envs.push({ provider: path.basename(command), env }); return base.run(command, args); } };
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, runtime, processHome);

    await manager.install("claude");
    await manager.install("codex");

    for (const name of AGENT_SKILL_NAMES) {
      expect(fs.lstatSync(path.join(processHome, ".claude", "skills", name)).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(fixture.config.homeDir, ".codex", "skills", name)).isSymbolicLink()).toBe(true);
    }
    expect(fs.existsSync(path.join(fixture.config.homeDir, ".claude"))).toBe(false);
    expect(envs.filter((item) => item.provider === "codex").every((item) => item.env?.CODEX_HOME === path.join(fixture.config.homeDir, ".codex"))).toBe(true);
    expect(envs.filter((item) => item.provider === "claude").every((item) => !item.env?.CODEX_HOME)).toBe(true);
  });
});

describe("예전 위치의 연동 성공 기록 (#148)", () => {
  it("저장된 성공 기록이라도 실제 위치에 스킬·Codex MCP가 없으면 다시 검사한다", async () => {
    const fixture = createFixture();
    const processHome = path.join(fixture.config.rootDir, "process-home");
    fs.mkdirSync(processHome);
    // 예전 버전은 Claude 스킬을 설치 계정 홈에 두고 성공으로 저장했다.
    fixture.database.prepare("INSERT INTO agent_integration_status(provider, cli_path, version, verified_at) VALUES ('claude', '/usr/local/bin/claude', NULL, CURRENT_TIMESTAMP), ('codex', '/usr/local/bin/codex', NULL, CURRENT_TIMESTAMP)").run();
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, fakeRuntime(new Set(["claude", "codex"]), fixture.installedMcp, fixture.calls), processHome);
    const { integrations } = await manager.status();
    expect(integrations.filter((item) => ["claude", "codex"].includes(item.provider)).map((item) => [item.provider, item.ready])).toEqual([["codex", false], ["claude", false]]);
    expect(fixture.calls.length).toBeGreaterThan(0);
    expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM agent_integration_status").get()).toEqual({ n: 0 });

    // 올바른 위치에 설치한 뒤에는 다음 시작에서 CLI 검사 없이 성공 기록을 믿는다.
    await manager.install("claude");
    await manager.install("codex");
    fixture.calls.length = 0;
    const restarted = new AgentIntegrationManager(fixture.config, fixture.database, fakeRuntime(new Set(["claude", "codex"]), fixture.installedMcp, fixture.calls), processHome);
    expect((await restarted.status()).integrations.filter((item) => item.ready).map((item) => item.provider).sort()).toEqual(["claude", "codex"]);
    expect(fixture.calls).toHaveLength(0);
  });
});

describe("서버 밖에서 끝난 연동 반영", () => {
  it("시작 때 연결 필요였어도 이후 설치 스크립트가 남긴 성공 기록과 파일이 있으면 다음 조회에서 준비 완료로 보인다", async () => {
    const fixture = createFixture();
    const processHome = path.join(fixture.config.rootDir, "process-home");
    fs.mkdirSync(processHome);
    const server = new AgentIntegrationManager(fixture.config, fixture.database, fakeRuntime(new Set(["claude"]), fixture.installedMcp, fixture.calls), processHome);
    expect((await server.status()).integrations.find((item) => item.provider === "claude")?.ready).toBe(false);
    // 별도 프로세스(설치 스크립트)가 설치하고 성공을 저장한다.
    const script = new AgentIntegrationManager(fixture.config, fixture.database, fakeRuntime(new Set(["claude"]), fixture.installedMcp, []), processHome);
    await script.install("claude");
    const callsBefore = fixture.calls.length;
    expect((await server.status()).integrations.find((item) => item.provider === "claude")?.ready).toBe(true);
    expect(fixture.calls.length).toBe(callsBefore);
  });
});

describe("에이전트 전역 연동 관리", () => {
  it("설치된 Codex에 전역 스킬과 stdio MCP를 함께 연결한다", async () => {
    const fixture = createFixture();
    const runtime = fakeRuntime(new Set(["codex"]), fixture.installedMcp, fixture.calls);
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, runtime, fixture.config.homeDir);

    expect((await manager.status()).integrations).toEqual([
      expect.objectContaining({ provider: "codex", cliInstalled: true, ready: false }),
      expect.objectContaining({ provider: "claude", cliInstalled: false, ready: false }),
      expect.objectContaining({ provider: "grok", cliInstalled: false, ready: false }),
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
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, runtime, fixture.config.homeDir);

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

  it("Grok은 mcp get이 없어 mcp list 출력으로 연동을 판정하고 ~/.grok/skills에 설치한다", async () => {
    const fixture = createFixture();
    const runtime = fakeRuntime(new Set(["grok"]), fixture.installedMcp, fixture.calls);
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, runtime, fixture.config.homeDir);

    // mcp list는 서버가 없어도 종료 코드 0이라, 설치 전에는 출력에 이름이 없어야 미연동으로 봐야 한다.
    expect((await manager.status()).integrations[2]).toMatchObject({ provider: "grok", cliInstalled: true, mcpInstalled: false, ready: false });

    const result = await manager.install("grok");
    const addCall = fixture.calls.find((call) => call.args[0] === "mcp" && call.args[1] === "add");

    expect(result.integration).toMatchObject({ provider: "grok", skillsInstalled: true, mcpInstalled: true, ready: true });
    expect(addCall?.args).toEqual([
      "mcp", "add", "--scope", "user", "web-agent-manager", "-e",
      `WEB_AGENT_MANAGER_BRIDGE_SOCKET=${path.join(fixture.config.dataDir, "web-agent-manager-agent.sock")}`,
      "--", process.execPath, path.join(fixture.config.rootDir, "dist", "server", "scripts", "web-agent-manager-agent.js"), "--mcp",
    ]);
    expect(fixture.calls.every((call) => !(call.args[0] === "mcp" && call.args[1] === "get"))).toBe(true);
    expect(fixture.calls.some((call) => call.args.join(" ") === "mcp list --json")).toBe(true);
    expect(fs.realpathSync(path.join(fixture.config.homeDir, ".grok", "skills", "web-agent-manager-experiment"))).toBe(
      fs.realpathSync(path.join(fixture.config.rootDir, "skills", "web-agent-manager-experiment")),
    );
  });

  it("이름이 다른 서버의 실행 경로에 web-agent-manager가 있어도 Grok 연동으로 오판하지 않는다", async () => {
    const fixture = createFixture();
    const runtime: AgentIntegrationRuntime = {
      findExecutable: (command) => command === "grok" ? "/usr/local/bin/grok" : null,
      run: async (command, args) => {
        fixture.calls.push({ command, args });
        if (args[0] === "mcp" && args[1] === "list") {
          // 실행 경로에만 같은 문자열이 들어 있는 남의 서버. 출력 전체를 부분 문자열로 보면 오탐한다.
          return { status: 0, stdout: JSON.stringify([{ name: "other", command: "/tmp/web-agent-manager-agent.js", scope: "user" }]), stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "지원하지 않는 명령" };
      },
    };
    const manager = new AgentIntegrationManager(fixture.config, fixture.database, runtime, fixture.config.homeDir);

    expect((await manager.status()).integrations[2]).toMatchObject({ provider: "grok", cliInstalled: true, mcpInstalled: false, ready: false });
  });

  it("공급자 CLI가 없으면 사용자 설정을 만들지 않고 실패한다", async () => {
    const fixture = createFixture();
    const manager = new AgentIntegrationManager(
      fixture.config,
      fixture.database,
      fakeRuntime(new Set(), fixture.installedMcp, fixture.calls), fixture.config.homeDir,
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
      fakeRuntime(new Set(["claude"]), fixture.installedMcp, fixture.calls), fixture.config.homeDir,
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
      fakeRuntime(installedProviders, fixture.installedMcp, fixture.calls), fixture.config.homeDir,
    );
    await manager.install("codex");
    fixture.calls.length = 0;

    const restarted = new AgentIntegrationManager(
      fixture.config,
      fixture.database,
      fakeRuntime(installedProviders, fixture.installedMcp, fixture.calls), fixture.config.homeDir,
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
      fakeRuntime(new Set(["claude"]), fixture.installedMcp, fixture.calls), fixture.config.homeDir,
    );

    const result = await manager.install("claude");

    expect(result.integration.ready).toBe(true);
    expect(fixture.calls.some((call) => call.args[0] === "mcp" && ["remove", "add"].includes(call.args[1]))).toBe(false);
  });
});
