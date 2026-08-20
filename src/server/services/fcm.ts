import { GoogleAuth } from "google-auth-library";
import type { AppConfig } from "../core/config";
import type { AppDatabase } from "../core/database";
import type { Notifier } from "./notifier";

interface PushDeviceRow {
  id: number;
  token: string;
}

interface SendResult {
  success: boolean;
  errorCode?: string;
}

export type FcmSender = (tokens: string[], title: string, body: string, data: Record<string, string>) => Promise<SendResult[]>;

// 운영 이벤트 유형을 Android 알림 제목으로 변환한다.
export function fcmTitle(eventType: string): string {
  if (eventType === "task_completed") return "작업 완료";
  if (eventType === "approval_requested") return "권한 요청";
  if (eventType === "rate_limit_hit") return "사용량 한도 도달";
  if (eventType === "rate_limit_reset") return "사용량 한도 초기화";
  if (eventType === "usage_session_reset") return "사용량 세션 초기화";
  if (eventType === "terminal_exited") return "터미널 종료";
  if (eventType === "test") return "알림 테스트";
  return "웹 에이전트 관리자";
}

// Google 기본 자격증명으로 FCM HTTP v1 액세스 토큰을 받아 지정 기기들에 전송한다.
async function sendWithFirebase(config: AppConfig, tokens: string[], title: string, body: string, data: Record<string, string>): Promise<SendResult[]> {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  const projectId = config.fcm?.projectId || await auth.getProjectId();
  if (!projectId) throw new Error("Firebase 프로젝트 ID를 확인할 수 없습니다.");
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const accessToken = typeof access === "string" ? access : access.token;
  if (!accessToken) throw new Error("FCM 액세스 토큰을 발급받지 못했습니다.");
  return Promise.all(tokens.map(async (token): Promise<SendResult> => {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ message: {
        token,
        notification: { title, body },
        data,
        android: { priority: "HIGH", notification: { channel_id: "web_agent_manager_events", click_action: "OPEN_WEB_AGENT_MANAGER" } },
      } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { success: true };
    const failure = await response.json().catch(() => ({})) as { error?: { status?: string; details?: Array<{ errorCode?: string }> } };
    const fcmCode = failure.error?.details?.find((detail) => detail.errorCode)?.errorCode;
    if (fcmCode === "UNREGISTERED") return { success: false, errorCode: "messaging/registration-token-not-registered" };
    if (fcmCode === "INVALID_ARGUMENT") return { success: false, errorCode: "messaging/invalid-registration-token" };
    return { success: false, errorCode: failure.error?.status ?? `HTTP_${response.status}` };
  }));
}

// 로그인한 Android 기기 목록을 관리하고 기존 운영 알림을 FCM으로 중복 없이 전달한다.
export class FcmNotifier implements Notifier {
  private readonly sender: FcmSender;

  // 설정·DB와 테스트 가능한 전송 함수를 연결한다.
  constructor(private readonly config: AppConfig, private readonly database: AppDatabase, sender?: FcmSender) {
    this.sender = sender ?? ((tokens, title, body, data) => sendWithFirebase(config, tokens, title, body, data));
  }

  // 현재 사용자에게 FCM 토큰을 귀속시키고 토큰 회전 시 기존 행을 갱신한다.
  registerDevice(userId: number, token: string, label?: string): void {
    const normalizedToken = token.trim();
    if (normalizedToken.length < 20 || normalizedToken.length > 4096) throw new Error("FCM 등록 정보가 올바르지 않습니다.");
    const normalizedLabel = label?.trim().slice(0, 120) || null;
    this.database.prepare(`
      INSERT INTO push_devices(user_id, platform, token, label, active)
      VALUES (?, 'android', ?, ?, 1)
      ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, label = excluded.label,
        active = 1, updated_at = CURRENT_TIMESTAMP
    `).run(userId, normalizedToken, normalizedLabel);
  }

  // 현재 사용자에게 속한 지정 토큰을 비활성화한다.
  unregisterDevice(userId: number, token: string): void {
    this.database.prepare("UPDATE push_devices SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND token = ?")
      .run(userId, token.trim());
  }

  // 자격증명 원문 없이 FCM 활성 여부와 등록 기기 수만 반환한다.
  status(): { enabled: boolean; projectConfigured: boolean; registeredDevices: number } {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM push_devices WHERE active = 1").get() as { count: number };
    return { enabled: this.config.fcm?.enabled === true, projectConfigured: Boolean(this.config.fcm?.projectId), registeredDevices: row.count };
  }

  // 전송이 필요한 활성 기기를 500개씩 나눠 보내고 만료된 토큰을 자동 비활성화한다.
  async notify(eventId: string, eventType: string, text: string): Promise<void> {
    if (this.config.fcm?.enabled !== true) return;
    const devices = this.database.prepare(`
      SELECT d.id, d.token FROM push_devices d
      LEFT JOIN fcm_deliveries f ON f.device_id = d.id AND f.event_id = ? AND f.status = 'sent'
      WHERE d.active = 1 AND f.device_id IS NULL ORDER BY d.id
    `).all(eventId) as PushDeviceRow[];
    for (let offset = 0; offset < devices.length; offset += 500) {
      const batch = devices.slice(offset, offset + 500);
      let results: SendResult[];
      try {
        results = await this.sender(batch.map((device) => device.token), fcmTitle(eventType), text, { eventType, eventId });
      } catch (error) {
        const code = error instanceof Error ? error.name : "FCM 전송 실패";
        for (const device of batch) this.recordDelivery(eventId, eventType, device.id, "failed", code);
        continue;
      }
      for (let index = 0; index < batch.length; index += 1) {
        const device = batch[index];
        const result = results[index] ?? { success: false, errorCode: "missing-response" };
        this.recordDelivery(eventId, eventType, device.id, result.success ? "sent" : "failed", result.errorCode ?? null);
        if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(result.errorCode ?? "")) {
          this.database.prepare("UPDATE push_devices SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(device.id);
        }
      }
    }
  }

  // 기기별 전송 결과를 이벤트 단위로 갱신한다.
  private recordDelivery(eventId: string, eventType: string, deviceId: number, status: "sent" | "failed", errorCode: string | null): void {
    this.database.prepare(`
      INSERT INTO fcm_deliveries(event_id, device_id, event_type, status, attempts, last_error)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(event_id, device_id) DO UPDATE SET status = excluded.status, attempts = attempts + 1,
        last_error = excluded.last_error, updated_at = CURRENT_TIMESTAMP
    `).run(eventId, deviceId, eventType, status, errorCode);
  }
}
