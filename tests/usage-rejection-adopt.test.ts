import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { UsageRecord } from "../src/shared/types";
import { ClaudeAdapter } from "../src/server/providers/claude";
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
  const observe = vi.fn();
  const monitor = new UsageMonitor(database, [adapter], { broadcast: vi.fn() } as never, {} as never, { observe } as never);
  const state = { adapter, account: { id: accountId }, rejectedStreak: 0, terminal: { write: vi.fn(), kill: vi.fn() }, busy: true };
  const previous = usageRecord(90, 95);
  database.prepare(`
    INSERT INTO usage_status(provider, account_id, monitor_status, data_status, summary, used_percent, remaining_percent, reset_at, details_json, last_success_at)
    VALUES ('claude', ?, 'ready', 'fresh', @summary, @used_percent, @remaining_percent, @reset_at, @details_json, '2026-08-15T02:33:09.276Z')
  `.replace("?", String(accountId))).run(previous);
  return { database, monitor, state, accountId, observe };
}

// usage_status의 claude 행을 읽는다.
function readStatus(database: ReturnType<typeof openDatabase>): UsageRecord {
  return database.prepare("SELECT * FROM usage_status WHERE provider = 'claude'").get() as UsageRecord;
}

afterEach(() => {
  vi.useRealTimers();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("연속 감소 관측 보호", () => {
  it("횟수만으로 낮은 값을 채택하지 않고 5회째 조회 PTY를 새로 확인한다", async () => {
    const { database, monitor, state } = buildMonitor();

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await (monitor as any).finishUsage(state, "screen");
      const status = readStatus(database);
      expect(status.data_status).toBe("stale");
      expect(status.used_percent).toBe(90);
      expect(status.last_success_at).toBe("2026-08-15T02:33:09.276Z");
    }
    expect(state.terminal.kill).toHaveBeenCalledTimes(1);
    expect((state as any).recycling).toBe(true);
    expect(state.rejectedStreak).toBe(1);
    database.close();
  });

  it("PTY 재확인 뒤 reset 시각이 전진한 낮은 fresh 값은 실제 새 창으로 채택한다", async () => {
    const { database, monitor, state, observe } = buildMonitor();
    for (let attempt = 0; attempt < 5; attempt += 1) await (monitor as any).finishUsage(state, "old-window");
    expect(state.terminal.kill).toHaveBeenCalledTimes(1);
    expect(readStatus(database).used_percent).toBe(90);

    const nextWindow = usageRecord(2, 4);
    const nextDetails = JSON.parse(nextWindow.details_json!);
    nextDetails.windows[0].resetAt = "Aug 23, 8:00am (Asia/Seoul)";
    nextDetails.windows[1].resetAt = "Aug 29, 12:59am (Asia/Seoul)";
    Object.assign(nextWindow, {
      reset_at: nextDetails.windows[0].resetAt,
      details_json: JSON.stringify(nextDetails),
    });
    (state.adapter as any).parseUsage = () => nextWindow;
    (state as any).recycling = false;
    await (monitor as any).finishUsage(state, "new-window");

    expect(readStatus(database)).toMatchObject({ data_status: "fresh", used_percent: 2, error_code: null });
    expect(observe).toHaveBeenCalledTimes(1);
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

  it("세션 Resets가 빠진 주간만 있는 화면은 마지막 5시간 값을 덮지 않는다", async () => {
    vi.useFakeTimers();
    const { database, monitor, state } = buildMonitor();
    const adapter = new ClaudeAdapter("/tmp/x.json", {});
    (state.adapter as any).parseUsage = (output: string) => adapter.parseUsage(output);
    await (monitor as any).finishUsage(state, `Current session
0% 0% used
Current week (all models)
4% 4% used
Resets Sep 5, 1am (Asia/Seoul)
Esc to cancel`);
    expect(readStatus(database)).toMatchObject({
      used_percent: 90,
      data_status: "stale",
      last_success_at: "2026-08-15T02:33:09.276Z",
    });
    const details = JSON.parse(readStatus(database).details_json!);
    expect(details.windows[0]).toMatchObject({ id: "session", usedPercent: 90 });
    expect((state as any).pendingKeepalive?.reason).toBe("claude_session_zero");
    expect((state as any).usageKeepaliveTrusted).toBe(true);
    database.close();
  });

  it("저장된 세션 리셋이 지났고 Resets가 없으면 0%로 바꾸고 keepalive를 예약한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T13:21:00.000Z"));
    const { database, monitor, state } = buildMonitor();
    const windows = [
      { id: "session", label: "Current session", usedPercent: 14, remainingPercent: 86, resetAt: "8:50pm (Asia/Seoul)" },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 21, remainingPercent: 79, resetAt: "Sep 5, 1am (Asia/Seoul)" },
    ];
    database.prepare(`
      UPDATE usage_status SET used_percent = 14, remaining_percent = 86, reset_at = ?, summary = ?, details_json = ?
      WHERE provider = 'claude'
    `).run("8:50pm (Asia/Seoul)", "Current session: 14% used\nCurrent week (all models): 21% used", JSON.stringify({ windows, activity: [] }));
    const adapter = new ClaudeAdapter("/tmp/x.json", {});
    (state.adapter as any).parseUsage = (output: string) => adapter.parseUsage(output, new Date());
    await (monitor as any).finishUsage(state, `Current session
0% 0% used
Current week (all models)
21% 21% used
Resets Sep 5, 1am (Asia/Seoul)
Esc to cancel`);
    expect(readStatus(database)).toMatchObject({
      data_status: "fresh",
      used_percent: 0,
      remaining_percent: 100,
      reset_at: "1:50am (Asia/Seoul)",
      error_code: null,
    });
    expect((state as any).pendingKeepalive?.reason).toBe("claude_session_zero");
    database.close();
  });

  it("같은 날짜 주간 0%는 2회 뒤 PTY 재시작 후 조회가 0%일 때 확정한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T01:55:00.000Z"));
    const { database, monitor, state } = buildMonitor();
    const windows = [
      { id: "session", label: "Current session", usedPercent: 1, remainingPercent: 99, resetAt: "3:49am (Asia/Seoul)" },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 21, remainingPercent: 79, resetAt: "Sep 5, 12:59am (Asia/Seoul)" },
    ];
    database.prepare(`
      UPDATE usage_status SET used_percent = 1, remaining_percent = 99, reset_at = ?, summary = ?, details_json = ?
      WHERE provider = 'claude'
    `).run("3:49am (Asia/Seoul)", "Current session: 1% used\nCurrent week (all models): 21% used", JSON.stringify({ windows, activity: [] }));
    const adapter = new ClaudeAdapter("/tmp/x.json", {});
    (state.adapter as any).parseUsage = (output: string) => adapter.parseUsage(output, new Date());
    (state.adapter as any).usageWindowId = "session";
    const screen = `Current session
0% 0% used
Resets 1:50pm (Asia/Seoul)
Current week (all models)
0% 0% used
Resets Sep 5, 1am (Asia/Seoul)
Esc to cancel`;
    await (monitor as any).finishUsage(state, screen);
    expect(JSON.parse(readStatus(database).details_json!).windows[1]).toMatchObject({ id: "weekly_all", usedPercent: 21 });
    expect((state as any).zeroConfirmRecycled).toBeFalsy();
    await (monitor as any).finishUsage(state, screen);
    expect(readStatus(database)).toMatchObject({ data_status: "fresh", used_percent: 0, reset_at: "1:50pm (Asia/Seoul)" });
    expect(JSON.parse(readStatus(database).details_json!).windows[1]).toMatchObject({ usedPercent: 21 });
    expect(state.terminal.kill).toHaveBeenCalledTimes(1);
    expect((state as any).zeroConfirmRecycled).toBe(true);

    (state as any).recycling = false;
    await (monitor as any).finishUsage(state, screen);
    expect(JSON.parse(readStatus(database).details_json!).windows).toEqual([
      { id: "session", label: "Current session", usedPercent: 0, remainingPercent: 100, resetAt: "1:50pm (Asia/Seoul)" },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 0, remainingPercent: 100, resetAt: "Sep 5, 1am (Asia/Seoul)" },
    ]);
    expect((state as any).zeroConfirmStreak).toBe(0);
    expect((state as any).zeroConfirmRecycled).toBe(false);
    database.close();
  });

  it("Claude 상세 조회 fallback의 1%는 반복돼도 마지막 정상값을 덮지 않는다", async () => {
    const { database, monitor, state, observe } = buildMonitor();
    const adapter = new ClaudeAdapter("/tmp/x.json", {});
    const fallbackScreen = `Current session
1% 1% used
Resets Aug 22, 3:00am (Asia/Seoul)
Current week (all models)
1% 1% used
Resets Aug 22, 12:59am (Asia/Seoul)
Per-model breakdown unavailable (rate limited — try again in a moment)
r to retry · Esc to cancel`;
    (state.adapter as any).parseUsage = (output: string) => adapter.parseUsage(output);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await (monitor as any).finishUsage(state, fallbackScreen);
      const status = readStatus(database);
      expect(status.used_percent).toBe(90);
      expect(status.data_status).toBe("stale");
      expect(status.error_code).toBe("usage_seeded_headers_throttled");
      expect(status.last_success_at).toBe("2026-08-15T02:33:09.276Z");
    }
    expect(state.rejectedStreak).toBe(0);
    expect((state as any).usageFallbackStreak).toBe(6);
    expect((state as any).usagePollNotBeforeAt).toBeGreaterThan(Date.now());
    expect(observe).not.toHaveBeenCalled();
    database.close();
  });

  it("non-fresh가 사이에 끼면 감소 거부 연속 횟수를 초기화한다", async () => {
    const { database, monitor, state } = buildMonitor();
    for (let attempt = 0; attempt < 4; attempt += 1) await (monitor as any).finishUsage(state, "screen");
    expect(state.rejectedStreak).toBe(4);

    (state.adapter as any).parseUsage = () => ({ provider: "claude", data_status: "stale", error_code: "usage_seeded_headers_throttled" });
    await (monitor as any).finishUsage(state, "fallback");
    expect(state.rejectedStreak).toBe(0);

    (state.adapter as any).parseUsage = () => usageRecord(10, 20);
    await (monitor as any).finishUsage(state, "screen");
    expect(state.rejectedStreak).toBe(1);
    expect(readStatus(database).used_percent).toBe(90);
    expect(state.terminal.kill).not.toHaveBeenCalled();
    database.close();
  });

  it("fallback 백오프 동안 자동 조회는 건너뛰고 사용자 수동 조회는 허용한다", () => {
    const { database, monitor, state } = buildMonitor();
    Object.assign(state, {
      busy: false,
      usagePollNotBeforeAt: Date.now() + 10 * 60_000,
      terminalStartedAt: Date.now(),
      screen: { reset: vi.fn(), text: vi.fn(() => "screen") },
    });
    (state.adapter as any).usageCommands = ["/usage"];
    state.terminal.write.mockClear();

    (monitor as any).requestUsage(state);
    expect(state.terminal.write).not.toHaveBeenCalled();
    expect(state.busy).toBe(false);

    (monitor as any).requestUsage(state, true);
    expect(state.terminal.write).toHaveBeenCalledWith("/usage\r");
    expect(state.busy).toBe(true);
    clearTimeout((state as any).parseTimer);
    database.close();
  });
});

