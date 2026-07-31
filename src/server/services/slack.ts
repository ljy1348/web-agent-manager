import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { Notifier } from "./notifier";

interface SlackSettingsRow {
  bot_token: string | null;
  channel_id: string | null;
}

// Slack Web API로 중복 없는 운영 알림을 전송한다.
export class SlackNotifier implements Notifier {
  constructor(private readonly config: AppConfig, private readonly database: AppDatabase) {}

  // DB에 관리자가 저장한 설정을 우선 쓰고, 없으면 기존 환경변수 값으로 대체한다.
  private getEffectiveSettings(): { botToken?: string; channelId?: string } {
    const row = this.database.prepare("SELECT bot_token, channel_id FROM slack_settings WHERE id = 1").get() as SlackSettingsRow | undefined;
    return {
      botToken: row?.bot_token || this.config.slack.botToken,
      channelId: row?.channel_id || this.config.slack.channelId,
    };
  }

  // 이벤트 ID를 기준으로 알림을 한 번만 전송한다.
  async notify(eventId: string, eventType: string, text: string): Promise<void> {
    const existing = this.database.prepare("SELECT status FROM notification_deliveries WHERE event_id = ?").get(eventId) as { status: string } | undefined;
    if (existing?.status === "sent") return;
    const { botToken, channelId } = this.getEffectiveSettings();
    if (!botToken || !channelId) return;
    this.database.prepare(`
      INSERT INTO notification_deliveries(event_id, event_type, channel_id, status, attempts)
      VALUES (?, ?, ?, 'sending', 1)
      ON CONFLICT(event_id) DO UPDATE SET status = 'sending', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    `).run(eventId, eventType, channelId);
    try {
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: channelId, text, unfurl_links: false, unfurl_media: false }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { ok?: boolean; error?: string; ts?: string };
      if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      this.database.prepare(`
        UPDATE notification_deliveries SET status = 'sent', slack_ts = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
      `).run(result.ts ?? null, eventId);
    } catch (error) {
      this.database.prepare(`
        UPDATE notification_deliveries SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
      `).run(error instanceof Error ? error.message : "Slack 전송 실패", eventId);
    }
  }

  // Slack 알림 설정의 존재 여부만 반환한다.
  status(): { enabled: boolean; botConfigured: boolean; userConfigured: boolean; channelConfigured: boolean } {
    const { botToken, channelId } = this.getEffectiveSettings();
    return {
      enabled: Boolean(botToken && channelId),
      botConfigured: Boolean(botToken),
      userConfigured: Boolean(this.config.slack.userToken),
      channelConfigured: Boolean(channelId),
    };
  }

  // 관리자 설정 화면에 보여줄 현재 상태(토큰 원문은 절대 다시 내려보내지 않는다).
  settingsForAdmin(): { botTokenConfigured: boolean; channelId: string | null } {
    const { botToken, channelId } = this.getEffectiveSettings();
    return { botTokenConfigured: Boolean(botToken), channelId: channelId ?? null };
  }

  // 관리자가 입력한 Slack 설정을 저장한다. 빈 값으로 온 필드는 기존 값을 그대로 유지한다.
  updateSettings(botToken: string, channelId: string): void {
    const current = this.database.prepare("SELECT bot_token, channel_id FROM slack_settings WHERE id = 1").get() as SlackSettingsRow | undefined;
    const nextBotToken = botToken.trim() || current?.bot_token || null;
    const nextChannelId = channelId.trim() || current?.channel_id || null;
    this.database.prepare(`
      INSERT INTO slack_settings(id, bot_token, channel_id, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET bot_token = excluded.bot_token, channel_id = excluded.channel_id, updated_at = CURRENT_TIMESTAMP
    `).run(nextBotToken, nextChannelId);
  }
}
