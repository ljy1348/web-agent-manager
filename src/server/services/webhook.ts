import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent, request } from "undici";
import type { AppDatabase } from "../core/database";
import type { CredentialVault } from "./credential-vault";
import type { NotificationPresentation, Notifier } from "./notifier";

const MAX_URL_LENGTH = 2_048;
const MAX_SECRET_LENGTH = 1_024;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_EVENT_TYPE_LENGTH = 64;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 4_000;
const DEFAULT_TIMEOUT_MS = 10_000;

interface WebhookSettingsRow {
  endpoint_vault_id: string | null;
  signing_secret_vault_id: string | null;
  endpoint_host: string | null;
  enabled: number;
}

export interface WebhookTransportInput {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
}

export interface WebhookTransport {
  send(input: WebhookTransportInput): Promise<{ statusCode: number }>;
}

type ResolvedAddress = { address: string; family: number };
type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
type PinnedDispatch = (input: WebhookTransportInput, address: ResolvedAddress) => Promise<{ statusCode: number }>;

const blockedAddresses = new net.BlockList();
for (const [address, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"],
] as const) blockedAddresses.addSubnet(address, prefix, type);

function normalizeAddress(address: string): string {
  const withoutZone = address.split("%", 1)[0];
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : withoutZone;
}

export function isPublicWebhookAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  const version = net.isIP(normalized);
  if (!version) return false;
  return !blockedAddresses.check(normalized, version === 4 ? "ipv4" : "ipv6");
}

function validateEndpoint(value: string): URL {
  if (!value || value.length > MAX_URL_LENGTH || /[\0\r\n]/.test(value)) throw new Error("Webhook endpoint URL이 올바르지 않습니다.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Webhook endpoint URL이 올바르지 않습니다."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("Webhook endpoint는 인증정보·fragment 없는 HTTPS URL이어야 합니다.");
  const addressHost = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (!parsed.hostname || parsed.hostname.endsWith(".") || net.isIP(addressHost) && !isPublicWebhookAddress(addressHost)) throw new Error("Webhook endpoint는 공개 네트워크 주소여야 합니다.");
  return parsed;
}

function safeFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  const message = error instanceof Error ? error.message : "";
  if (/^http_status_\d{3}$/.test(message)) return message;
  if (message === "dns_unavailable" || message === "non_public_address" || message === "redirect_blocked") return message;
  return "transport_failed";
}

async function defaultPinnedDispatch(input: WebhookTransportInput, target: ResolvedAddress): Promise<{ statusCode: number }> {
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    },
  });
  try {
    const response = await request(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      signal: input.signal,
      dispatcher,
      headersTimeout: DEFAULT_TIMEOUT_MS,
      bodyTimeout: DEFAULT_TIMEOUT_MS,
    });
    await response.body.dump();
    if (response.statusCode >= 300 && response.statusCode < 400) throw new Error("redirect_blocked");
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`http_status_${response.statusCode}`);
    return { statusCode: response.statusCode };
  } finally {
    await dispatcher.close();
  }
}

// DNS의 모든 결과가 공개 주소일 때만 하나를 고르고, 같은 주소를 실제 TLS lookup에 고정한다.
// 검사 뒤 hostname을 다시 resolve하거나 redirect를 따라가지 않아 DNS rebinding SSRF를 막는다.
export function createSecureWebhookTransport(
  resolver: Resolver = async (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
  dispatch: PinnedDispatch = defaultPinnedDispatch,
): WebhookTransport {
  return {
    async send(input): Promise<{ statusCode: number }> {
      const parsed = validateEndpoint(input.url);
      let addresses: ResolvedAddress[];
      const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
      try { addresses = await resolver(hostname); } catch { throw new Error("dns_unavailable"); }
      if (!addresses.length) throw new Error("dns_unavailable");
      if (addresses.some(({ address }) => !isPublicWebhookAddress(address))) throw new Error("non_public_address");
      const response = await dispatch(input, addresses[0]);
      if (response.statusCode >= 300 && response.statusCode < 400) throw new Error("redirect_blocked");
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`http_status_${response.statusCode}`);
      return response;
    },
  };
}

