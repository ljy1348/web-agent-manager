import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import { globalAgentSkillsInstalled, installGlobalAgentSkills, type SkillInstallResult } from "./agent-skill-installer";

export type AgentIntegrationProvider = "codex" | "claude";

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface AgentIntegrationRuntime {
  findExecutable(command: string): string | null;
  run(command: string, args: string[]): Promise<CommandResult>;
}

export interface AgentIntegrationStatus {
  provider: AgentIntegrationProvider;
  cliInstalled: boolean;
  cliPath: string | null;
  version: string | null;
  skillsInstalled: boolean;
  mcpInstalled: boolean;
  ready: boolean;
}

// PATH의 실행 파일을 셸 없이 찾아 공급자 CLI 설치 여부를 판정한다.
export function findExecutable(command: string): string | null {
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // 다음 PATH 후보를 확인한다.
      }
    }
  }
  return null;
}

// 공급자 CLI 명령을 이벤트 루프를 막지 않고 제한 시간·출력 길이 안에서 실행한다.
function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? typeof error.code === "number" ? error.code : null : 0,
        stdout: String(stdout || "").slice(0, 20_000),
        stderr: String(stderr || error?.message || "").slice(0, 20_000),
      });
    });
  });
}

const DEFAULT_RUNTIME: AgentIntegrationRuntime = { findExecutable, run: runCommand };

const MCP_SERVER_NAME = "web-agent-manager";
const LEGACY_MCP_SERVER_NAME = "myagent";
const PROVIDERS: AgentIntegrationProvider[] = ["codex", "claude"];

// 아직 확인하지 않은 공급자의 기본 표시 상태를 만든다.
function emptyStatus(provider: AgentIntegrationProvider): AgentIntegrationStatus {
  return { provider, cliInstalled: false, cliPath: null, version: null, skillsInstalled: false, mcpInstalled: false, ready: false };
}

