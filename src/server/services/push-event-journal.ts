import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import type { Notifier } from "./notifier";

export interface PushEventRow {
  seq: number;
  event_id: string;
  event_type: string;
}

// 원격 집계용 최소 이벤트 기록. 알림 본문·채팅 내용은 원격 중앙에 전송하지 않는다.
export class PushEventJournal implements Notifier {
  constructor(private readonly database: AppDatabase) {}

  async notify(eventId: string, eventType: string): Promise<void> {
    this.database.prepare("INSERT OR IGNORE INTO push_event_journal(event_id, event_type) VALUES (?, ?)")
      .run(crypto.createHash("sha256").update(eventId).digest("hex"), eventType.slice(0, 80));
  }

  latest(): number {
    return (this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM push_event_journal").get() as { seq: number }).seq;
  }

  list(after: number, limit = 100): PushEventRow[] {
    return this.database.prepare("SELECT seq, event_id, event_type FROM push_event_journal WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(after, Math.min(Math.max(limit, 1), 100)) as PushEventRow[];
  }

  prune(): void {
    this.database.prepare("DELETE FROM push_event_journal WHERE created_at < datetime('now', '-14 days')").run();
  }
}
