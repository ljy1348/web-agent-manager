import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { buildMobileWidgetSnapshot } from "../src/server/routes/mobile-routes";
import { FcmNotifier, fcmMessagePayload, fcmTitle } from "../src/server/services/fcm";
import { CredentialVault } from "../src/server/services/credential-vault";
import { FederationPushPoller } from "../src/server/services/federation-push-poller";
import { PushEventJournal } from "../src/server/services/push-event-journal";
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
  it("Firebase 설치 ID는 HTTP v1 token이 아닌 fid 대상 필드로 보낸다", () => {
    const payload = fcmMessagePayload("installation-id-123", "테스트", "내용", { eventType: "test" });
    expect(payload.message).toMatchObject({ fid: "installation-id-123", notification: { title: "테스트", body: "내용" } });
    expect(payload.message).not.toHaveProperty("token");
  });

  it("위젯 응답을 사용량과 CPU·메모리의 최소 필드로 축약한다", () => {
    const database = createDatabase();
    const account = database.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number };
    const usage = [{ provider: "claude", account_id: account.id, monitor_status: "ready", data_status: "fresh", error_code: null, summary: null, used_percent: 37, remaining_percent: 63, reset_at: "18:00", details_json: null, last_checked_at: null, last_success_at: null, keepalive_sent_at: null, keepalive_reason: null }] satisfies UsageRecord[];
    const adapters = [{ id: "claude" as const, usageWindowId: "session", usageWindowLabels: { session: "5시간" } }];
    const snapshot = buildMobileWidgetSnapshot(database, usage, { latest: { timestamp: "2026-08-10T00:00:00.000Z", cpuPercent: 25, memory: { total: 1000, used: 420, available: 580, swapTotal: 0, swapUsed: 0 } } as never, recent: [] }, adapters);
    expect(snapshot.usage[0]).toMatchObject({ provider: "claude", windowLabel: "5시간", usedPercent: 37, remainingPercent: 63 });
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

  it("FCM 초기화 알림 제목에 5시간·주간 창 구분을 유지한다", async () => {
    const database = createDatabase();
    const userId = seedUser(database);
    const config = loadConfig();
    config.fcm = { enabled: true };
    const sent: Array<{ title: string; body: string }> = [];
    const fcm = new FcmNotifier(config, database, async (_tokens, title, body) => {
      sent.push({ title, body });
      return [{ success: true }];
    });
    fcm.registerDevice(userId, "test-fcm-registration-token-window-title");

    await fcm.notify("event-weekly", "usage_session_reset", "Codex 주간 사용량 초기화가 확인되었습니다.", { title: "Codex 주간 사용량 초기화" });

    expect(sent).toEqual([{ title: "Codex 주간 사용량 초기화", body: "Codex 주간 사용량 초기화가 확인되었습니다." }]);
  });

  it("앱 전용 push 표시가 있으면 그 제목·본문과 채팅 ID를 보낸다(#128)", async () => {
    const database = createDatabase();
    const userId = seedUser(database);
    const config = loadConfig();
    config.fcm = { enabled: true };
    const sent: Array<{ title: string; body: string; data: Record<string, string> }> = [];
    const fcm = new FcmNotifier(config, database, async (_tokens, title, body, data) => {
      sent.push({ title, body, data });
      return [{ success: true }];
    });
    fcm.registerDevice(userId, "test-fcm-registration-token-push-chat");

    await fcm.notify("event-push", "task_completed", "AI 작업이 완료되었습니다.", { push: { title: "#12 · 제목", body: "Codex · 응답", chatId: 12 } });

    expect(sent).toEqual([{ title: "#12 · 제목", body: "Codex · 응답", data: { eventType: "task_completed", eventId: "event-push", chatId: "12" } }]);
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
    expect(fcmTitle("usage_keepalive_exhausted")).toBe("세션 유지 실패");
  });

  it("원격 WAM의 본문 없는 이벤트를 중앙 직접 FCM으로 보내고 일시 실패는 커서에서 재시도한다", async () => {
    const database = createDatabase();
    const userId = seedUser(database);
    const config = loadConfig();
    config.fcm = { enabled: true, projectId: "personal-project" };
    const vault = new CredentialVault(database, config.dataDir);
    const credentialId = vault.put("system", "remote", "federation", "agent-token", "test-token");
    database.prepare("INSERT INTO federation_nodes(id, name, base_url, token_credential_id, created_by) VALUES ('remote', 'Remote', 'https://remote.example.test', ?, ?)")
      .run(credentialId, userId);
    const journal = new PushEventJournal(database);
    await journal.notify("private-event-id", "approval_requested");
    expect(journal.list(0)[0]).toMatchObject({ event_type: "approval_requested" });
    expect(journal.list(0)[0].event_id).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.list(0)[0].event_id).not.toBe("private-event-id");

    let latest = 1;
    let events = [{ seq: 1, event_id: "old", event_type: "test" }];
    const federation = {
      list: () => [{ id: "remote" }],
      request: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ latest, events })) }),
    } as never;
    let fail = true;
    const sent: Array<{ title: string; body: string }> = [];
    const fcm = new FcmNotifier(config, database, async (_tokens, title, body) => {
      sent.push({ title, body });
      if (fail) { fail = false; return [{ success: false, errorCode: "UNAVAILABLE" }]; }
      return [{ success: true }];
    });
    fcm.registerDevice(userId, "personal-firebase-installation-id-12345");
    const poller = new FederationPushPoller(database, federation, fcm);
    await poller.poll();
    expect(sent).toEqual([]);

    latest = 2;
    events = [{ seq: 2, event_id: "new", event_type: "approval_requested" }];
    await poller.poll();
    expect((database.prepare("SELECT last_seq FROM federation_push_cursors WHERE node_id = 'remote'").get() as { last_seq: number }).last_seq).toBe(1);
    await poller.poll();
    await poller.poll();
    expect(sent).toEqual([
      { title: "권한 요청", body: "연결된 컴퓨터에 새 알림이 있습니다." },
      { title: "권한 요청", body: "연결된 컴퓨터에 새 알림이 있습니다." },
    ]);
    expect((database.prepare("SELECT last_seq FROM federation_push_cursors WHERE node_id = 'remote'").get() as { last_seq: number }).last_seq).toBe(2);
  });
});
