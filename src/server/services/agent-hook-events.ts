import type { AppDatabase } from "../core/database";
import { setChatBusy } from "../core/chat-busy";
import { createLogger } from "../core/logger";
import type { RealtimeHub } from "./realtime";
import crypto from "node:crypto";
import type { NormalizedAgentEvent, NormalizedAgentEventType } from "../../shared/provider-runtime";

// 훅을 받는 공급자. Grok은 전역 훅(#96)으로 받는다.
export type HookProvider = "claude" | "codex" | "grok";

// 관찰 훅 본문 중 WAM이 쓰는 필드만 둔다. Claude·Codex 모두 snake_case 공통 필드를 보낸다.
export interface AgentHookEvent {
  hook_event_name?: string;
  session_id?: string;
  source?: string;
  error?: string;
  // StopFailure의 오류 세부 문구(한도 리셋 안내가 들어 있을 수 있음).
  error_details?: string;
  // Codex 턴 이벤트의 턴 식별자. async 훅은 순서가 뒤바뀔 수 있어 최신 턴인지 가리는 데 쓴다.
  turn_id?: string;
  // Grok은 턴 ID를 camelCase로만 보낸다(session_id는 snake_case도 함께 온다, 실측).
  promptId?: string;
  sessionId?: string;
}

export interface AgentHookEventOptions {
  // 채팅에서 떼어 낸 옛 기록 파일을 다음 스캔에서 다시 반영하게 하는 콜백(#91).
  releaseHistoryFile?: (file: string) => void;
  // 훅 도착 관찰기(#93).
  observer?: HookObserver;
  // StopFailure(rate_limit) 보완 경로(#94). 화면 감지가 먼저 등록하도록 rateLimitDelayMs 뒤에 부른다.
  onRateLimit?: (chatId: number, details: string | null) => void;
  // UserPromptSubmit 도착 알림(#98). 웹 전송 확인이 가장 확실한 제출 증거로 쓴다.
  onPromptSubmit?: (chatId: number) => void;
  onNormalizedEvent?: (event: NormalizedAgentEvent) => void;
  rateLimitDelayMs?: number;
}

// 턴 종료로 보는 훅. StopFailure는 오류로 끝난 턴(Claude·Grok), StopCancelled는 사용자 중단(Grok)이다.
const TURN_END_EVENTS = new Set(["Stop", "StopFailure", "StopCancelled"]);

const NORMALIZED_HOOK_EVENT_TYPES: Record<string, NormalizedAgentEventType> = {
  SessionStart: "session.started",
  UserPromptSubmit: "prompt.started",
  Stop: "turn.completed",
  StopFailure: "turn.failed",
  StopCancelled: "turn.interrupted",
};

// 공급자별 hook 표기를 control plane 공통 이벤트로 바꾼다. 인식하지 못한 hook은 버리지 않고 기존
// 처리 경로가 계속 다루되, 정규화 스트림에는 넣지 않는다.
export function normalizeHookEvent(
  provider: HookProvider,
  chatId: number,
  event: AgentHookEvent,
  observedAt = new Date(),
): NormalizedAgentEvent | null {
  const eventName = event.hook_event_name ?? "";
  const type = NORMALIZED_HOOK_EVENT_TYPES[eventName];
  if (!type) return null;
  const sessionId = event.session_id ?? event.sessionId ?? null;
  const turnId = event.turn_id ?? event.promptId ?? null;
  const stableInput = `${provider}\u0000${chatId}\u0000${eventName}\u0000${sessionId ?? ""}\u0000${turnId ?? ""}\u0000${observedAt.toISOString()}`;
  return {
    schemaVersion: 1,
    id: crypto.createHash("sha256").update(stableInput).digest("base64url"),
    provider,
    chatId,
    sessionId,
    turnId,
    type,
    source: "hook",
    observedAt: observedAt.toISOString(),
    payload: eventName === "StopFailure" ? { error: event.error ?? null } : {},
  };
}

export interface HookObservationStats {
  since: string;
  hooks: Record<string, number>;
  pollingTurnEnds: number;
  matchedTurnEnds: number;
  missedTurnEnds: number;
  unobservedTurnEnds: number;
  lastMiss: { provider: string; chatId: number; at: string } | null;
}

