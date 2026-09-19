import { describe, expect, it } from "vitest";
import { normalizeHookEvent } from "../src/server/services/agent-hook-events";
import { AgentHookEventService } from "../src/server/services/agent-hook-events";
import { vi } from "vitest";

describe("공급자 hook 정규화 이벤트", () => {
  it.each([
    ["SessionStart", "session.started"],
    ["UserPromptSubmit", "prompt.started"],
    ["Stop", "turn.completed"],
    ["StopFailure", "turn.failed"],
    ["StopCancelled", "turn.interrupted"],
  ] as const)("%s를 %s로 매핑한다", (hookEvent, normalizedType) => {
    const event = normalizeHookEvent("grok", 17, {
      hook_event_name: hookEvent,
      session_id: "session-1",
      turn_id: "turn-1",
      error: hookEvent === "StopFailure" ? "rate_limit" : undefined,
      error_details: "저장하면 안 되는 긴 공급자 오류 원문",
    }, new Date("2026-09-12T03:00:00Z"));

    expect(event).toMatchObject({
      schemaVersion: 1,
      provider: "grok",
      chatId: 17,
      sessionId: "session-1",
      turnId: "turn-1",
      type: normalizedType,
      source: "hook",
      observedAt: "2026-09-12T03:00:00.000Z",
    });
    expect(JSON.stringify(event)).not.toContain("저장하면 안 되는");
  });

  it("아직 계약에 없는 hook은 기존 처리 경로만 쓰도록 null을 반환한다", () => {
    expect(normalizeHookEvent("claude", 3, { hook_event_name: "UnknownFutureHook" })).toBeNull();
  });

  it("hook 처리기가 정규화 이벤트 콜백을 기존 busy 처리와 함께 호출한다", () => {
    const normalized = vi.fn();
    const database = { prepare: () => ({ get: () => ({ sessionId: "session-1", historyFile: null, status: "running" }), run: () => ({ changes: 1 }) }) };
    const realtime = { broadcast: vi.fn() };
    const service = new AgentHookEventService(database as never, realtime as never, () => undefined, { onNormalizedEvent: normalized });

    service.handle("codex", "7", { hook_event_name: "UserPromptSubmit", session_id: "session-1", turn_id: "turn-1" });

    expect(normalized).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", chatId: 7, type: "prompt.started", source: "hook" }));
  });
});
