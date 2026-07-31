import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { CodexAdapter } from "../src/server/providers/codex";
import type { HistoryMessage, HistorySession } from "../src/server/providers/provider";

function session(provider: "codex" | "claude", turnEndedAt: string | null = null): HistorySession {
  return {
    provider,
    sessionId: `${provider}-session`,
    cwd: "/home/testuser/web-agent-manager",
    title: "테스트",
    historyFile: "/tmp/session.jsonl",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    messages: [],
    turnEndedAt,
  };
}

describe("히스토리 동기화 완료 판정", () => {
  it("Codex는 작업 중 assistant 조각만 새로 생겨도 완료 알림을 보내지 않고 작업중 상태를 유지한다", () => {
    const current = session("codex");
    const last = { id: "assistant-1", role: "assistant" as const, kind: "message", content: "진행 중", createdAt: "2026-07-10T00:00:01.000Z" };
    const decision = new CodexAdapter().evaluateHistorySync({ session: current, last, newMessages: [last], isTurnEnd: false });

    expect(decision.notifyCompletion).toBe(false);
    expect(decision.clearBusy).toBe(false);
  });

  it("Codex는 턴 종료 이벤트가 온 뒤 마지막 메시지가 assistant일 때만 완료로 본다", () => {
    const current = session("codex", "2026-07-10T00:00:02.000Z");
    const last = { id: "assistant-1", role: "assistant" as const, kind: "message", content: "완료", createdAt: "2026-07-10T00:00:01.000Z" };
    const decision = new CodexAdapter().evaluateHistorySync({ session: current, last, newMessages: [], isTurnEnd: true });

    expect(decision.notifyCompletion).toBe(true);
    expect(decision.clearBusy).toBe(true);
  });

  it("Codex 리밋처럼 assistant 없이 턴만 끝난 경우는 작업중만 내리고 완료 알림은 보내지 않는다", () => {
    const current = session("codex", "2026-07-10T00:00:02.000Z");
    const last = { id: "user-1", role: "user" as const, kind: "message", content: "요청", createdAt: "2026-07-10T00:00:01.000Z" };
    const decision = new CodexAdapter().evaluateHistorySync({ session: current, last, newMessages: [], isTurnEnd: true });

    expect(decision.notifyCompletion).toBe(false);
    expect(decision.clearBusy).toBe(true);
  });

  it("Claude는 end_turn 없는 새 assistant 응답만으로는 완료 알림을 보내지 않고 작업중 상태를 유지한다", () => {
    const current = session("claude");
    const last = { id: "assistant-1", role: "assistant" as const, kind: "text", content: "완료", createdAt: "2026-07-10T00:00:01.000Z" };
    const decision = new ClaudeAdapter("", {}).evaluateHistorySync({ session: current, last, newMessages: [last], isTurnEnd: false });

    expect(decision.notifyCompletion).toBe(false);
    expect(decision.clearBusy).toBe(false);
  });

  it("Claude는 end_turn assistant 응답이 새로 생겼을 때만 완료로 본다", () => {
    const current = session("claude");
    const last = { id: "assistant-1", role: "assistant" as const, kind: "turn_end", content: "완료", createdAt: "2026-07-10T00:00:01.000Z" };
    const decision = new ClaudeAdapter("", {}).evaluateHistorySync({ session: current, last, newMessages: [last], isTurnEnd: false });

    expect(decision.notifyCompletion).toBe(true);
    expect(decision.clearBusy).toBe(true);
  });

  it("Claude 도구 호출 턴은 작업중 유지로 보고 완료 알림을 보내지 않는다", () => {
    const current = session("claude");
    const last = { id: "assistant-tool", role: "assistant" as const, kind: "tool_call", content: "[도구: Task]", createdAt: "2026-07-10T00:00:01.000Z" };
    const decision = new ClaudeAdapter("", {}).evaluateHistorySync({ session: current, last, newMessages: [last], isTurnEnd: false });

    expect(decision.markBusy).toBe(true);
    expect(decision.notifyCompletion).toBe(false);
    expect(decision.clearBusy).toBe(false);
  });

  it("공급자 정책은 새 사용자 턴을 작업중 시작으로 판정한다", () => {
    const current = session("claude");
    const userMessage: HistoryMessage = { id: "user-1", role: "user", kind: "text", content: "요청", createdAt: "2026-07-10T00:00:01.000Z" };
    const decision = new ClaudeAdapter("", {}).evaluateHistorySync({ session: current, last: userMessage, newMessages: [userMessage], isTurnEnd: false });

    expect(decision.markBusy).toBe(true);
  });
});