// 훅 도착 신뢰성을 관찰한다. 폴링이 찾은 턴 종료마다 그 채팅의 Stop 훅이 유예 시간 안에 왔는지 대조해,
// 폴링·추측 fallback을 걷어도 되는지(#93) 판단할 근거를 모은다. 훅이 한 번도 온 적 없는 채팅(배포 전
// 시작한 세션·외부 CLI)은 누락으로 세지 않고 unobserved로만 센다. 서버 재시작 시 초기화되는 메모리 통계다.
export class HookObserver {
  private readonly lastHookAt = new Map<string, number>();
  private readonly lastTurnEndHookAt = new Map<string, number>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly stats: HookObservationStats;

  constructor(private readonly graceMs = 15_000, private readonly now: () => number = () => Date.now()) {
    this.stats = { since: new Date(this.now()).toISOString(), hooks: {}, pollingTurnEnds: 0, matchedTurnEnds: 0, missedTurnEnds: 0, unobservedTurnEnds: 0, lastMiss: null };
  }

  // 훅 수신을 기록한다.
  recordHook(provider: string, chatId: number, eventName: string): void {
    const key = `${provider}:${chatId}`;
    const at = this.now();
    this.lastHookAt.set(key, at);
    if (TURN_END_EVENTS.has(eventName)) this.lastTurnEndHookAt.set(key, at);
    const statKey = `${provider}.${eventName || "unknown"}`;
    this.stats.hooks[statKey] = (this.stats.hooks[statKey] ?? 0) + 1;
  }

  // 폴링이 찾은 턴 종료를 기록하고, 유예 시간 안에 Stop 훅이 오지 않으면 누락으로 센다.
  recordPollingTurnEnd(provider: string, chatId: number): void {
    const key = `${provider}:${chatId}`;
    this.stats.pollingTurnEnds += 1;
    if (!this.lastHookAt.has(key)) {
      this.stats.unobservedTurnEnds += 1;
      return;
    }
    const detectedAt = this.now();
    if (this.arrivedSince(key, detectedAt)) {
      this.stats.matchedTurnEnds += 1;
      return;
    }
    if (this.pending.has(key)) return;
    const timer = setTimeout(() => {
      this.pending.delete(key);
      if (this.arrivedSince(key, detectedAt)) {
        this.stats.matchedTurnEnds += 1;
        return;
      }
      this.stats.missedTurnEnds += 1;
      this.stats.lastMiss = { provider, chatId, at: new Date(detectedAt).toISOString() };
      hookLog.warn("turn_end_without_stop_hook", { provider, chatId, graceMs: this.graceMs });
    }, this.graceMs);
    timer.unref();
    this.pending.set(key, timer);
  }

  // 관리자 API용 통계 사본을 돌려준다.
  snapshot(): HookObservationStats {
    return { ...this.stats, hooks: { ...this.stats.hooks }, lastMiss: this.stats.lastMiss ? { ...this.stats.lastMiss } : null };
  }

  // 대기 중인 대조 타이머를 정리한다(서버 종료·테스트).
  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  // 폴링 감지 시각 전후 유예 시간 안에 턴 종료 훅이 왔는지 본다. 훅이 폴링보다 먼저 올 수도 있다.
  private arrivedSince(key: string, detectedAt: number): boolean {
    const at = this.lastTurnEndHookAt.get(key);
    return at !== undefined && at >= detectedAt - this.graceMs;
  }
}

// 훅 헤더로 전달하는 채팅 ID의 이름. tmux 환경의 WEB_AGENT_MANAGER_CHAT_ID를 그대로 싣는다.
export const HOOK_CHAT_ID_HEADER = "x-wam-chat-id";

// 기록 동기화를 앞당길 이벤트. 판정 규칙은 기존 동기화가 그대로 맡는다. Claude는 턴 이벤트를 HTTP 훅,
// SessionStart를 command 훅으로 보내고, Codex는 모두 command 훅으로 보낸다(StopFailure 없음).
const SYNC_TRIGGER_EVENTS: Record<HookProvider, Set<string>> = {
  claude: new Set(["UserPromptSubmit", "Stop", "StopFailure", "SessionStart"]),
  codex: new Set(["UserPromptSubmit", "Stop", "SessionStart"]),
  grok: new Set(["UserPromptSubmit", "Stop", "StopFailure", "StopCancelled", "SessionStart"]),
};

