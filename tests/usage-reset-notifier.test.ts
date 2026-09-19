import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { NotificationPresentation, Notifier } from "../src/server/services/notifier";
import type { RealtimeHub } from "../src/server/services/realtime";
import { parseUsageResetMoment, resetEventKey, UsageResetNotifier } from "../src/server/services/usage-reset-notifier";
import { CodexAdapter } from "../src/server/providers/codex";

const temporaryDirectories: string[] = [];

// 실제 SQLite와 가짜 알림 채널을 연결한 초기화 알림 서비스 테스트 구성을 만든다.
function buildService(now: Date) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-reset-"));
  temporaryDirectories.push(dataDir);
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  const notificationsSent: Array<{ eventId: string; eventType: string; text: string; presentation?: NotificationPresentation }> = [];
  const realtimeSent: Array<{ type: string; payload: unknown }> = [];
  const notifications: Notifier = { notify: async (eventId, eventType, text, presentation) => { notificationsSent.push({ eventId, eventType, text, presentation }); } };
  const realtime = { broadcast: (type: string, payload: unknown) => { realtimeSent.push({ type, payload }); } } as unknown as RealtimeHub;
  const adapters = [
    new CodexAdapter(),
    { id: "claude", displayLabel: "Claude", usageWindowId: "session", usageResetWindowIds: ["session", "weekly_all"], usageWindowLabels: { session: "5시간", weekly_all: "주간" }, transientUsageResetWindowIds: ["session"] },
    { id: "grok", displayLabel: "Grok", usageWindowId: "weekly", usageWindowLabels: { weekly: "주간" } },
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
  it("예정 시각이 지나도 직접 알리지 않고 최신 스냅샷에서 창 전환을 확인한 뒤 알린다", async () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const { service, notificationsSent, realtimeSent } = buildService(now);
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 80, remainingPercent: 20, resetAt: "9:01am (Asia/Seoul)" },
    ] }), now);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(notificationsSent).toEqual([]);
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 0, remainingPercent: 100, resetAt: "2:01pm (Asia/Seoul)" },
    ] }), new Date("2026-08-05T00:02:00.000Z"));
    await Promise.resolve();

    expect(notificationsSent).toHaveLength(1);
    expect(notificationsSent[0]).toMatchObject({
      eventType: "usage_session_reset",
      text: "Claude 5시간 사용량 초기화가 확인되었습니다.",
      presentation: { title: "Claude 5시간 사용량 초기화" },
    });
    expect(realtimeSent).toEqual([{ type: "usage_session_reset", payload: expect.objectContaining({
      provider: "claude", accountId: 2, label: "Claude", windowId: "session", windowLabel: "5시간", detectedEarly: false,
      title: "Claude 5시간 사용량 초기화", body: "Claude 5시간 사용량 초기화가 확인되었습니다.",
    }) }]);
  });

  // 실사용 재현(#56): Codex 주간 초기화 순간 CLI가 옛 창과 새 창을 번갈아 돌려줬고, 되돌아간 옛
  // 값이 예약에 저장되는 바람에 다음 전진이 새 창 전환으로 다시 판정돼 알림이 2번 나갔다.
  it("초기화 경계에서 옛 리셋 시각으로 되돌아가도 알림은 한 번만 보낸다", async () => {
    const now = new Date("2026-08-22T01:33:00.000Z");
    const { service, notificationsSent } = buildService(now);
    const codexWindows = (resetAt: string, usedPercent: number): string => JSON.stringify({ windows: [
      { id: "weekly", label: "Weekly limit", usedPercent, remainingPercent: 100 - usedPercent, resetAt },
    ] });

    // 초기화 전 상태로 예약을 잡는다.
    service.observe("codex", codexWindows("12:34 on 27 Aug", 54), now);
    expect(notificationsSent).toEqual([]);

    // 초기화가 감지되어 리셋 시각이 앞으로 밀린다 — 여기서 한 번 알린다.
    service.observe("codex", codexWindows("10:32 on 29 Aug", 0), new Date("2026-08-22T01:33:18.000Z"));
    expect(notificationsSent).toHaveLength(1);

    // CLI가 옛 스냅샷을 한 번 더 돌려준다. 이 값이 예약을 덮으면 안 된다.
    service.observe("codex", codexWindows("12:43 on 27 Aug", 54), new Date("2026-08-22T01:34:34.000Z"));
    // 최신 값이 다시 오더라도 같은 창이므로 추가 알림이 없어야 한다.
    service.observe("codex", codexWindows("10:34 on 29 Aug", 0), new Date("2026-08-22T01:35:24.000Z"));
    expect(notificationsSent).toHaveLength(1);
  });

  // 같은 창인데 표기가 몇 분 흔들리면 중복 차단 키가 갈려 notifier까지 뚫린다(#56 실측: 9분 차).
  it("같은 창의 몇 분 표기 차이는 같은 중복 차단 키가 된다", () => {
    expect(resetEventKey("2026-08-27T03:34:00.000Z")).toBe(resetEventKey("2026-08-27T03:43:00.000Z"));
    // 창이 실제로 달라지면 키도 달라야 한다.
    expect(resetEventKey("2026-08-27T03:34:00.000Z")).not.toBe(resetEventKey("2026-08-29T01:34:00.000Z"));
  });

  it("Claude 세션과 전체 모델 주간 창을 각각 독립적으로 확인하고 알린다", async () => {
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
    expect(notificationsSent).toEqual([]);
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 0, remainingPercent: 100, resetAt: "2:01pm (Asia/Seoul)" },
      { id: "weekly_all", label: "Current week (all models)", usedPercent: 0, remainingPercent: 100, resetAt: "Aug 12, 9:02am (Asia/Seoul)" },
    ] }), new Date("2026-08-05T00:03:00.000Z"));
    await Promise.resolve();

    expect(notificationsSent.map((item) => item.text)).toEqual([
      "Claude 5시간 사용량 초기화가 확인되었습니다.",
      "Claude 주간 사용량 초기화가 확인되었습니다.",
    ]);
  });

  it("Claude 세션 창이 예약 경계 뒤 사라지면 즉시 초기화로 알리고 0% 재등장은 중복하지 않는다", async () => {
    const beforeReset = new Date("2026-08-29T02:29:00.000Z");
    const { database, service, notificationsSent } = buildService(beforeReset);
    const weekly = { id: "weekly_all", label: "Current week (all models)", usedPercent: 0, remainingPercent: 100, resetAt: "Sep 5, 1am (Asia/Seoul)" };
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 1, remainingPercent: 99, resetAt: "11:29am (Asia/Seoul)" },
      weekly,
    ] }), beforeReset);

    // 경계 전 일시 누락은 초기화로 단정하지 않고 양수 기준선을 보존한다.
    service.observe("claude", JSON.stringify({ windows: [weekly] }), new Date("2026-08-29T02:28:00.000Z"));
    expect(notificationsSent).toEqual([]);
    expect(database.prepare("SELECT scheduled_reset_at, used_percent FROM usage_reset_schedules WHERE provider = 'claude' AND window_id = 'session'").get()).toEqual({
      scheduled_reset_at: "2026-08-29T02:29:00.000Z",
      used_percent: 1,
    });

    // 실측 11:30: 경계가 지난 뒤 Current session 블록이 사라지면 즉시 초기화로 확정한다.
    service.observe("claude", JSON.stringify({ windows: [weekly] }), new Date("2026-08-29T02:30:00.000Z"));
    await Promise.resolve();
    expect(notificationsSent.map((item) => item.text)).toEqual(["Claude 5시간 사용량 초기화가 확인되었습니다."]);
    expect(database.prepare("SELECT scheduled_reset_at, used_percent, notified_at FROM usage_reset_schedules WHERE provider = 'claude' AND window_id = 'session'").get()).toMatchObject({
      scheduled_reset_at: "2026-08-29T02:29:00.000Z",
      used_percent: 0,
      notified_at: expect.any(String),
    });

    // 두 번째 누락은 이미 0으로 선점한 같은 초기화라 다시 알리지 않는다.
    service.observe("claude", JSON.stringify({ windows: [weekly] }), new Date("2026-08-29T02:31:00.000Z"));
    await Promise.resolve();
    expect(notificationsSent).toHaveLength(1);

    // 실측 11:32: 새 5시간 창이 0%로 돌아오면 다음 예약은 갱신하되 알림은 중복하지 않는다.
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 0, remainingPercent: 100, resetAt: "4:29pm (Asia/Seoul)" },
      weekly,
    ] }), new Date("2026-08-29T02:32:00.000Z"));
    await Promise.resolve();
    expect(notificationsSent).toHaveLength(1);
    expect(database.prepare("SELECT scheduled_reset_at, used_percent, notified_at FROM usage_reset_schedules WHERE provider = 'claude' AND window_id = 'session'").get()).toMatchObject({
      scheduled_reset_at: "2026-08-29T07:29:00.000Z",
      used_percent: 0,
      notified_at: expect.any(String),
    });

    // keepalive로 같은 창이 1%가 되어도 이미 확인한 초기화를 다시 알리지 않는다.
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 1, remainingPercent: 99, resetAt: "4:29pm (Asia/Seoul)" },
      weekly,
    ] }), new Date("2026-08-29T02:42:00.000Z"));
    await Promise.resolve();
    expect(notificationsSent).toHaveLength(1);
  });

  it("Codex 5시간 창과 주간 창을 각각 독립적으로 예약한다", () => {
    const now = new Date("2026-08-27T05:00:00.000Z");
    const { database, service } = buildService(now);
    service.observe("codex", JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 63, remainingPercent: 37, resetAt: "19:03" },
      { id: "weekly", label: "Weekly limit", usedPercent: 4, remainingPercent: 96, resetAt: "23:14 on 1 Sep" },
    ] }), now);

    expect(database.prepare("SELECT window_id FROM usage_reset_schedules WHERE provider = 'codex' ORDER BY window_id").all()).toEqual([
      { window_id: "five_hour" },
      { window_id: "weekly" },
    ]);

    // 제품 정책이 다시 바뀌어 5시간 창이 안 보이면 이전 타이머까지 취소하고 주간만 남긴다.
    service.observe("codex", JSON.stringify({ windows: [
      { id: "weekly", label: "Weekly limit", usedPercent: 5, remainingPercent: 95, resetAt: "23:14 on 1 Sep" },
    ] }), new Date("2026-08-27T05:01:00.000Z"));
    expect(database.prepare("SELECT window_id FROM usage_reset_schedules WHERE provider = 'codex' ORDER BY window_id").all()).toEqual([
      { window_id: "weekly" },
    ]);
  });

  it("Codex 0% 창의 다음 리셋이 매분 밀려도 5시간 알림은 한 번만 보낸다", async () => {
    const now = new Date("2026-08-27T23:45:00.000Z");
    const { service, notificationsSent } = buildService(now);
    const details = (usedPercent: number, resetAt: string): string => JSON.stringify({ windows: [
      { id: "weekly", label: "Weekly limit", usedPercent: 2, remainingPercent: 98, resetAt: "03:50 on 4 Sep" },
      { id: "five_hour", label: "5h limit", usedPercent, remainingPercent: 100 - usedPercent, resetAt },
    ] });

    service.observe("codex", details(12, "08:50"), now);
    // 실제 초기화 전에는 예정 경계를 지났다는 이유만으로 알리지 않는다.
    service.observe("codex", details(12, "08:50"), new Date("2026-08-27T23:47:00.000Z"));
    expect(notificationsSent).toEqual([]);

    service.observe("codex", details(0, "13:50"), new Date("2026-08-27T23:51:45.000Z"));
    for (let minute = 51; minute <= 59; minute += 1) {
      service.observe("codex", details(0, `13:${minute}`), new Date(`2026-08-27T23:${minute}:45.000Z`));
    }
    for (let minute = 0; minute <= 8; minute += 1) {
      service.observe("codex", details(0, `14:${String(minute).padStart(2, "0")}`), new Date(`2026-08-28T00:${String(minute).padStart(2, "0")}:45.000Z`));
    }
    await Promise.resolve();

    expect(notificationsSent).toHaveLength(1);
    expect(notificationsSent[0]).toMatchObject({
      text: "Codex 5시간 사용량 초기화가 확인되었습니다.",
      presentation: { title: "Codex 5시간 사용량 초기화" },
    });
  });

  it("Codex 5시간과 주간 창이 함께 전환되면 창을 명시한 알림을 각각 보낸다", async () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    const { service, notificationsSent } = buildService(now);
    service.observe("codex", JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 90, remainingPercent: 10, resetAt: "09:01" },
      { id: "weekly", label: "Weekly limit", usedPercent: 80, remainingPercent: 20, resetAt: "09:01 on 28 Aug" },
    ] }), now);

    service.observe("codex", JSON.stringify({ windows: [
      { id: "five_hour", label: "5h limit", usedPercent: 0, remainingPercent: 100, resetAt: "14:01" },
      { id: "weekly", label: "Weekly limit", usedPercent: 0, remainingPercent: 100, resetAt: "09:01 on 4 Sep" },
    ] }), new Date("2026-08-28T00:02:00.000Z"));
    await Promise.resolve();

    expect(notificationsSent.map((item) => item.presentation?.title)).toEqual([
      "Codex 5시간 사용량 초기화",
      "Codex 주간 사용량 초기화",
    ]);
    expect(notificationsSent.map((item) => item.text)).toEqual([
      "Codex 5시간 사용량 초기화가 확인되었습니다.",
      "Codex 주간 사용량 초기화가 확인되었습니다.",
    ]);
  });

  it("Grok의 현재 단일 한도 창은 세션이 아니라 주간으로 명시한다", async () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    const { service, notificationsSent, realtimeSent } = buildService(now);
    service.observe("grok", JSON.stringify({ windows: [
      { id: "weekly", label: "Weekly limit (SuperGrok)", usedPercent: 80, remainingPercent: 20, resetAt: "09:01 on 28 Aug" },
    ] }), now);

    service.observe("grok", JSON.stringify({ windows: [
      { id: "weekly", label: "Weekly limit (SuperGrok)", usedPercent: 0, remainingPercent: 100, resetAt: "09:01 on 4 Sep" },
    ] }), new Date("2026-08-28T00:02:00.000Z"));
    await Promise.resolve();

    expect(notificationsSent).toEqual([expect.objectContaining({
      text: "Grok 주간 사용량 초기화가 확인되었습니다.",
      presentation: { title: "Grok 주간 사용량 초기화" },
    })]);
    expect(realtimeSent).toEqual([expect.objectContaining({ payload: expect.objectContaining({
      provider: "grok", windowId: "weekly", windowLabel: "주간",
      title: "Grok 주간 사용량 초기화", body: "Grok 주간 사용량 초기화가 확인되었습니다.",
    }) })]);
  });

  it("예정 시각 전에 사용률 하락과 다음 창이 함께 감지되면 한 번만 알린다", async () => {
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
    expect(notificationsSent[0].text).toBe("Claude 5시간 사용량 초기화가 확인되었습니다.");
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
    service.observe("claude", JSON.stringify({ windows: [
      { id: "session", label: "Current session", usedPercent: 0, remainingPercent: 100, resetAt: "2:01pm (Asia/Seoul)" },
    ] }), new Date("2026-08-05T00:02:00.000Z"));
    await Promise.resolve();
    service.stop();

    const restarted = new UsageResetNotifier(database, notifications, realtime, adapters);
    restarted.start();
    await Promise.resolve();

    expect(notificationsSent).toHaveLength(1);
    restarted.stop();
  });
});

describe("usage_reset_schedules 마이그레이션", () => {
  it("공급자 단일 기본키 예약을 계정·창별 복합 기본키로 바꾸면서 기존 행을 보존한다", () => {
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
    expect(primaryKey).toEqual(["provider", "account_id", "window_id"]);
    expect(migrated.prepare("SELECT provider, account_id, window_id, scheduled_reset_at FROM usage_reset_schedules").get()).toEqual({
      provider: "claude",
      account_id: expect.any(Number),
      window_id: "session",
      scheduled_reset_at: "2026-08-05T07:19:00.000Z",
    });
    migrated.prepare("INSERT INTO usage_reset_schedules(provider, account_id, window_id, scheduled_reset_at) VALUES ('claude', (SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1), 'weekly_all', '2026-08-09T00:00:00.000Z')").run();
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
