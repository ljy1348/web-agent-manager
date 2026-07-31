import { describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { Notifier } from "../src/server/services/notifier";
import { SessionManager } from "../src/server/services/session-manager";

// 한도 배너를 다시 감지할 때마다(서버 재시작 등으로 in-memory 중복 방지가 리셋됐을 때 포함) 알림이
// 다시 나가지 않는지 확인한다. 실제 버그: registerRateLimitWait가 알림 event_id에 Date.now()를
// 섞어 호출마다 새 ID가 됐고, 알림 채널의 중복 방지는 event_id가 완전히 같을 때만 걸려서(ntfy.ts,
// slack.ts) 매번 새로 전송됐다. 재시작 직후 tmux에 남은 같은 배너를 다시 읽었을 때 실제로 두 번
// 연속 전송된 것을 DB(ntfy_deliveries)에서 확인함.
function stubDatabase(): AppDatabase {
  return {
    prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }),
  } as unknown as AppDatabase;
}

function stubAdapter(): ProviderAdapter {
  return { id: "codex", displayLabel: "Codex" } as unknown as ProviderAdapter;
}

describe("한도 도달 알림 event_id 안정성", () => {
  it("같은 배너를 여러 번 감지해도 같은 event_id로 알림을 보내 채널 중복 방지가 걸리게 한다", () => {
    const notified: string[] = [];
    const notifications: Notifier = { notify: async (eventId) => { notified.push(eventId); } };
    const realtime = { setTerminalHandlers: () => undefined } as any;
    const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined } as any;
    const manager = new SessionManager(stubDatabase(), [stubAdapter()], realtime, approvals, notifications);
    const chat = { id: 121, provider: "codex" } as any;
    const summary = "You've hit your session limit · resets 7:10pm (Asia/Seoul)";

    (manager as any).registerRateLimitWait(chat, summary);
    (manager as any).registerRateLimitWait(chat, summary);

    expect(notified).toHaveLength(2);
    expect(notified[0]).toBe(notified[1]);
    expect(notified[0]).not.toMatch(/:\d{13}$/);
  });

  it("리셋 시각이 다르면(새 한도 에피소드) event_id도 달라진다", () => {
    const notified: string[] = [];
    const notifications: Notifier = { notify: async (eventId) => { notified.push(eventId); } };
    const realtime = { setTerminalHandlers: () => undefined } as any;
    const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined } as any;
    const manager = new SessionManager(stubDatabase(), [stubAdapter()], realtime, approvals, notifications);
    const chat = { id: 121, provider: "codex" } as any;

    (manager as any).registerRateLimitWait(chat, "You've hit your session limit · resets 7:10pm (Asia/Seoul)");
    (manager as any).registerRateLimitWait(chat, "You've hit your session limit · resets 11:45pm (Asia/Seoul)");

    expect(notified[0]).not.toBe(notified[1]);
  });
});