describe("사용량 리셋 알림은 계정별로 관찰한다", () => {
  it("finishUsage는 기본·추가 계정의 독립 accountId로 observe를 호출한다", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-observe-scope-"));
    temporaryDirectories.push(dataDir);
    const database = openDatabase({ dataDir } as unknown as AppConfig);
    const defaultAccount = database.prepare("SELECT * FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number; is_default: number };
    database.prepare(`
      INSERT INTO agent_accounts(provider, label, slug, config_dir, is_default)
      VALUES ('claude', '추가 계정', 'extra', ?, 0)
    `).run(path.join(dataDir, "extra-claude"));
    const extraAccount = database.prepare("SELECT * FROM agent_accounts WHERE provider = 'claude' AND is_default = 0").get() as { id: number; is_default: number };
    const observed: Array<{ provider: string; details: string | null | undefined; accountId: number | undefined }> = [];
    const adapter = { id: "claude", parseUsage: () => usageRecord(12, 30) } as unknown as ProviderAdapter;
    const monitor = new UsageMonitor(
      database,
      [adapter],
      { broadcast: vi.fn() } as never,
      {} as never,
      { observe: (provider: string, details: string | null | undefined, _observedAt: Date, accountId: number | undefined) => { observed.push({ provider, details, accountId }); } } as never,
    );
    const defaultState = { adapter, account: defaultAccount, rejectedStreak: 0, terminal: { write: vi.fn() }, busy: true };
    const extraState = { adapter, account: extraAccount, rejectedStreak: 0, terminal: { write: vi.fn() }, busy: true };

    await (monitor as any).finishUsage(defaultState, "screen");
    await (monitor as any).finishUsage(extraState, "screen");

    expect(observed).toHaveLength(2);
    expect(observed.map((item) => item.accountId)).toEqual([defaultAccount.id, extraAccount.id]);
    expect(observed.every((item) => item.provider === "claude" && item.details?.includes("\"usedPercent\":12"))).toBe(true);
    database.close();
  });
});
