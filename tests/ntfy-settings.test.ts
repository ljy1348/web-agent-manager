import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { NtfyNotifier } from "../src/server/services/ntfy";
import { NotificationHub, type Notifier } from "../src/server/services/notifier";

// 테스트마다 격리된 임시 데이터 디렉터리로 실제 스키마를 그대로 생성한다.
function createTestDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-ntfy-"));
  process.env.WEB_AGENT_MANAGER_DATA_DIR = dataDir;
  return openDatabase(loadConfig());
}

describe("ntfy 알림 설정", () => {
  it("DB에 저장된 설정이 없으면 환경변수 값으로 대체한다", () => {
    const database = createTestDatabase();
    const config = loadConfig();
    config.ntfy.topic = "env-topic";
    const ntfy = new NtfyNotifier(config, database);
    expect(ntfy.settingsForAdmin()).toEqual({ topic: "env-topic", serverUrl: config.ntfy.serverUrl });
  });

  it("저장한 topic을 우선 사용한다", () => {
    const database = createTestDatabase();
    const ntfy = new NtfyNotifier(loadConfig(), database);
    ntfy.updateSettings("my_web_agent_z6119", "https://ntfy.sh");
    expect(ntfy.settingsForAdmin()).toEqual({ topic: "my_web_agent_z6119", serverUrl: "https://ntfy.sh" });
    expect(ntfy.status().enabled).toBe(true);
  });

  it("빈 값으로 갱신하면 기존에 저장해둔 값을 그대로 유지한다", () => {
    const database = createTestDatabase();
    const ntfy = new NtfyNotifier(loadConfig(), database);
    ntfy.updateSettings("my_web_agent_z6119", "https://ntfy.sh");
    ntfy.updateSettings("", "");
    expect(ntfy.settingsForAdmin()).toEqual({ topic: "my_web_agent_z6119", serverUrl: "https://ntfy.sh" });
  });

  it("topic이 없으면 전송을 시도하지 않는다", async () => {
    const database = createTestDatabase();
    const ntfy = new NtfyNotifier(loadConfig(), database);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await ntfy.notify("evt-1", "test", "본문");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("같은 이벤트 ID는 한 번만 전송한다", async () => {
    const database = createTestDatabase();
    const ntfy = new NtfyNotifier(loadConfig(), database);
    ntfy.updateSettings("my_web_agent_z6119", "https://ntfy.sh");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await ntfy.notify("evt-dup", "task_completed", "완료");
    await ntfy.notify("evt-dup", "task_completed", "완료");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe("NotificationHub", () => {
  afterEach(() => vi.restoreAllMocks());

  it("등록된 모든 채널에 같이 알림을 보낸다", async () => {
    const calls: string[] = [];
    const channelA: Notifier = { notify: async (id) => { calls.push(`a:${id}`); } };
    const channelB: Notifier = { notify: async (id) => { calls.push(`b:${id}`); } };
    const hub = new NotificationHub([channelA, channelB]);
    await hub.notify("evt-1", "test", "본문");
    expect(calls.sort()).toEqual(["a:evt-1", "b:evt-1"]);
  });

  it("한 채널이 실패해도 다른 채널 전송에는 영향 없다", async () => {
    const calls: string[] = [];
    const failing: Notifier = { notify: async () => { throw new Error("전송 실패"); } };
    const succeeding: Notifier = { notify: async (id) => { calls.push(id); } };
    const hub = new NotificationHub([failing, succeeding]);
    await expect(hub.notify("evt-2", "test", "본문")).resolves.toBeUndefined();
    expect(calls).toEqual(["evt-2"]);
  });
});
