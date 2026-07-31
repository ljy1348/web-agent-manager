import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { AppConfig } from "../core/config";
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

// 설치 시점이 다른 Codex·Claude의 글로벌 스킬과 web-agent-manager MCP 연결 상태를 감지·설치한다.
export class AgentIntegrationManager {
  constructor(
    private readonly config: AppConfig,
    private readonly runtime: AgentIntegrationRuntime = DEFAULT_RUNTIME,
  ) {}

  // 두 공급자의 현재 CLI·스킬·MCP 상태를 매 요청 새로 확인한다.
  async status(): Promise<{ integrations: AgentIntegrationStatus[] }> {
    const integrations = await Promise.all([this.providerStatus("codex"), this.providerStatus("claude")]);
    return { integrations };
  }

  // 한 공급자의 설치 여부와 web-agent-manager 연동 완성 여부를 계산한다.
  private async providerStatus(provider: AgentIntegrationProvider): Promise<AgentIntegrationStatus> {
    const executable = this.runtime.findExecutable(provider);
    const skillsInstalled = globalAgentSkillsInstalled(provider, this.config.homeDir, this.config.rootDir);
    if (!executable) {
      return { provider, cliInstalled: false, cliPath: null, version: null, skillsInstalled, mcpInstalled: false, ready: false };
    }
    const [versionResult, mcpResult] = await Promise.all([
      this.runtime.run(executable, ["--version"]),
      this.runtime.run(executable, provider === "codex" ? ["mcp", "get", MCP_SERVER_NAME, "--json"] : ["mcp", "get", MCP_SERVER_NAME]),
    ]);
    const version = (versionResult.stdout || versionResult.stderr).trim().split("\n", 1)[0].slice(0, 200) || null;
    const mcpInstalled = mcpResult.status === 0;
    return {
      provider,
      cliInstalled: true,
      cliPath: executable,
      version,
      skillsInstalled,
      mcpInstalled,
      ready: skillsInstalled && mcpInstalled,
    };
  }

  // 명시적으로 선택한 공급자에 글로벌 스킬과 사용자 범위 stdio MCP를 설치한다.
  async install(provider: AgentIntegrationProvider): Promise<{ integration: AgentIntegrationStatus; skills: SkillInstallResult }> {
    const executable = this.runtime.findExecutable(provider);
    if (!executable) throw new Error(`${provider} CLI가 설치되어 있지 않습니다.`);
    const skills = installGlobalAgentSkills(provider, this.config.homeDir, this.config.rootDir);
    if (skills.errors.length) throw new Error(skills.errors.join("\n"));
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
    return { integration: await this.providerStatus(provider), skills };
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