export class WebhookNotifier implements Notifier {
  constructor(
    private readonly database: AppDatabase,
    private readonly vault: CredentialVault,
    private readonly transport: WebhookTransport = createSecureWebhookTransport(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  status(): { enabled: boolean; endpointConfigured: boolean; signingSecretConfigured: boolean; endpointHost: string | null } {
    return this.settingsForAdmin();
  }

  settingsForAdmin(): { enabled: boolean; endpointConfigured: boolean; signingSecretConfigured: boolean; endpointHost: string | null } {
    const row = this.row();
    return {
      enabled: row?.enabled === 1 && this.configured(row),
      endpointConfigured: Boolean(row?.endpoint_vault_id && this.vault.has(row.endpoint_vault_id)),
      signingSecretConfigured: Boolean(row?.signing_secret_vault_id && this.vault.has(row.signing_secret_vault_id)),
      endpointHost: row?.endpoint_host ?? null,
    };
  }

  updateSettings(endpointUrl: string, signingSecret: string, enabled: boolean): ReturnType<WebhookNotifier["settingsForAdmin"]> {
    if (typeof enabled !== "boolean") throw new Error("Webhook enabled 값은 boolean이어야 합니다.");
    const current = this.row();
    const endpoint = endpointUrl.trim();
    const secret = signingSecret.trim();
    const parsed = endpoint ? validateEndpoint(endpoint) : null;
    const secretBytes = Buffer.byteLength(secret, "utf8");
    if (secret && (secretBytes < 32 || secretBytes > MAX_SECRET_LENGTH || /[\0\r\n]/.test(secret))) {
      throw new Error("Webhook signing secret은 줄바꿈 없는 32~1024 byte여야 합니다.");
    }
    this.database.transaction(() => {
      const endpointVaultId = parsed
        ? this.vault.put("system", "webhook", "notification", "endpoint_url", parsed.toString())
        : current?.endpoint_vault_id ?? null;
      const secretVaultId = secret
        ? this.vault.put("system", "webhook", "notification", "signing_secret", secret)
        : current?.signing_secret_vault_id ?? null;
      if (enabled && (!endpointVaultId || !secretVaultId)) throw new Error("Webhook endpoint와 signing secret을 먼저 설정해야 합니다.");
      this.database.prepare(`INSERT INTO webhook_settings(id, endpoint_vault_id, signing_secret_vault_id, endpoint_host, enabled, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET endpoint_vault_id=excluded.endpoint_vault_id,
          signing_secret_vault_id=excluded.signing_secret_vault_id, endpoint_host=excluded.endpoint_host,
          enabled=excluded.enabled, updated_at=CURRENT_TIMESTAMP`)
        .run(endpointVaultId, secretVaultId, parsed?.hostname ?? current?.endpoint_host ?? null, enabled ? 1 : 0);
    })();
    return this.settingsForAdmin();
  }

  async notify(eventId: string, eventType: string, text: string, presentation?: NotificationPresentation): Promise<void> {
    const settings = this.row();
    if (!settings || settings.enabled !== 1 || !this.configured(settings)) return;
    const safeEventId = eventId.length <= MAX_EVENT_ID_LENGTH
      ? eventId
      : `sha256:${crypto.createHash("sha256").update(eventId).digest("hex")}`;
    const safeEventType = eventType.slice(0, MAX_EVENT_TYPE_LENGTH) || "event";
    const shouldSend = this.database.transaction(() => {
      const existing = this.database.prepare("SELECT status FROM webhook_deliveries WHERE event_id = ?").get(safeEventId) as { status: string } | undefined;
      if (existing?.status === "sent" || existing?.status === "sending") return false;
      if (existing) {
        this.database.prepare("UPDATE webhook_deliveries SET status='sending', attempts=attempts+1, last_http_status=NULL, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE event_id=?").run(safeEventId);
      } else {
        this.database.prepare("INSERT INTO webhook_deliveries(event_id, event_type, status, attempts) VALUES (?, ?, 'sending', 1)").run(safeEventId, safeEventType);
      }
      return true;
    })();
    if (!shouldSend) return;

    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      eventId: safeEventId,
      type: safeEventType,
      title: (presentation?.title ?? "웹 에이전트 관리자").slice(0, MAX_TITLE_LENGTH),
      text: text.slice(0, MAX_TEXT_LENGTH),
      timestamp,
    });
    let httpStatus: number | null = null;
    try {
      await this.vault.withSecret(settings.endpoint_vault_id!, `webhook:${safeEventType}:endpoint`, async (endpointUrl) => {
        validateEndpoint(endpointUrl);
        await this.vault.withSecret(settings.signing_secret_vault_id!, `webhook:${safeEventType}:sign`, async (signingSecret) => {
          const signature = crypto.createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex");
          const response = await this.transport.send({
            url: endpointUrl,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "user-agent": "web-agent-manager-webhook/1",
              "x-wam-timestamp": timestamp,
              "x-wam-signature": `sha256=${signature}`,
            },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          httpStatus = response.statusCode;
          if (httpStatus < 200 || httpStatus >= 300) throw new Error(`http_status_${httpStatus}`);
        });
      });
      this.database.prepare("UPDATE webhook_deliveries SET status='sent', last_http_status=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE event_id=?").run(httpStatus, safeEventId);
    } catch (error) {
      this.database.prepare("UPDATE webhook_deliveries SET status='failed', last_http_status=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE event_id=?")
        .run(httpStatus, safeFailure(error), safeEventId);
    }
  }

  async sendTest(eventId: string): Promise<void> {
    await this.notify(eventId, "test", "웹 에이전트 관리자 signed webhook 연동 테스트입니다.", { title: "Webhook 테스트" });
    const delivery = this.database.prepare("SELECT status, last_error FROM webhook_deliveries WHERE event_id = ?").get(eventId) as { status: string; last_error: string | null } | undefined;
    if (!delivery) throw Object.assign(new Error("Webhook이 활성화되어 있지 않습니다."), { statusCode: 409 });
    if (delivery.status !== "sent") throw Object.assign(new Error(`Webhook 전송 실패 (${delivery.last_error ?? "unknown"})`), { statusCode: 502 });
  }

  private row(): WebhookSettingsRow | undefined {
    return this.database.prepare("SELECT endpoint_vault_id, signing_secret_vault_id, endpoint_host, enabled FROM webhook_settings WHERE id = 1").get() as WebhookSettingsRow | undefined;
  }

  private configured(row: WebhookSettingsRow): boolean {
    return Boolean(row.endpoint_vault_id && row.signing_secret_vault_id && this.vault.has(row.endpoint_vault_id) && this.vault.has(row.signing_secret_vault_id));
  }
}