// 설치 시점이 다른 Codex·Claude의 글로벌 스킬과 web-agent-manager MCP 연결 상태를 감지·설치한다.
export class AgentIntegrationManager {
  private readonly statuses = new Map<AgentIntegrationProvider, AgentIntegrationStatus>(
    PROVIDERS.map((provider) => [provider, emptyStatus(provider)]),
  );
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly runtime: AgentIntegrationRuntime = DEFAULT_RUNTIME,
  ) {}

  // 저장되지 않은 공급자만 서버 생명주기에서 한 번 확인한다.
  initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  // 두 공급자의 시작 시점 확인 결과를 반환하고 CLI를 다시 실행하지 않는다.
  async status(): Promise<{ integrations: AgentIntegrationStatus[] }> {
    await this.initialize();
    return { integrations: PROVIDERS.map((provider) => this.statuses.get(provider) ?? emptyStatus(provider)) };
  }

  // DB 성공 기록을 우선 복원하고 나머지 공급자만 실제로 검사한다.
  private async initializeOnce(): Promise<void> {
    await Promise.all(PROVIDERS.map(async (provider) => {
      const saved = this.database.prepare(
        "SELECT cli_path, version FROM agent_integration_status WHERE provider = ?",
      ).get(provider) as { cli_path: string; version: string | null } | undefined;
      if (saved) {
        this.statuses.set(provider, {
          provider,
          cliInstalled: true,
          cliPath: saved.cli_path,
          version: saved.version,
          skillsInstalled: true,
          mcpInstalled: true,
          ready: true,
        });
        return;
      }
      const status = await this.inspectProvider(provider);
      this.statuses.set(provider, status);
      if (status.ready) this.saveSuccess(status);
    }));
  }

  // 한 공급자의 설치 여부와 web-agent-manager 연동 완성 여부를 실제 CLI로 계산한다.
  private async inspectProvider(provider: AgentIntegrationProvider): Promise<AgentIntegrationStatus> {
    const executable = this.runtime.findExecutable(provider);
    const skillsInstalled = globalAgentSkillsInstalled(provider, this.config.homeDir, this.config.rootDir);
    if (!executable) {
      return { provider, cliInstalled: false, cliPath: null, version: null, skillsInstalled, mcpInstalled: false, ready: false };
    }
    const mcpResult = await this.runtime.run(
      executable,
      provider === "codex" ? ["mcp", "get", MCP_SERVER_NAME, "--json"] : ["mcp", "get", MCP_SERVER_NAME],
    );
    const mcpInstalled = mcpResult.status === 0;
    return {
      provider,
      cliInstalled: true,
      cliPath: executable,
      version: null,
      skillsInstalled,
      mcpInstalled,
      ready: skillsInstalled && mcpInstalled,
    };
  }

  // 정상 검증된 공급자 상태를 영속화하고 현재 메모리 상태도 갱신한다.
  private saveSuccess(status: AgentIntegrationStatus): void {
    if (!status.ready || !status.cliPath) return;
    this.database.prepare(`
      INSERT INTO agent_integration_status(provider, cli_path, version, verified_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider) DO UPDATE SET
        cli_path = excluded.cli_path,
        version = excluded.version,
        verified_at = CURRENT_TIMESTAMP
    `).run(status.provider, status.cliPath, status.version);
    this.statuses.set(status.provider, status);
  }

  // 명시적으로 선택한 공급자에 글로벌 스킬과 사용자 범위 stdio MCP를 설치한다.
  async install(provider: AgentIntegrationProvider): Promise<{ integration: AgentIntegrationStatus; skills: SkillInstallResult }> {
    const executable = this.runtime.findExecutable(provider);
    if (!executable) throw new Error(`${provider} CLI가 설치되어 있지 않습니다.`);
    const skills = installGlobalAgentSkills(provider, this.config.homeDir, this.config.rootDir);
    if (skills.errors.length) throw new Error(skills.errors.join("\n"));
    const current = await this.inspectProvider(provider);
    if (current.ready) {
      this.saveSuccess(current);
      return { integration: current, skills };
    }
    const launch = this.mcpLaunch();
    for (const serverName of [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]) {
      const removeArgs = provider === "codex"
        ? ["mcp", "remove", serverName]
        : ["mcp", "remove", "--scope", "user", serverName];
      await this.runtime.run(executable, removeArgs);
    }
    const socketVariable = `WEB_AGENT_MANAGER_BRIDGE_SOCKET=${path.join(this.config.dataDir, "web-agent-manager-agent.sock")}`;
    const addArgs = provider === "codex"
      ? ["mcp", "add", MCP_SERVER_NAME, "--env", socketVariable, "--", launch.command, ...launch.args]
      : ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "-e", socketVariable, "--", launch.command, ...launch.args];
    const result = await this.runtime.run(executable, addArgs);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "MCP 설치에 실패했습니다.").trim());
    const integration = await this.inspectProvider(provider);
    this.statuses.set(provider, integration);
    if (!integration.ready) throw new Error("MCP 설치 후 연동 상태를 확인하지 못했습니다.");
    this.saveSuccess(integration);
    return { integration, skills };
  }

  // production 빌드가 있으면 Node 진입점을, 개발 환경이면 로컬 tsx 진입점을 사용한다.
  private mcpLaunch(): { command: string; args: string[] } {
    const productionEntry = path.join(this.config.rootDir, "dist", "server", "scripts", "web-agent-manager-agent.js");
    if (fs.existsSync(productionEntry)) return { command: process.execPath, args: [productionEntry, "--mcp"] };
    const tsxEntry = path.join(this.config.rootDir, "node_modules", "tsx", "dist", "cli.mjs");
    if (!fs.existsSync(tsxEntry)) throw new Error("MCP 실행 파일을 찾을 수 없습니다. 먼저 npm run build를 실행해주세요.");
    return { command: process.execPath, args: [tsxEntry, path.join(this.config.rootDir, "scripts", "web-agent-manager-agent.ts"), "--mcp"] };
  }
}
