import type { IPty } from "node-pty";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { RealtimeHub } from "../src/server/services/realtime";
import { CliAuthManager, type CliAuthRuntime } from "../src/server/services/cli-auth";
import type { AgentAccountService } from "../src/server/services/agent-accounts";
import type { AgentAccountRecord, Provider } from "../src/shared/types";

// 인증 테스트에 필요한 최소 설정을 만든다.
function config(): AppConfig {
  return { homeDir: "/tmp/web-agent-manager-auth" } as AppConfig;
}

// 공급자마다 기본 계정 하나만 가진 계정 서비스를 흉내낸다(계정 슬롯 도입 전과 같은 조건).
function accounts(): AgentAccountService {
  const record = (provider: Provider): AgentAccountRecord => ({
    id: provider === "claude" ? 1 : 2,
    provider,
    label: `기본 ${provider} 계정`,
    slug: "default",
    config_dir: null,
    is_default: 1,
    created_at: "",
    updated_at: "",
  });
  return {
    list: (provider: Provider) => [record(provider)],
    requireForProvider: (provider: Provider) => record(provider),
  } as unknown as AgentAccountService;
}

// 인증 이벤트 핸들러와 브로드캐스트 호출을 기록하는 실시간 허브를 만든다.
function realtime(events: Array<{ type: string; payload: unknown }>): RealtimeHub {
  return {
    setAuthTerminalHandlers: () => undefined,
    broadcast: (type: string, payload: unknown) => events.push({ type, payload }),
    authTerminal: () => undefined,
  } as unknown as RealtimeHub;
}

// 종료 콜백을 제어할 수 있는 가짜 인증 PTY를 만든다.
function terminal(onExitReady: (callback: (event: { exitCode: number; signal?: number }) => void) => void): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
      onExitReady(callback);
      return { dispose: () => undefined };
    },
    write: () => undefined,
    kill: () => undefined,
  } as unknown as IPty;
}

describe("CLI 인증 상태 캐시", () => {
  it("서버 초기화 뒤 반복 조회에서는 인증 명령을 다시 실행하지 않는다", async () => {
    const calls: string[] = [];
    const runtime: CliAuthRuntime = {
      findExecutable: (command) => `/usr/local/bin/${command}`,
      commandSucceeds: async (command) => {
        calls.push(path.basename(command));
        return true;
      },
      spawn: () => { throw new Error("호출되면 안 됩니다."); },
    };
    const manager = new CliAuthManager(config(), realtime([]), accounts(), runtime);

    const [first, second] = await Promise.all([manager.status(), manager.status()]);
    await manager.status();

    expect(first.providers.every((provider) => provider.authenticated)).toBe(true);
    expect(second).toEqual(first);
    expect(calls.sort()).toEqual(["claude", "codex", "gh", "grok"]);
  });

  // grok은 로그인하지 않아도 상태 명령이 정상 종료하고 본문에만 미인증 문구를 찍는다. 종료 코드만
  // 보면 항상 "로그인됨"으로 잘못 표시되므로 출력으로 판정해야 한다.
  it("grok은 종료 코드가 아니라 상태 명령 출력으로 로그인 여부를 판정한다", async () => {
    const build = (output: string): CliAuthRuntime => ({
      findExecutable: (command) => `/usr/local/bin/${command}`,
      commandSucceeds: async () => true,
      commandOutput: async (command) => (path.basename(command) === "grok" ? output : ""),
      spawn: () => { throw new Error("호출되면 안 됩니다."); },
    });
    const grokStatus = async (output: string) => {
      const manager = new CliAuthManager(config(), realtime([]), accounts(), build(output));
      const status = await manager.status();
      return status.providers.find((provider) => provider.provider === "grok")!;
    };
    expect((await grokStatus("You are logged in with grok.com.\n\nDefault model: grok-4.6")).authenticated).toBe(true);
    expect((await grokStatus("You are not authenticated.\n\nDefault model: grok-4.6")).authenticated).toBe(false);
  });

  it("로그인 PTY 종료 뒤 해당 공급자만 한 번 재검사한다", async () => {
    const calls: string[] = [];
    const authenticated = new Set(["codex", "gh"]);
    const events: Array<{ type: string; payload: unknown }> = [];
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const runtime: CliAuthRuntime = {
      findExecutable: (command) => `/usr/local/bin/${command}`,
      commandSucceeds: async (command) => {
        const provider = path.basename(command);
        calls.push(provider);
        return authenticated.has(provider);
      },
      spawn: () => terminal((callback) => { exit = callback; }),
    };
    const manager = new CliAuthManager(config(), realtime(events), accounts(), runtime);
    await manager.initialize();
    authenticated.add("claude");

    manager.start("claude", 1);
    exit?.({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await manager.status()).providers.find((provider) => provider.provider === "claude")).toMatchObject({
      authenticated: true,
      running: false,
      exitCode: 0,
    });
    expect(calls.filter((command) => command === "claude")).toHaveLength(2);
    expect(events).toContainEqual({ type: "cli_auth_changed", payload: { provider: "claude", accountId: 1, exitCode: 0 } });
  });
});
