import { describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { Notifier } from "../src/server/services/notifier";
import { SessionManager } from "../src/server/services/session-manager";

// renameSession의 입력 검증(빈 값·너무 긴 값)은 tmux/터미널 없이도 확인할 수 있다 — 실제 터미널로
// /rename을 보내는 경로는 진짜 tmux 세션이 필요해 여기서는 검증하지 않고, changeModel과 동일한
// waitUntilReady·pastePromptToTmux 경로를 그대로 재사용하는지 코드로 확인했다(session-manager.ts).
function stubDatabase(chat?: Record<string, unknown>): AppDatabase {
  return {
    prepare: () => ({ get: () => chat, run: () => ({ changes: 0 }), all: () => [] }),
  } as unknown as AppDatabase;
}

function buildManager(chat?: Record<string, unknown>): SessionManager {
  const notifications: Notifier = { notify: async () => undefined };
  const realtime = { setTerminalHandlers: () => undefined } as any;
  const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined } as any;
  const adapter = { id: "codex", displayLabel: "Codex" } as unknown as ProviderAdapter;
  return new SessionManager(stubDatabase(chat), [adapter], realtime, approvals, notifications, { resolveForChat: () => ({ id: 1, config_dir: null }), environment: () => ({}) } as never);
}

describe("채팅 이름 변경 입력 검증", () => {
  it("빈 이름은 거부한다", async () => {
    const manager = buildManager();
    await expect((manager as any).renameSession(1, "   ", { id: 1 })).rejects.toThrow("1자 이상 200자 이하");
  });

  it("200자를 넘는 이름은 거부한다", async () => {
    const manager = buildManager();
    await expect((manager as any).renameSession(1, "a".repeat(201), { id: 1 })).rejects.toThrow("1자 이상 200자 이하");
  });
});

// busy인 채팅에 이름/모델 변경을 시도하면 waitUntilReady의 15초 타임아웃(원인을 알 수 없는 "CLI가 입력
// 가능한 상태가 아닙니다" 오류)까지 가지 않고 즉시 명확한 사유로 실패해야 한다. 실제로 응답 생성 중인
// 채팅에 모델 변경을 시도해 재현된 버그였다.
describe("busy인 채팅의 관리 작업 차단", () => {
  const busyChat = { id: 1, provider: "codex", tmux_name: "web_agent_manager_1", project_path: "/tmp", busy: 1 };

  it("이름 변경은 busy면 waitUntilReady 전에 즉시 실패한다", async () => {
    const manager = buildManager(busyChat);
    await expect((manager as any).renameSession(1, "새 이름", { id: 1 })).rejects.toThrow("이름 변경");
  });

  it("모델 변경은 busy면 waitUntilReady 전에 즉시 실패한다", async () => {
    const manager = buildManager(busyChat);
    await expect((manager as any).changeModel(1, 1, "gpt-5.5", null, { id: 1 })).rejects.toThrow("모델 변경");
  });
});
