import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { NotificationPresentation, Notifier } from "./notifier";
import { CredentialVault } from "./credential-vault";

interface SlackSettingsRow {
  bot_token: string | null;
  bot_token_vault_id: string | null;
  channel_id: string | null;
}

// Slack Web API로 중복 없는 운영 알림을 전송한다.
export class SlackNotifier implements Notifier {
  private readonly vault: CredentialVault;

  constructor(private readonly config: AppConfig, private readonly database: AppDatabase, vault?: CredentialVault) {
    this.vault = vault ?? new CredentialVault(database, config.dataDir);
    this.migrateLegacyToken();
  }

  // DB에는 token 원문 대신 vault ID만 둔다. 환경변수 fallback은 운영자가 프로세스에 직접 주입한 값이라
  // WAM 관리 저장소로 복사하지 않는다.
  private getEffectiveSettings(): { vaultId?: string; environmentBotToken?: string; channelId?: string } {
    const row = this.database.prepare("SELECT bot_token, bot_token_vault_id, channel_id FROM slack_settings WHERE id = 1").get() as SlackSettingsRow | undefined;
    return {
      vaultId: row?.bot_token_vault_id && this.vault.has(row.bot_token_vault_id) ? row.bot_token_vault_id : undefined,
      environmentBotToken: this.config.slack.botToken,
      channelId: row?.channel_id || this.config.slack.channelId,
    };
  }

  // 이벤트 ID를 기준으로 알림을 한 번만 전송한다.
  async notify(eventId: string, eventType: string, text: string, presentation?: NotificationPresentation): Promise<void> {
    const existing = this.database.prepare("SELECT status FROM notification_deliveries WHERE event_id = ?").get(eventId) as { status: string } | undefined;
    if (existing?.status === "sent") return;
    const { vaultId, environmentBotToken, channelId } = this.getEffectiveSettings();
    if ((!vaultId && !environmentBotToken) || !channelId) return;
    this.database.prepare(`
      INSERT INTO notification_deliveries(event_id, event_type, channel_id, status, attempts)
      VALUES (?, ?, ?, 'sending', 1)
      ON CONFLICT(event_id) DO UPDATE SET status = 'sending', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    `).run(eventId, eventType, channelId);
    const send = async (botToken: string): Promise<void> => {
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: channelId, text: presentation?.title ? `*${presentation.title}*\n${text}` : text, unfurl_links: false, unfurl_media: false }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { ok?: boolean; error?: string; ts?: string };
      if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      this.database.prepare(`
        UPDATE notification_deliveries SET status = 'sent', slack_ts = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
      `).run(result.ts ?? null, eventId);
    };
    try {
      if (vaultId) await this.vault.withSecret(vaultId, `slack:${eventType}`, send);
      else await send(environmentBotToken!);
    } catch (error) {
      this.database.prepare(`
        UPDATE notification_deliveries SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
      `).run(error instanceof Error ? error.message : "Slack 전송 실패", eventId);
    }
  }

  // Slack 알림 설정의 존재 여부만 반환한다.
  status(): { enabled: boolean; botConfigured: boolean; userConfigured: boolean; channelConfigured: boolean } {
    const { vaultId, environmentBotToken, channelId } = this.getEffectiveSettings();
    const botConfigured = Boolean(vaultId || environmentBotToken);
    return {
      enabled: Boolean(botConfigured && channelId),
      botConfigured,
      userConfigured: Boolean(this.config.slack.userToken),
      channelConfigured: Boolean(channelId),
    };
  }

  // 관리자 설정 화면에 보여줄 현재 상태(토큰 원문은 절대 다시 내려보내지 않는다).
  settingsForAdmin(): { botTokenConfigured: boolean; channelId: string | null } {
    const { vaultId, environmentBotToken, channelId } = this.getEffectiveSettings();
    return { botTokenConfigured: Boolean(vaultId || environmentBotToken), channelId: channelId ?? null };
  }

  // 관리자가 입력한 Slack 설정을 저장한다. 빈 값으로 온 필드는 기존 값을 그대로 유지한다.
  updateSettings(botToken: string, channelId: string): void {
    const current = this.database.prepare("SELECT bot_token, bot_token_vault_id, channel_id FROM slack_settings WHERE id = 1").get() as SlackSettingsRow | undefined;
    this.database.transaction(() => {
      const nextVaultId = botToken.trim()
        ? this.vault.put("system", "slack", "notification", "bot_token", botToken.trim())
        : current?.bot_token_vault_id ?? null;
      const nextChannelId = channelId.trim() || current?.channel_id || null;
      this.database.prepare(`
        INSERT INTO slack_settings(id, bot_token, bot_token_vault_id, channel_id, updated_at) VALUES (1, NULL, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET bot_token = NULL, bot_token_vault_id = excluded.bot_token_vault_id,
          channel_id = excluded.channel_id, updated_at = CURRENT_TIMESTAMP
      `).run(nextVaultId, nextChannelId);
    })();
  }

  // 기존 버전이 DB에 평문으로 저장한 Slack token은 최초 기동에서 한 번 암호화한 뒤 원문 열을 지운다.
  private migrateLegacyToken(): void {
    const row = this.database.prepare("SELECT bot_token, bot_token_vault_id, channel_id FROM slack_settings WHERE id = 1").get() as SlackSettingsRow | undefined;
    if (!row?.bot_token) return;
    this.database.transaction(() => {
      const vaultId = row.bot_token_vault_id ?? this.vault.put("system", "slack", "notification", "bot_token", row.bot_token!);
      this.database.prepare("UPDATE slack_settings SET bot_token = NULL, bot_token_vault_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run(vaultId);
    })();
  }
}
