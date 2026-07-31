import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { SlackNotifier } from "../src/server/services/slack";

// 테스트마다 격리된 임시 데이터 디렉터리로 실제 스키마를 그대로 생성한다.
function createTestDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-slack-"));
  process.env.WEB_AGENT_MANAGER_DATA_DIR = dataDir;
  return openDatabase(loadConfig());
}

describe("Slack 알림 설정", () => {
  it("DB에 저장된 설정이 없으면 환경변수 값으로 대체한다", () => {
    const database = createTestDatabase();
    const config = loadConfig();
    config.slack.botToken = "env-bot-token";
    config.slack.channelId = "env-channel";
    const slack = new SlackNotifier(config, database);
    expect(slack.settingsForAdmin()).toEqual({ botTokenConfigured: true, channelId: "env-channel" });
  });

  it("저장한 설정을 우선 사용하고, 토큰 원문은 관리자 조회에 노출하지 않는다", () => {
    const database = createTestDatabase();
    const slack = new SlackNotifier(loadConfig(), database);
    slack.updateSettings("xoxb-real-token", "C12345");
    expect(slack.settingsForAdmin()).toEqual({ botTokenConfigured: true, channelId: "C12345" });
    expect(slack.status().enabled).toBe(true);
  });

  it("빈 값으로 갱신하면 기존에 저장해둔 값을 그대로 유지한다", () => {
    const database = createTestDatabase();
    const slack = new SlackNotifier(loadConfig(), database);
    slack.updateSettings("xoxb-real-token", "C12345");
    slack.updateSettings("", "C67890");
    expect(slack.settingsForAdmin()).toEqual({ botTokenConfigured: true, channelId: "C67890" });
  });
});