const hookLog = createLogger("agent-hook");

// 훅 헤더의 채팅 ID를 양의 정수로 해석한다. 환경변수가 없어 빈 문자열로 치환된 경우는 null이다.
export function parseHookChatId(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const chatId = Number(value.trim());
  return Number.isSafeInteger(chatId) && chatId > 0 ? chatId : null;
}

// Claude·Codex 관찰 훅을 받아 채팅의 session ID를 정확히 연결하고, 작업중 상태를 바로 반영한 뒤 기록
// 동기화를 즉시 한 번 요청한다. 완료 알림·메시지 반영은 기존 동기화가 맡고, JSONL 판정은 fallback으로 남는다.
// TODO(훅 관찰 뒤, #93): HookObserver의 missedTurnEnds가 사실상 0이고 배포 전 시작한 훅 없는 세션이 모두
// 재시작됐으면, 2초 폴링 주기를 늘리고 Codex claim·FIFO 귀속을 걷어낸 뒤 이 주석을 정리한다.
export class AgentHookEventService {
  private syncScheduled = false;
  // 채팅별 최신 Codex 턴 ID. async Stop이 다음 턴 시작보다 늦게 와도 새 턴의 작업중을 지우지 않게 한다.
  private readonly latestTurnId = new Map<number, string>();

  private readonly options: Required<Omit<AgentHookEventOptions, "observer">> & Pick<AgentHookEventOptions, "observer">;

  constructor(
    private readonly database: AppDatabase,
    private readonly realtime: RealtimeHub,
    private readonly requestSync: () => void,
    options: AgentHookEventOptions = {},
  ) {
    this.options = {
      releaseHistoryFile: options.releaseHistoryFile ?? (() => undefined),
      onRateLimit: options.onRateLimit ?? (() => undefined),
      onPromptSubmit: options.onPromptSubmit ?? (() => undefined),
      onNormalizedEvent: options.onNormalizedEvent ?? (() => undefined),
      rateLimitDelayMs: options.rateLimitDelayMs ?? 5_000,
      observer: options.observer,
    };
  }

