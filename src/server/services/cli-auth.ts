import { execFile } from "node:child_process";
import pty, { type IPty } from "node-pty";
import type { AppConfig } from "../core/config";
import type { AuthUser } from "../../shared/types";
import type { RealtimeHub } from "./realtime";
import { findExecutable } from "./agent-integration";
import { CONFIG_DIR_ENV, type AgentAccountService } from "./agent-accounts";

export type CliAuthProvider = "codex" | "claude" | "grok" | "github";

export interface CliAuthStatus {
  provider: CliAuthProvider;
  // 계정 슬롯 ID. GitHub은 계정 슬롯 개념이 없어 null이다.
  accountId: number | null;
  accountLabel: string | null;
  // 로그인 터미널 구독·입력에 쓰는 식별자("github", "claude:3" 형태).
  key: string;
  installed: boolean;
  authenticated: boolean;
  running: boolean;
  exitCode: number | null;
}

// 공급자와 계정 슬롯을 하나의 터미널 식별자로 합친다. GitHub은 계정 구분이 없어 공급자 이름만 쓴다.
export function authSessionKey(provider: CliAuthProvider, accountId: number | null): string {
  return accountId == null ? provider : `${provider}:${accountId}`;
}

interface AuthTerminalSession {
  pty: IPty;
  output: string;
  running: boolean;
  exitCode: number | null;
}

export interface CliAuthRuntime {
  findExecutable(command: string): string | null;
  commandSucceeds(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<boolean>;
  // 종료 코드만으로는 인증 여부를 알 수 없는 CLI를 위한 경로다(grok은 로그인하지 않아도 상태 명령이
  // 정상 종료하고 본문에만 "You are not authenticated."를 찍는다). 출력은 판정에만 쓰고 밖으로 넘기지 않는다.
  commandOutput?(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string>;
  spawn(command: string, args: string[], options: Parameters<typeof pty.spawn>[2]): IPty;
}

const AUTH_COMMANDS: Record<CliAuthProvider, { executable: string; args: string[] }> = {
  codex: { executable: "codex", args: ["login", "--device-auth"] },
  claude: { executable: "claude", args: ["auth", "login", "--claudeai"] },
  grok: { executable: "grok", args: ["login"] },
  github: { executable: "gh", args: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"] },
};

// unauthenticatedPattern이 있는 공급자는 종료 코드 대신 출력으로 판정한다(grok은 미인증 상태에서도
// 상태 명령이 0으로 끝나 종료 코드만 보면 항상 "로그인됨"으로 잘못 표시된다).
const STATUS_COMMANDS: Record<CliAuthProvider, { executable: string; args: string[]; unauthenticatedPattern?: RegExp }> = {
  codex: { executable: "codex", args: ["login", "status"] },
  claude: { executable: "claude", args: ["auth", "status", "--json"] },
  grok: { executable: "grok", args: ["models"], unauthenticatedPattern: /not authenticated|not logged in/i },
  github: { executable: "gh", args: ["auth", "status", "--hostname", "github.com"] },
};

// 제한된 CLI 상태 명령의 종료 코드만 확인하고 출력 내용은 외부에 노출하지 않는다.
// env로 계정 슬롯의 설정 디렉터리를 지정하면 그 계정의 인증 여부만 확인한다.
function commandSucceeds(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 15_000, maxBuffer: 256 * 1024, env: { ...process.env, ...env } }, (error) => resolve(!error));
  });
}

