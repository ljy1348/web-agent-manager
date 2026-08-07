import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { Notifier } from "./notifier";

interface NtfySettingsRow {
  topic: string | null;
  server_url: string | null;
}

// 이벤트 유형별로 ntfy 알림에 붙일 제목·이모지 태그·우선순위를 정한다. 메시지 본문(text)은 Slack과
// 공유하는 사람이 읽는 문장 그대로 쓰고, 여기서는 푸시 알림 UI에 필요한 메타데이터만 더한다.
function presentationFor(eventType: string): { title: string; tags: string[]; priority: number } {
  if (eventType === "task_completed") return { title: "작업 완료", tags: ["white_check_mark"], priority: 3 };
  if (eventType === "approval_requested") return { title: "권한 요청", tags: ["warning"], priority: 4 };
  if (eventType === "rate_limit_hit") return { title: "사용량 한도 도달", tags: ["hourglass"], priority: 4 };
  if (eventType === "rate_limit_reset") return { title: "사용량 한도 초기화", tags: ["large_green_circle"], priority: 3 };
  if (eventType === "usage_session_reset") return { title: "사용량 세션 초기화", tags: ["large_green_circle"], priority: 3 };
  if (eventType === "terminal_exited") return { title: "터미널 종료", tags: ["octagonal_sign"], priority: 4 };
  if (eventType === "test") return { title: "알림 테스트", tags: ["bell"], priority: 3 };
  return { title: "웹 에이전트 관리자", tags: [], priority: 3 };
}

// ntfy.sh(또는 자체 호스팅 서버)의 topic으로 중복 없는 운영 알림을 전송한다. Slack과 별도 채널이라
// 토큰 없이 topic(URL 일부) 하나만 알아도 구독·전송이 되는 만큼, 전송 성공/실패도 독립적으로 기록한다.
export class NtfyNotifier implements Notifier {
  constructor(private readonly config: AppConfig, private readonly database: AppDatabase) {}

  // DB에 관리자가 저장한 설정을 우선 쓰고, 없으면 환경변수 값으로 대체한다.
  private getEffectiveSettings(): { topic?: string; serverUrl: string } {
    const row = this.database.prepare("SELECT topic, server_url FROM ntfy_settings WHERE id = 1").get() as NtfySettingsRow | undefined;
    return {
      topic: row?.topic || this.config.ntfy.topic,
      serverUrl: row?.server_url || this.config.ntfy.serverUrl,
    };
  }

  // 이벤트 ID를 기준으로 알림을 한 번만 전송한다.
  async notify(eventId: string, eventType: string, text: string): Promise<void> {
    const existing = this.database.prepare("SELECT status FROM ntfy_deliveries WHERE event_id = ?").get(eventId) as { status: string } | undefined;
    if (existing?.status === "sent") return;
    const { topic, serverUrl } = this.getEffectiveSettings();
    if (!topic) return;
    this.database.prepare(`
      INSERT INTO ntfy_deliveries(event_id, event_type, status, attempts)
      VALUES (?, ?, 'sending', 1)
      ON CONFLICT(event_id) DO UPDATE SET status = 'sending', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    `).run(eventId, eventType);
    const { title, tags, priority } = presentationFor(eventType);
    try {
      // 메시지가 한글이라 헤더(X-Title 등)에 그대로 실으면 인코딩 문제가 생길 수 있어, ASCII만 쓰는
      // JSON 발행 API를 쓴다(https://docs.ntfy.sh/publish/#publish-as-json).
      const response = await fetch(serverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ topic, message: text, title, tags, priority }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.database.prepare(`
        UPDATE ntfy_deliveries SET status = 'sent', last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
      `).run(eventId);
    } catch (error) {
      this.database.prepare(`
        UPDATE ntfy_deliveries SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
      `).run(error instanceof Error ? error.message : "ntfy 전송 실패", eventId);
    }
  }

  // ntfy 알림 설정의 존재 여부만 반환한다.
  status(): { enabled: boolean; topicConfigured: boolean; serverUrl: string } {
    const { topic, serverUrl } = this.getEffectiveSettings();
    return { enabled: Boolean(topic), topicConfigured: Boolean(topic), serverUrl };
  }

  // 관리자 설정 화면에 보여줄 현재 상태(topic은 URL의 일부일 뿐이라 Slack 토큰과 달리 그대로 보여준다).
  settingsForAdmin(): { topic: string | null; serverUrl: string } {
    const { topic, serverUrl } = this.getEffectiveSettings();
    return { topic: topic ?? null, serverUrl };
  }

  // 관리자가 입력한 ntfy 설정을 저장한다. 빈 값으로 온 필드는 기존 값을 그대로 유지한다.
  updateSettings(topic: string, serverUrl: string): void {
    const current = this.database.prepare("SELECT topic, server_url FROM ntfy_settings WHERE id = 1").get() as NtfySettingsRow | undefined;
    const nextTopic = topic.trim() || current?.topic || null;
    const nextServerUrl = serverUrl.trim() || current?.server_url || null;
    this.database.prepare(`
      INSERT INTO ntfy_settings(id, topic, server_url, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET topic = excluded.topic, server_url = excluded.server_url, updated_at = CURRENT_TIMESTAMP
    `).run(nextTopic, nextServerUrl);
  }
}
