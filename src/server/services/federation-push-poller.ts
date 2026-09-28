import type { AppDatabase } from "../core/database";
import type { FederationService } from "./federation";
import type { FcmNotifier } from "./fcm";
import type { PushEventRow } from "./push-event-journal";

// 중앙 WAM만 원격 이벤트의 커서를 가진다. 연결이 끊기면 커서를 유지해 복귀 뒤 재개한다.
export class FederationPushPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly database: AppDatabase, private readonly federation: FederationService, private readonly fcm: FcmNotifier) {}

  start(): void {
    if (!this.fcm.status().enabled || this.timer) return;
    void this.poll().catch(() => undefined);
    this.timer = setInterval(() => { void this.poll().catch(() => undefined); }, 15_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async poll(): Promise<void> {
    if (this.busy || !this.fcm.status().enabled) return;
    this.busy = true;
    try {
      for (const node of this.federation.list()) {
        try { await this.pollNode(node.id); } catch { /* 오프라인 노드는 다음 주기에 같은 커서에서 재시도 */ }
      }
    } finally { this.busy = false; }
  }

  private async pollNode(nodeId: string): Promise<void> {
    const row = this.database.prepare("SELECT last_seq FROM federation_push_cursors WHERE node_id = ?")
      .get(nodeId) as { last_seq: number } | undefined;
    const after = row?.last_seq ?? 0;
    const result = await this.federation.request(nodeId, `/federation/push-events?after=${after}`, "GET", undefined, 10_000);
    if (result.status !== 200) throw new Error(`원격 알림 조회 실패 (${result.status})`);
    const decoded = JSON.parse(Buffer.from(result.body).toString("utf8")) as { latest?: number; events?: PushEventRow[] };
    if (!Number.isSafeInteger(decoded.latest) || !Array.isArray(decoded.events)) throw new Error("원격 알림 응답 형식 오류");
    // 새 연결의 과거 이벤트는 알림으로 재생하지 않는다. 이후에는 DB 커서로 정확히 이어간다.
    if (!row) {
      this.database.prepare("INSERT OR IGNORE INTO federation_push_cursors(node_id, last_seq) VALUES (?, ?)")
        .run(nodeId, decoded.latest);
      return;
    }
    for (const event of decoded.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= after || typeof event.event_id !== "string" || typeof event.event_type !== "string") {
        throw new Error("원격 알림 이벤트 형식 오류");
      }
      await this.fcm.notify(`remote:${nodeId}:${event.event_id}`, event.event_type, "연결된 컴퓨터에 새 알림이 있습니다.");
      this.database.prepare("UPDATE federation_push_cursors SET last_seq = ?, updated_at = CURRENT_TIMESTAMP WHERE node_id = ?")
        .run(event.seq, nodeId);
    }
  }
}