  // 훅 요청 하나를 처리한다. 알 수 없는 채팅·이벤트는 무시하며, 결과와 무관하게 CLI에는 빈 응답을 준다.
  handle(provider: HookProvider, chatIdHeader: string | string[] | undefined, event: AgentHookEvent): void {
    const eventName = event.hook_event_name ?? "";
    const chatId = parseHookChatId(chatIdHeader);
    if (chatId === null) {
      hookLog.debug("event_without_chat", { provider, eventName, sessionId: event.session_id ?? null });
      return;
    }
    const chat = this.database.prepare("SELECT provider_session_id AS sessionId, history_file AS historyFile, status FROM chats WHERE id = ? AND provider = ?").get(chatId, provider) as
      { sessionId: string | null; historyFile: string | null; status: string } | undefined;
    if (!chat) {
      hookLog.warn("event_unknown_chat", { provider, eventName, chatId });
      return;
    }
    this.options.observer?.recordHook(provider, chatId, eventName);
    const normalized = normalizeHookEvent(provider, chatId, event);
    if (normalized) {
      try {
        this.options.onNormalizedEvent(normalized);
      } catch (error) {
        // 관찰 원장 실패가 공급자 훅 ACK 자체를 깨뜨리면 CLI가 훅을 실패로 처리할 수 있다. 기존
        // busy/세션 동기화 경로는 계속 진행하고 운영 로그로만 남긴다.
        hookLog.warn("normalized_event_record_failed", { provider, chatId, eventName, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const sessionId = event.session_id ?? event.sessionId;
    const turnId = event.turn_id ?? event.promptId;
    if (eventName === "StopFailure") {
      hookLog.warn("stop_failure", { provider, chatId, error: event.error ?? null, details: event.error_details?.slice(0, 200) ?? null });
      // 오류 값이 확인된 Claude만 리밋 대기로 잇는다. Grok StopFailure의 오류 표기는 아직 실측하지 못했다.
      if (provider === "claude" && event.error === "rate_limit") this.scheduleRateLimitWait(chatId, event.error_details ?? null);
    }
    if (eventName === "SessionStart" && sessionId && sessionId !== chat.sessionId) {
      this.bindSession(provider, chatId, chat.sessionId, chat.historyFile, sessionId, event.source ?? null);
    }
    this.applyBusy(chatId, chat.status, eventName, turnId);
    hookLog.debug("event", { provider, eventName, chatId });
    if (SYNC_TRIGGER_EVENTS[provider].has(eventName)) this.scheduleSync();
  }

  // 턴 시작·종료 훅을 작업중 표시에 바로 반영한다(#93). 종료된 채팅은 올리지 않고, Codex는 최신 턴의
  // 종료일 때만 내린다. JSONL 판정은 같은 값을 다시 쓰는 fallback이라 멱등하다.
  private applyBusy(chatId: number, status: string, eventName: string, turnId: string | undefined): void {
    if (eventName === "UserPromptSubmit") {
      if (turnId) this.latestTurnId.set(chatId, turnId);
      this.options.onPromptSubmit(chatId);
      if (["starting", "running", "resuming"].includes(status)) setChatBusy(this.database, this.realtime, chatId, true);
      return;
    }
    if (!TURN_END_EVENTS.has(eventName)) return;
    const latest = this.latestTurnId.get(chatId);
    if (turnId && latest && turnId !== latest) {
      hookLog.debug("stale_turn_end", { chatId, turnId, latest });
      return;
    }
    setChatBusy(this.database, this.realtime, chatId, false);
  }

  // 터미널이 알려 준 session ID를 채팅에 연결한다. Codex 첫 세션(ID 없음)과 Claude /clear·세션 전환이
  // 여기로 온다. 기록 파일은 새 JSONL이 생기면 기존 동기화가 session ID로 찾아 붙이므로 비워 둔다.
  // 옛 JSONL은 삭제하지 않으며, 동기화기가 잊게 해 다음 전체 스캔에서 숨김 외부 채팅으로 보존되게 한다.
  private bindSession(provider: HookProvider, chatId: number, previous: string | null, previousFile: string | null, next: string, source: string | null): void {
    const owner = this.database.prepare("SELECT id FROM chats WHERE provider = ? AND provider_session_id = ? AND id <> ?").get(provider, next, chatId) as
      { id: number } | undefined;
    if (owner) {
      // 이미 다른 채팅이 쓰는 ID(TUI 안에서 다른 채팅의 세션을 resume 등)는 그 채팅에서 떼어 오지 않는다.
      hookLog.warn("session_bind_conflict", { provider, chatId, ownerChatId: owner.id, sessionId: next, source });
      return;
    }
    this.database.prepare("UPDATE chats SET provider_session_id = ?, history_file = NULL WHERE id = ?").run(next, chatId);
    if (previousFile) this.options.releaseHistoryFile(previousFile);
    hookLog.info("session_bound", { provider, chatId, previous, next, source });
    this.realtime.broadcast("history_updated", { chatId });
  }

  // 한도로 멈춘 턴의 리밋 대기를 보완 등록한다(#94). 화면 감지(메뉴 확인 900ms 지연 포함)가 먼저 등록할
  // 시간을 준 뒤 부르며, 이미 대기가 있으면 호출받은 쪽이 아무것도 하지 않아 알림도 두 번 가지 않는다.
  private scheduleRateLimitWait(chatId: number, details: string | null): void {
    const timer = setTimeout(() => {
      try {
        this.options.onRateLimit(chatId, details);
      } catch (error) {
        hookLog.error("rate_limit_wait_failed", { chatId, error: error instanceof Error ? error.message : String(error) });
      }
    }, this.options.rateLimitDelayMs);
    timer.unref();
  }

  // 같은 틱에 몰린 이벤트는 동기화 한 번으로 합친다. HTTP 응답을 먼저 보내 CLI를 붙잡지 않는다.
  private scheduleSync(): void {
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    setImmediate(() => {
      this.syncScheduled = false;
      try {
        this.requestSync();
      } catch (error) {
        hookLog.error("sync_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
