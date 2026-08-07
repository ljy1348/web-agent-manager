import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { Notifier } from "../src/server/services/notifier";
import type { RealtimeHub } from "../src/server/services/realtime";
import { parseUsageResetMoment, UsageResetNotifier } from "../src/server/services/usage-reset-notifier";

const temporaryDirectories: string[] = [];

// 실제 SQLite와 가짜 알림 채널을 연결한 초기화 알림 서비스 테스트 구성을 만든다.
function buildService(now: Date) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-reset-"));
  temporaryDirectories.push(dataDir);
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  const notificationsSent: Array<{ eventId: string; eventType: string; text: string }> = [];
  const realtimeSent: Array<{ type: string; payload: unknown }> = [];
  const notifications: Notifier = { notify: async (eventId, eventType, text) => { notificationsSent.push({ eventId, eventType, text }); } };
  const realtime = { broadcast: (type: string, payload: unknown) => { realtimeSent.push({ type, payload }); } } as unknown as RealtimeHub;
  const adapters = [
    { id: "codex", displayLabel: "Codex", usageWindowId: "weekly", usageResetWindowIds: ["weekly"] },
    { id: "claude", displayLabel: "Claude", usageWindowId: "session", usageResetWindowIds: ["session", "weekly_all"] },
  ] as ProviderAdapter[];
  const service = new UsageResetNotifier(database, notifications, realtime, adapters);
  return { database, service, notificationsSent, realtimeSent, adapters, notifications, realtime };
}

// 테스트별 가짜 시계와 임시 DB를 원상복구한다.
afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("UsageResetNotifier", () => {
  it("예정 초기화 시각 1분 뒤에는 사용량 재확인 없이 알림을 보낸다", async () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const { service, notificationsSent, realtimeSent } = buildService(now);
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 80, remainingPercent: 20, resetAt: "9:01am (Asia/Seoul)" },
    ] }), now);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(notificationsSent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(notificationsSent).toHaveLength(1);
    expect(notificationsSent[0]).toMatchObject({ eventType: "usage_session_reset", text: "Claude 세션 사용량이 초기화되었습니다." });
    expect(realtimeSent).toEqual([{ type: "usage_session_reset", payload: { provider: "claude", label: "Claude", windowId: "session", windowLabel: "세션", detectedEarly: false } }]);
  });

  it("Claude 세션과 전체 모델 주간 창을 각각 독립적으로 예약하고 알린다", async () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const { database, service, notificationsSent } = buildService(now);
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 80, remainingPercent: 20, resetAt: "9:01am (Asia/Seoul)" },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 40, remainingPercent: 60, resetAt: "Aug 5, 9:02am (Asia/Seoul)" },
    ] }), now);

    expect(database.prepare("SELECT window_id FROM usage_reset_schedules WHERE provider = 'claude' ORDER BY window_id").all()).toEqual([
      { window_id: "session" },
      { window_id: "weekly_all" },
    ]);
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(notificationsSent.map((item) => item.text)).toEqual([
      "Claude 세션 사용량이 초기화되었습니다.",
      "Claude 주간 사용량이 초기화되었습니다.",
    ]);
  });

  it("예정 시각 전에 다음 사용량 창이 감지되면 즉시 알리고 기존 타이머는 중복 발송하지 않는다", async () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const { service, notificationsSent } = buildService(now);
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 95, remainingPercent: 5, resetAt: "10:00am (Asia/Seoul)" },
    ] }), now);

    const detectedAt = new Date("2026-08-05T00:10:00.000Z");
    vi.setSystemTime(detectedAt);
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 2, remainingPercent: 98, resetAt: "3:00pm (Asia/Seoul)" },
    ] }), detectedAt);
    await Promise.resolve();

    expect(notificationsSent).toHaveLength(1);
    expect(notificationsSent[0].text).toContain("예정 시각보다 먼저 감지");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(notificationsSent).toHaveLength(1);
  });

  it("이미 알린 예약은 서버 서비스가 다시 시작돼도 중복 발송하지 않는다", async () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const { database, service, notificationsSent, adapters, notifications, realtime } = buildService(now);
    const detailsJson = JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 80, remainingPercent: 20, resetAt: "9:01am (Asia/Seoul)" },
    ] });
    database.prepare("INSERT INTO usage_status(provider, account_id, details_json) VALUES ('claude', (SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1), ?)").run(detailsJson);
    service.observe("claude", detailsJson, now);
    await vi.advanceTimersByTimeAsync(120_000);
    service.stop();

    const restarted = new UsageResetNotifier(database, notifications, realtime, adapters);
    restarted.start();
    await vi.runOnlyPendingTimersAsync();

    expect(notificationsSent).toHaveLength(1);
    restarted.stop();
  });
});

describe("usage_reset_schedules 마이그레이션", () => {
  it("공급자 단일 기본키 예약을 창별 복합 기본키로 바꾸면서 기존 행을 보존한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-reset-migration-"));
    temporaryDirectories.push(dataDir);
    const config = { dataDir } as unknown as AppConfig;
    const legacy = openDatabase(config);
    legacy.exec("DROP TABLE usage_reset_schedules");
    legacy.exec(`
      CREATE TABLE usage_reset_schedules (
        provider TEXT PRIMARY KEY,
        window_id TEXT NOT NULL,
        scheduled_reset_at TEXT NOT NULL,
        used_percent REAL,
        notified_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    legacy.prepare("INSERT INTO usage_reset_schedules(provider, window_id, scheduled_reset_at) VALUES ('claude', 'session', '2026-08-05T07:19:00.000Z')").run();
    legacy.close();

    const migrated = openDatabase(config);
    const primaryKey = (migrated.prepare("PRAGMA table_info(usage_reset_schedules)").all() as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    expect(primaryKey).toEqual(["provider", "window_id"]);
    expect(migrated.prepare("SELECT provider, window_id, scheduled_reset_at FROM usage_reset_schedules").get()).toEqual({
      provider: "claude",
      window_id: "session",
      scheduled_reset_at: "2026-08-05T07:19:00.000Z",
    });
    migrated.prepare("INSERT INTO usage_reset_schedules(provider, window_id, scheduled_reset_at) VALUES ('claude', 'weekly_all', '2026-08-09T00:00:00.000Z')").run();
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM usage_reset_schedules WHERE provider = 'claude'").get()).toEqual({ count: 2 });
    migrated.close();
  });
});

describe("parseUsageResetMoment", () => {
  it("Codex 주간 한도의 날짜 포함 표기를 실제 로컬 시각으로 변환한다", () => {
    const now = new Date(2026, 6, 9, 15, 0, 0);
    expect(parseUsageResetMoment("19:05 on 9 Jul", now)).toEqual(new Date(2026, 6, 9, 19, 5, 0, 0));
  });

  it("Claude의 날짜 없는 타임존 표기는 기준 시각과 가장 가까운 발생 시각으로 고른다", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    expect(parseUsageResetMoment("9:01am (Asia/Seoul)", now)?.toISOString()).toBe("2026-08-05T00:01:00.000Z");
  });
});
