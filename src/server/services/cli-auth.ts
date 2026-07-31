import { execFile } from "node:child_process";
import pty, { type IPty } from "node-pty";
import type { AppConfig } from "../core/config";
import type { AuthUser } from "../../shared/types";
import type { RealtimeHub } from "./realtime";
import { findExecutable } from "./agent-integration";

export type CliAuthProvider = "codex" | "claude" | "github";

export interface CliAuthStatus {
  provider: CliAuthProvider;
  installed: boolean;
  authenticated: boolean;
  running: boolean;
  exitCode: number | null;
}

interface AuthTerminalSession {
  pty: IPty;
  output: string;
  running: boolean;
  exitCode: number | null;
}

const AUTH_COMMANDS: Record<CliAuthProvider, { executable: string; args: string[] }> = {
  codex: { executable: "codex", args: ["login", "--device-auth"] },
  claude: { executable: "claude", args: ["auth", "login", "--claudeai"] },
  github: { executable: "gh", args: ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"] },
};

const STATUS_COMMANDS: Record<CliAuthProvider, { executable: string; args: string[] }> = {
  codex: { executable: "codex", args: ["login", "status"] },
  claude: { executable: "claude", args: ["auth", "status", "--json"] },
  github: { executable: "gh", args: ["auth", "status", "--hostname", "github.com"] },
};

// 제한된 CLI 상태 명령의 종료 코드만 확인하고 출력 내용은 외부에 노출하지 않는다.
function commandSucceeds(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 15_000, maxBuffer: 256 * 1024, env: process.env }, (error) => resolve(!error));
  });
}

// Codex·Claude·GitHub 공식 로그인 흐름을 관리자 전용 PTY로 제공한다.
export class CliAuthManager {
  private readonly sessions = new Map<CliAuthProvider, AuthTerminalSession>();

  constructor(private readonly config: AppConfig, private readonly realtime: RealtimeHub) {
    realtime.setAuthTerminalHandlers(
      (provider, data, user) => this.input(provider, data, user),
      (provider, user) => this.subscribe(provider, user),
    );
  }

  // 세 CLI의 설치·인증·로그인 PTY 실행 상태를 반환한다.
  async status(): Promise<{ providers: CliAuthStatus[] }> {
    const providers = await Promise.all((Object.keys(AUTH_COMMANDS) as CliAuthProvider[]).map(async (provider) => {
      const statusCommand = STATUS_COMMANDS[provider];
      const executable = findExecutable(statusCommand.executable);
      const session = this.sessions.get(provider);
      return {
        provider,
        installed: !!executable,
        authenticated: executable ? await commandSucceeds(executable, statusCommand.args, this.config.homeDir) : false,
        running: session?.running ?? false,
        exitCode: session?.exitCode ?? null,
      };
    }));
    return { providers };
  }

  // 선택한 공급자의 공식 로그인 명령을 새 PTY에서 시작한다.
  start(provider: CliAuthProvider): void {
    const command = AUTH_COMMANDS[provider];
    if (!command) throw new Error("지원하지 않는 인증 공급자입니다.");
    const existing = this.sessions.get(provider);
    if (existing?.running) return;
    const executable = findExecutable(command.executable);
    if (!executable) throw new Error(`${command.executable} CLI가 설치되어 있지 않습니다.`);
    const child = pty.spawn(executable, command.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: this.config.homeDir,
      env: { ...process.env, HOME: this.config.homeDir, BROWSER: "echo", GH_BROWSER: "echo", TERM: "xterm-256color" } as Record<string, string>,
    });
    const session: AuthTerminalSession = { pty: child, output: "", running: true, exitCode: null };
    this.sessions.set(provider, session);
    child.onData((data) => {
      session.output = `${session.output}${data}`.slice(-200_000);
      this.realtime.authTerminal(provider, data);
    });
    child.onExit(({ exitCode }) => {
      session.running = false;
      session.exitCode = exitCode;
      this.realtime.broadcast("cli_auth_changed", { provider, exitCode });
    });
  }

  // 실행 중인 인증 PTY에 키 입력을 전달한다.
  input(providerInput: string, data: string, user: AuthUser): void {
    if (user.role !== "admin") return;
    const provider = providerInput as CliAuthProvider;
    const session = this.sessions.get(provider);
    if (session?.running) session.pty.write(data);
  }

  // 인증 터미널 구독 시 지금까지의 출력 스냅샷을 전달한다.
  subscribe(providerInput: string, user: AuthUser): void {
    if (user.role !== "admin") return;
    const provider = providerInput as CliAuthProvider;
    const session = this.sessions.get(provider);
    if (session?.output) this.realtime.authTerminal(provider, session.output);
  }

  // 선택한 인증 흐름을 중단한다.
  stop(provider: CliAuthProvider): void {
    const session = this.sessions.get(provider);
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
