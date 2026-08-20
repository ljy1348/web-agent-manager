import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { buildMobileWidgetSnapshot } from "../src/server/routes/mobile-routes";
import { FcmNotifier, fcmTitle } from "../src/server/services/fcm";
import type { UsageRecord } from "../src/shared/types";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
  delete process.env.WEB_AGENT_MANAGER_DATA_DIR;
});

// 실제 스키마를 쓰는 격리된 모바일 기능 테스트 DB를 만든다.
function createDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-mobile-"));
  process.env.WEB_AGENT_MANAGER_DATA_DIR = dataDir;
  const database = openDatabase(loadConfig());
  cleanup.push(() => database.close());
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return database;
}

// 테스트 사용자와 기본 공급자 계정을 준비한다.
function seedUser(database: ReturnType<typeof createDatabase>): number {
  return Number(database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('mobile-admin', 'hash', 'admin')").run().lastInsertRowid);
}

describe("Android 모바일 API 데이터", () => {
  it("위젯 응답을 사용량과 CPU·메모리의 최소 필드로 축약한다", () => {
    const database = createDatabase();
    const account = database.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number };
    const usage = [{ provider: "claude", account_id: account.id, monitor_status: "ready", data_status: "fresh", error_code: null, summary: null, used_percent: 37, remaining_percent: 63, reset_at: "18:00", details_json: null, last_checked_at: null, last_success_at: null, keepalive_sent_at: null, keepalive_reason: null }] satisfies UsageRecord[];
    const snapshot = buildMobileWidgetSnapshot(database, usage, { latest: { timestamp: "2026-08-10T00:00:00.000Z", cpuPercent: 25, memory: { total: 1000, used: 420, available: 580, swapTotal: 0, swapUsed: 0 } } as never, recent: [] });
    expect(snapshot.usage[0]).toMatchObject({ provider: "claude", usedPercent: 37, remainingPercent: 63 });
    expect(snapshot.system).toMatchObject({ cpuPercent: 25, memoryUsedPercent: 42 });
  });

  it("FCM 토큰을 사용자에게 등록하고 같은 이벤트는 성공 뒤 다시 보내지 않는다", async () => {
    const database = createDatabase();
    const userId = seedUser(database);
    const config = loadConfig();
    config.fcm = { enabled: true };
    const sent: string[][] = [];
    const fcm = new FcmNotifier(config, database, async (tokens) => {
      sent.push(tokens);
      return tokens.map(() => ({ success: true }));
    });
    fcm.registerDevice(userId, "test-fcm-registration-token-1234567890", "Pixel");
    await fcm.notify("event-1", "task_completed", "작업을 마쳤습니다.");
    await fcm.notify("event-1", "task_completed", "작업을 마쳤습니다.");
    expect(sent).toHaveLength(1);
    expect(fcm.status()).toEqual({ enabled: true, projectConfigured: false, registeredDevices: 1 });
  });

  it("Firebase가 폐기한 토큰은 자동 비활성화한다", async () => {
    const database = createDatabase();
    const userId = seedUser(database);
    const config = loadConfig();
    config.fcm = { enabled: true };
    const fcm = new FcmNotifier(config, database, async () => [{ success: false, errorCode: "messaging/registration-token-not-registered" }]);
    fcm.registerDevice(userId, "expired-fcm-registration-token-1234567890");
    await fcm.notify("event-2", "terminal_exited", "터미널이 종료되었습니다.");
    expect(fcm.status().registeredDevices).toBe(0);
    expect(fcmTitle("approval_requested")).toBe("권한 요청");
  });
});
