import type { AppDatabase } from "../core/database";
import type { NormalizedAgentEvent } from "../../shared/provider-runtime";

// 공급자 hook/API/stream을 같은 형식으로 보존하는 append-only 관찰 원장이다. task 상태 반영과 원본
// 관찰 이력을 분리해, 나중에 구조화 어댑터와 TUI shadow 결과를 다시 비교할 수 있게 한다.
export class ProviderEventJournal {
  constructor(private readonly database: AppDatabase) {}

  record(event: NormalizedAgentEvent): boolean {
    return this.database.prepare(`
      INSERT OR IGNORE INTO provider_event_observations(
        id, provider, chat_id, session_id, turn_id, type, source, payload_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.provider,
      event.chatId,
      event.sessionId,
      event.turnId,
      event.type,
      event.source,
      JSON.stringify(event.payload),
      event.observedAt,
    ).changes > 0;
  }

  list(chatId: number, afterSequence = 0): Array<Record<string, unknown>> {
    return this.database.prepare(`
      SELECT sequence, id, provider, chat_id, session_id, turn_id, type, source, payload_json, observed_at
      FROM provider_event_observations WHERE chat_id = ? AND sequence > ? ORDER BY sequence
    `).all(chatId, Math.max(0, Math.trunc(afterSequence))) as Array<Record<string, unknown>>;
  }
}
