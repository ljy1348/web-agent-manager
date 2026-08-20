import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();

vi.mock("node:child_process", () => ({ spawnSync }));

const { pastePromptToTmux, sendTmuxEnter, scrollTmuxHistory, exitTmuxCopyMode, resizeTmuxWindow } = await import("../src/server/services/tmux-input");

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
      ["tmux", ["paste-buffer", "-p", "-t", "web_agent_manager_chat_44", "-b", bufferName], { encoding: "utf8" }],
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

describe("tmux 기록 스크롤", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue({ status: 0, stderr: "", stdout: "1\n" });
  });

  it("양수는 과거 방향으로 copy-mode를 진입시켜 이동하고 남은 모드 상태를 돌려준다", () => {
    const inMode = scrollTmuxHistory("web_agent_manager_chat_7", 5);

    expect(spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ["copy-mode", "-e", "-t", "web_agent_manager_chat_7"],
      ["send-keys", "-X", "-t", "web_agent_manager_chat_7", "-N", "5", "scroll-up"],
      ["display-message", "-p", "-t", "web_agent_manager_chat_7", "#{pane_in_mode}"],
    ]);
    expect(inMode).toBe(true);
  });

  it("음수는 기록 보기 중일 때만 현재 화면 방향으로 이동한다", () => {
    spawnSync
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "1\n" })
      .mockReturnValueOnce({ status: 0, stderr: "" })
      .mockReturnValueOnce({ status: 0, stderr: "" })
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "0\n" });

    const inMode = scrollTmuxHistory("web_agent_manager_chat_7", -3);

    expect(spawnSync.mock.calls[2][1]).toEqual(["send-keys", "-X", "-t", "web_agent_manager_chat_7", "-N", "3", "scroll-down"]);
    expect(inMode).toBe(false);
  });

  it("이미 최신 화면이면 아래 방향 요청은 tmux 화면을 건드리지 않는다", () => {
    spawnSync.mockReturnValue({ status: 0, stderr: "", stdout: "0\n" });

    const inMode = scrollTmuxHistory("web_agent_manager_chat_7", -5);

    expect(spawnSync.mock.calls.map((call) => call[1][0])).toEqual(["display-message"]);
    expect(inMode).toBe(false);
  });

  it("기록 보기 종료는 copy-mode 취소 키를 보낸다", () => {
    exitTmuxCopyMode("web_agent_manager_chat_7");

    expect(spawnSync.mock.calls[0][1]).toEqual(["send-keys", "-X", "-t", "web_agent_manager_chat_7", "cancel"]);
  });
});

describe("tmux 화면 크기", () => {
  it("가로·세로 논리 크기를 지정한 창에 적용한다", () => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue({ status: 0, stderr: "" });

    resizeTmuxWindow("web_agent_manager_chat_7", 256, 58);

    expect(spawnSync).toHaveBeenCalledWith("tmux", ["resize-window", "-t", "web_agent_manager_chat_7", "-x", "256", "-y", "58"], { encoding: "utf8" });
  });
});
