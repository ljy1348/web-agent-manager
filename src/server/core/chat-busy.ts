import type { AppDatabase } from "./database";
import type { RealtimeHub } from "../services/realtime";

// sendPrompt는 JSONL에 새 user가 쌓이기 전에 busy를 올린다. 그 직후 동기화가 이전 턴 종료만 보고
// idle로 되돌리지 않도록, 마지막으로 busy=true가 된 시각을 프로세스 메모리에 둔다.
const busyMarkedAt = new Map<number, number>();
const BUSY_HEAL_GRACE_MS = 8_000;

// 채팅의 "작업중" 여부를 DB에 영속화하고 웹소켓으로 알린다. 브로드캐스트만 하면 클라이언트가 재연결
// 중 이벤트를 놓쳤을 때 다시 확인할 방법이 없어(메시지 내용으로 추측하면 새 프롬프트를 보내고 아직
// 아무 것도 기록되기 전과 실제로 끝난 뒤를 구분할 수 없는 등 오판이 반복됐다), /chats 목록을 다시
// 불러오기만 해도 항상 정확한 현재 상태를 확인할 수 있게 DB 컬럼을 단일 진실 공급원으로 둔다.
export function setChatBusy(database: AppDatabase, realtime: RealtimeHub, chatId: number, busy: boolean): void {
  const current = database.prepare("SELECT busy FROM chats WHERE id = ?").get(chatId) as { busy: number } | undefined;
  if (current && Boolean(current.busy) === busy) return;
  database.prepare("UPDATE chats SET busy = ? WHERE id = ?").run(busy ? 1 : 0, chatId);
  if (busy) busyMarkedAt.set(chatId, Date.now());
  else busyMarkedAt.delete(chatId);
  console.debug("[web-agent-manager:chat:server]", "busy:update", { at: new Date().toISOString(), chatId, busy });
  realtime.broadcast("chat_busy", { chatId, busy });
}

// 종료가 확인된 세션의 busy 고착을 풀어도 되는 시각인지 본다. 프로세스 시작 전 값은 바로 회복한다.
export function shouldHealStuckBusy(chatId: number, now = Date.now()): boolean {
  const markedAt = busyMarkedAt.get(chatId);
  if (markedAt === undefined) return true;
  return now - markedAt >= BUSY_HEAL_GRACE_MS;
}