// 상태 명령의 출력만 읽어온다. 호출부가 미인증 문구만 확인하고 버리며, 응답·로그로는 내보내지 않는다.
function commandOutput(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 15_000, maxBuffer: 256 * 1024, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve(error && !stdout && !stderr ? "" : `${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });
}

const DEFAULT_RUNTIME: CliAuthRuntime = { findExecutable, commandSucceeds, commandOutput, spawn: pty.spawn };

// Codex·Claude·GitHub 공식 로그인 흐름을 관리자 전용 PTY로 제공한다.
// Codex·Claude는 계정 슬롯마다 설정 디렉터리가 달라 로그인도 계정별로 따로 진행한다.
export class CliAuthManager {
  private readonly sessions = new Map<string, AuthTerminalSession>();
  private readonly statuses = new Map<string, Omit<CliAuthStatus, "running" | "exitCode">>();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly realtime: RealtimeHub,
    private readonly accounts: AgentAccountService,
    private readonly runtime: CliAuthRuntime = DEFAULT_RUNTIME,
  ) {
    realtime.setAuthTerminalHandlers(
      (key, data, user) => this.input(key, data, user),
      (key, user) => this.subscribe(key, user),
    );
  }

  // 로그인 대상 목록을 만든다. Codex·Claude는 등록된 계정 슬롯마다 하나씩, GitHub은 하나뿐이다.
  private targets(): Array<{ provider: CliAuthProvider; accountId: number | null; accountLabel: string | null; configDir: string | null }> {
    const list: Array<{ provider: CliAuthProvider; accountId: number | null; accountLabel: string | null; configDir: string | null }> = [];
    for (const provider of ["codex", "claude", "grok"] as const) {
      for (const account of this.accounts.list(provider)) {
        list.push({ provider, accountId: account.id, accountLabel: account.label, configDir: account.config_dir });
      }
    }
    list.push({ provider: "github", accountId: null, accountLabel: null, configDir: null });
    return list;
  }

  // 서버 생명주기에서 CLI 인증 상태를 한 번만 초기화한다.
  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = Promise.all(this.targets().map(async (target) => {
        this.statuses.set(authSessionKey(target.provider, target.accountId), await this.inspectTarget(target));
      })).then(() => undefined);
    }
    return this.initialization;
  }

  // 캐시된 인증 결과와 현재 로그인 PTY 실행 상태를 반환한다.
  // 계정은 언제든 새로 등록될 수 있어, 아직 검사하지 않은 대상은 이 시점에 한 번 확인한다.
  async status(): Promise<{ providers: CliAuthStatus[] }> {
    await this.initialize();
    const providers = await Promise.all(this.targets().map(async (target) => {
      const key = authSessionKey(target.provider, target.accountId);
      let cached = this.statuses.get(key);
      if (!cached) {
        cached = await this.inspectTarget(target);
        this.statuses.set(key, cached);
      }
      const session = this.sessions.get(key);
      return {
        ...cached,
        running: session?.running ?? false,
        exitCode: session?.exitCode ?? null,
      };
    }));
    return { providers };
  }

  // 한 대상의 공식 상태 명령을 그 계정의 설정 디렉터리에서 실행해 설치·인증 여부를 계산한다.
  private async inspectTarget(target: { provider: CliAuthProvider; accountId: number | null; accountLabel: string | null; configDir: string | null }): Promise<Omit<CliAuthStatus, "running" | "exitCode">> {
    const statusCommand = STATUS_COMMANDS[target.provider];
    const executable = this.runtime.findExecutable(statusCommand.executable);
    return {
      provider: target.provider,
      accountId: target.accountId,
      accountLabel: target.accountLabel,
      key: authSessionKey(target.provider, target.accountId),
      installed: !!executable,
      authenticated: executable ? await this.isAuthenticated(executable, statusCommand, target) : false,
    };
  }

  // 상태 명령으로 로그인 여부를 판정한다. 미인증 문구가 정의된 공급자는 종료 코드가 아니라 그 문구로 본다.
  private async isAuthenticated(executable: string, statusCommand: (typeof STATUS_COMMANDS)[CliAuthProvider], target: { provider: CliAuthProvider; configDir: string | null }): Promise<boolean> {
    const environment = this.targetEnvironment(target);
    if (statusCommand.unauthenticatedPattern && this.runtime.commandOutput) {
      const output = await this.runtime.commandOutput(executable, statusCommand.args, this.config.homeDir, environment);
      return !!output.trim() && !statusCommand.unauthenticatedPattern.test(output);
    }
    return this.runtime.commandSucceeds(executable, statusCommand.args, this.config.homeDir, environment);
  }

  // 계정 슬롯의 설정 디렉터리를 환경변수로 만든다. 기본 계정과 GitHub은 주입하지 않는다.
  private targetEnvironment(target: { provider: CliAuthProvider; configDir: string | null }): Record<string, string> {
    if (target.provider === "github" || !target.configDir) return {};
    return { [CONFIG_DIR_ENV[target.provider]]: target.configDir };
  }

  // 로그인 종료 뒤 해당 대상만 재검사하고 갱신 이벤트를 보낸다.
  private async refreshAfterExit(target: { provider: CliAuthProvider; accountId: number | null; accountLabel: string | null; configDir: string | null }, exitCode: number): Promise<void> {
    this.statuses.set(authSessionKey(target.provider, target.accountId), await this.inspectTarget(target));
    this.realtime.broadcast("cli_auth_changed", { provider: target.provider, accountId: target.accountId, exitCode });
  }

  // 선택한 계정의 공식 로그인 명령을 새 PTY에서 시작한다. 계정 슬롯의 설정 디렉터리를 지정해 실행하므로
  // 그 계정 폴더에만 인증이 저장되고 다른 계정의 인증은 그대로 남는다.
  start(provider: CliAuthProvider, accountId: number | null): void {
    const command = AUTH_COMMANDS[provider];
    if (!command) throw new Error("지원하지 않는 인증 공급자입니다.");
    const target = this.requireTarget(provider, accountId);
    const key = authSessionKey(provider, target.accountId);
    const existing = this.sessions.get(key);
    if (existing?.running) return;
    const executable = this.runtime.findExecutable(command.executable);
    if (!executable) throw new Error(`${command.executable} CLI가 설치되어 있지 않습니다.`);
    const child = this.runtime.spawn(executable, command.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: this.config.homeDir,
      env: {
        ...process.env,
        HOME: this.config.homeDir,
        BROWSER: "echo",
        GH_BROWSER: "echo",
        TERM: "xterm-256color",
        ...this.targetEnvironment(target),
      } as Record<string, string>,
    });
    const session: AuthTerminalSession = { pty: child, output: "", running: true, exitCode: null };
    this.sessions.set(key, session);
    child.onData((data) => {
      session.output = `${session.output}${data}`.slice(-200_000);
      this.realtime.authTerminal(key, data);
    });
    child.onExit(({ exitCode }) => {
      session.running = false;
      session.exitCode = exitCode;
      void this.refreshAfterExit(target, exitCode);
    });
  }

  // 요청한 공급자·계정 조합이 실제로 등록된 대상인지 확인한다.
  private requireTarget(provider: CliAuthProvider, accountId: number | null): { provider: CliAuthProvider; accountId: number | null; accountLabel: string | null; configDir: string | null } {
    if (provider === "github") return { provider, accountId: null, accountLabel: null, configDir: null };
    const account = this.accounts.requireForProvider(provider, accountId);
    return { provider, accountId: account.id, accountLabel: account.label, configDir: account.config_dir };
  }

  // 실행 중인 인증 PTY에 키 입력을 전달한다.
  input(key: string, data: string, user: AuthUser): void {
    if (user.role !== "admin") return;
    const session = this.sessions.get(key);
    if (session?.running) session.pty.write(data);
  }

  // 인증 터미널 구독 시 지금까지의 출력 스냅샷을 전달한다.
  subscribe(key: string, user: AuthUser): void {
    if (user.role !== "admin") return;
    const session = this.sessions.get(key);
    if (session?.output) this.realtime.authTerminal(key, session.output);
  }

  // 선택한 인증 흐름을 중단한다.
  stop(provider: CliAuthProvider, accountId: number | null): void {
    const session = this.sessions.get(authSessionKey(provider, accountId));
    if (!session?.running) return;
    session.pty.kill();
    session.running = false;
  }

  // 서버 종료 시 WAM이 시작한 로그인 PTY만 정리한다.
  close(): void {
    for (const session of this.sessions.values()) if (session.running) session.pty.kill();
    this.sessions.clear();
  }
}
