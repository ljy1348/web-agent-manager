import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { UsageRecord } from "../src/shared/types";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { UsageMonitor } from "../src/server/services/usage-monitor";

// 인증 안 된 계정을 무작정 폴링하면 codex·claude 모두 로그인·온보딩 화면에 계속 걸려 파싱이
// 안 됐다(실사용 보고). CliAuthManager의 캐시된 인증 여부로 direct poller와 폴백 PTY를 함께 게이트하고,
// 로그인 완료 시 notifyAuthenticated()로 그제서야 poller를 시작한다.

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function prepare(): { database: AppDatabase; accounts: AgentAccountService; accountId: number } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-gate-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, allowedRoots: ["/"], publicUrl: "http://127.0.0.1:4317" } as AppConfig;
  const database = openDatabase(config);
  cleanup.push(() => database.close());
  const accounts = new AgentAccountService(config, database);
  const accountId = accounts.list("claude")[0].id;
  return { database, accounts, accountId };
}

// pty.spawn이 실제로 실행할 무해한 명령(즉시 종료하는 표준 유닉스 유틸)만 주는 스텁 어댑터.
function stubAdapter(): ProviderAdapter {
  return {
    id: "claude",
    usageCommands: [],
    createLaunch: () => ({ command: "sleep", args: ["2"] }),
    createMonitorLaunch: () => ({ command: "sleep", args: ["2"] }),
    parseUsage: () => ({ data_status: "unavailable" as const }),
    collectUsage: async () => ({
      record: {
        provider: "claude",
        data_status: "fresh" as const,
        error_code: null,
        details_json: JSON.stringify({ windows: [] }),
      },
      snapshot: "{}",
    }),
  } as unknown as ProviderAdapter;
}

function readStatus(database: AppDatabase): UsageRecord {
  return database.prepare("SELECT * FROM usage_status WHERE provider = 'claude'").get() as UsageRecord;
}

describe("사용량 폴링의 인증 게이트", () => {
  it("인증 안 된 계정은 PTY를 안 띄우고 auth_required로 표시한다", () => {
    const { database, accounts, accountId } = prepare();
    const monitor = new UsageMonitor(database, [stubAdapter()], { broadcast: vi.fn() } as never, accounts, undefined, () => false);

    monitor.start();

    const status = readStatus(database);
    expect(status.monitor_status).toBe("error");
    expect(status.error_code).toBe("auth_required");
    expect((monitor as unknown as { monitors: Map<string, { terminal?: unknown }> }).monitors.get(`claude:${accountId}`)?.terminal).toBeUndefined();
    monitor.stop();
  });

  it("notifyAuthenticated를 부르면 PTY 없이 direct poller부터 시작한다", async () => {
    const { database, accounts, accountId } = prepare();
    let authenticated = false;
    const monitor = new UsageMonitor(database, [stubAdapter()], { broadcast: vi.fn() } as never, accounts, undefined, () => authenticated);

    monitor.start();
    expect(readStatus(database).error_code).toBe("auth_required");

    authenticated = true;
    monitor.notifyAuthenticated("claude", accountId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = (monitor as unknown as { monitors: Map<string, { terminal?: unknown; timer?: unknown }> }).monitors.get(`claude:${accountId}`);
    expect(state?.timer).toBeDefined();
    expect(state?.terminal).toBeUndefined();
    monitor.stop();
  });

  it("CLI 업데이트 후 구버전 모델 캐시를 비우고 direct 조회를 유지한다", async () => {
    const { database, accounts } = prepare();
    const monitor = new UsageMonitor(database, [stubAdapter()], { broadcast: vi.fn() } as never, accounts, undefined, () => true);
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const internal = monitor as unknown as { monitors: Map<string, { terminal?: { pid: number }; timer?: unknown; modelOptions?: unknown }> };
    const state = [...internal.monitors.values()][0];
    state.modelOptions = { provider: "claude", models: [{ id: "old" }] };

    expect(monitor.restartProviderTerminals("claude")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(state.modelOptions).toBeUndefined();
    expect(state.timer).toBeDefined();
    expect(state.terminal).toBeUndefined();
    monitor.stop();
  });
});
