import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { UsageRecord } from "../src/shared/types";
import { openDatabase } from "../src/server/core/database";
import { UsageMonitor } from "../src/server/services/usage-monitor";

const temporaryDirectories: string[] = [];

// 리셋 문구에 날짜를 붙여 "오늘 그 시각" 보정(reconcile·implausible)이 개입하지 않게 한 사용량 값을 만든다.
function usageRecord(sessionPercent: number, weeklyPercent: number): Partial<UsageRecord> {
  const windows = [
    { id: "session", label: "Current session", usedPercent: sessionPercent, remainingPercent: 100 - sessionPercent, resetAt: "Aug 22, 3:00am (Asia/Seoul)" },
    { id: "weekly_all", label: "Current week (all models)", usedPercent: weeklyPercent, remainingPercent: 100 - weeklyPercent, resetAt: "Aug 22, 12:59am (Asia/Seoul)" },
  ];
  return {
    provider: "claude",
    summary: windows.map((window) => `${window.label}: ${window.usedPercent}% used`).join("\n"),
    used_percent: sessionPercent,
    remaining_percent: 100 - sessionPercent,
    reset_at: windows[0].resetAt,
    details_json: JSON.stringify({ windows, activity: [] }),
    data_status: "fresh",
    error_code: null,
  };
}

// 같은 창인데 값이 줄어든(=거부 대상) 응답만 계속 돌려주는 조회 대상을 만든다.
function buildMonitor() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-adopt-"));
  temporaryDirectories.push(dataDir);
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  const accountId = (database.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number }).id;
  const adapter = { id: "claude", parseUsage: () => usageRecord(10, 20) } as unknown as ProviderAdapter;
  const monitor = new UsageMonitor(database, [adapter], { broadcast: vi.fn() } as never, {} as never);
  const state = { adapter, account: { id: accountId }, rejectedStreak: 0, terminal: { write: vi.fn() }, busy: true };
  const previous = usageRecord(90, 95);
  database.prepare(`
    INSERT INTO usage_status(provider, account_id, monitor_status, data_status, summary, used_percent, remaining_percent, reset_at, details_json, last_success_at)
    VALUES ('claude', ?, 'ready', 'fresh', @summary, @used_percent, @remaining_percent, @reset_at, @details_json, '2026-08-15T02:33:09.276Z')
  `.replace("?", String(accountId))).run(previous);
  return { database, monitor, state, accountId };
}

// usage_status의 claude 행을 읽는다.
function readStatus(database: ReturnType<typeof openDatabase>): UsageRecord {
  return database.prepare("SELECT * FROM usage_status WHERE provider = 'claude'").get() as UsageRecord;
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("연속 거부 시 최신값 채택", () => {
  it("4회까지는 마지막 정상값을 지키고 5회째에 최신값을 반영한다", async () => {
    const { database, monitor, state } = buildMonitor();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await (monitor as any).finishUsage(state, "screen");
      const status = readStatus(database);
      expect(status.data_status).toBe("stale");
      expect(status.used_percent).toBe(90);
      expect(status.last_success_at).toBe("2026-08-15T02:33:09.276Z");
    }

    await (monitor as any).finishUsage(state, "screen");
    const adopted = readStatus(database);
    expect(adopted.data_status).toBe("fresh");
    expect(adopted.used_percent).toBe(10);
    expect(adopted.last_success_at).not.toBe("2026-08-15T02:33:09.276Z");
    // 채택 후에는 다시 처음부터 거부를 세어 옛 스냅샷 차단이 계속 동작한다.
    expect(state.rejectedStreak).toBe(0);
    database.close();
  });

  it("거부가 끊기면 연속 횟수도 초기화된다", async () => {
    const { database, monitor, state } = buildMonitor();

    await (monitor as any).finishUsage(state, "screen");
    await (monitor as any).finishUsage(state, "screen");
    expect(state.rejectedStreak).toBe(2);

    // 정상적으로 늘어난 값이 오면 그대로 반영되고 누적된 거부 횟수는 사라진다.
    (state.adapter as any).parseUsage = () => usageRecord(96, 97);
    await (monitor as any).finishUsage(state, "screen");
    expect(state.rejectedStreak).toBe(0);
    expect(readStatus(database).used_percent).toBe(96);
    database.close();
  });
});
