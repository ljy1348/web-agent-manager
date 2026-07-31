import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();

vi.mock("node:child_process", () => ({ spawnSync }));

const { pastePromptToTmux, sendTmuxEnter } = await import("../src/server/services/tmux-input");

describe("tmux 입력 전달", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue({ status: 0, stderr: "" });
  });

  it("프롬프트를 tmux 버퍼로 붙여 넣고 Enter 키를 별도로 보낸다", () => {
    pastePromptToTmux("web_agent_manager_chat_44", "안녕\n두 번째 줄");
    sendTmuxEnter("web_agent_manager_chat_44");

    const bufferName = spawnSync.mock.calls[0][1][2];
    expect(spawnSync.mock.calls).toEqual([
      ["tmux", ["load-buffer", "-b", bufferName, "-"], { input: "안녕\n두 번째 줄", encoding: "utf8" }],
      ["tmux", ["paste-buffer", "-t", "web_agent_manager_chat_44", "-b", bufferName], { encoding: "utf8" }],
      ["tmux", ["delete-buffer", "-b", bufferName], { stdio: "ignore" }],
      ["tmux", ["send-keys", "-t", "web_agent_manager_chat_44", "Enter"], { encoding: "utf8" }],
    ]);
  });

  it("붙여넣기 실패 시에도 tmux 버퍼를 정리한다", () => {
    spawnSync
      .mockReturnValueOnce({ status: 0, stderr: "" })
      .mockReturnValueOnce({ status: 1, stderr: "paste failed" })
      .mockReturnValueOnce({ status: 0, stderr: "" });

    expect(() => pastePromptToTmux("web_agent_manager_chat_44", "요청")).toThrow("paste failed");
    expect(spawnSync.mock.calls[2][1][0]).toBe("delete-buffer");
  });
});
