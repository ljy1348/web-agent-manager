import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scrollTmuxHistory = vi.fn(() => true);
const exitTmuxCopyMode = vi.fn();
const resizeTmuxWindow = vi.fn();

vi.mock("../src/server/services/tmux-input", () => ({
  scrollTmuxHistory,
  exitTmuxCopyMode,
  resizeTmuxWindow,
  isTmuxCopyMode: vi.fn(() => false),
  pastePromptToTmux: vi.fn(),
  sendTmuxEnter: vi.fn(),
  sendTmuxEscape: vi.fn(),
  sendTmuxBackspace: vi.fn(),
  sendTmuxLeft: vi.fn(),
  sendTmuxRight: vi.fn(),
  sendTmuxShiftTab: vi.fn(),
  sendTmuxText: vi.fn(),
}));

const { openDatabase } = await import("../src/server/core/database");
const { SessionManager } = await import("../src/server/services/session-manager");
import type { AppConfig } from "../src/server/core/config";

// 실제 PTY 없이 기록 스크롤 경로만 확인할 수 있는 SessionManager와 가짜 터미널을 만든다.
function buildManager() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-terminal-scroll-"));
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('admin', 'x', 'admin')").run();
  const userId = (database.prepare("SELECT id FROM users").get() as { id: number }).id;
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')").run();
  const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
  database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'web-agent-manager-test-scroll', 'running', 'ui', 0)").run(project.id);
  const chatId = (database.prepare("SELECT id FROM chats").get() as { id: number }).id;
  const realtime = { setTerminalHandlers: () => undefined, broadcast: () => undefined };
  const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined };
  const manager = new SessionManager(database, [], realtime as never, approvals as never, { notify: async () => undefined }, { resolveForChat: () => ({ id: 1, config_dir: null }), environment: () => ({}) } as never);
  const write = vi.fn();
  const resize = vi.fn();
  const screenResize = vi.fn();
  const terminal = { pty: { write, resize }, screen: { resize: screenResize, ansiSnapshot: vi.fn(() => "") }, rows: 36, buffer: "", approvalFingerprint: null, approvalCandidateFingerprint: null, tmuxName: "web-agent-manager-test-scroll" };
  (manager as unknown as { terminals: Map<number, unknown> }).terminals.set(chatId, terminal);
  return { dataDir, database, manager, chatId, terminal, write, resize, screenResize, userId };
}

describe("터미널 기록 스크롤", () => {
  beforeEach(() => {
    scrollTmuxHistory.mockReset();
    scrollTmuxHistory.mockReturnValue(true);
    exitTmuxCopyMode.mockReset();
    resizeTmuxWindow.mockReset();
  });

  it("세로 행 수만 PTY·tmux·화면 재구성기에 함께 적용한다", () => {
    const { dataDir, database, manager, chatId, terminal, resize, screenResize } = buildManager();

    manager.resizeTerminal(chatId, 58);

    expect((terminal as { rows: number }).rows).toBe(58);
    expect(resize).toHaveBeenCalledWith(256, 58);
    expect(screenResize).toHaveBeenCalledWith(256, 58);
    expect(resizeTmuxWindow).toHaveBeenCalledWith("web-agent-manager-test-scroll", 256, 58);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("비정상적으로 큰 행 요청은 상한으로 제한한다", () => {
    const { dataDir, database, manager, chatId, resize } = buildManager();

    manager.resizeTerminal(chatId, 10_000);

    expect(resize).toHaveBeenCalledWith(256, 120);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("스크롤 요청을 tmux 기록 이동으로 넘기고 기록 보기 상태를 기억한다", () => {
    const { dataDir, database, manager, chatId, terminal } = buildManager();

    manager.scrollTerminal(chatId, 12);

    expect(scrollTmuxHistory).toHaveBeenCalledWith("web-agent-manager-test-scroll", 12);
    expect((terminal as { copyMode?: boolean }).copyMode).toBe(true);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("한 번에 옮길 수 있는 줄 수를 제한하고, 0줄 요청은 tmux를 부르지 않는다", () => {
    const { dataDir, database, manager, chatId } = buildManager();

    manager.scrollTerminal(chatId, 100_000);
    manager.scrollTerminal(chatId, 0.4);

    expect(scrollTmuxHistory).toHaveBeenCalledTimes(1);
    expect(scrollTmuxHistory).toHaveBeenCalledWith("web-agent-manager-test-scroll", 200);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("기록을 올려둔 상태에서 키를 입력하면 실시간 화면으로 되돌린 뒤 전달한다", () => {
    const { dataDir, database, manager, chatId, terminal, write, userId } = buildManager();
    manager.scrollTerminal(chatId, 5);

    manager.writeTerminal(chatId, "ls", { id: userId, username: "admin", role: "admin" } as never);

    expect(exitTmuxCopyMode).toHaveBeenCalledWith("web-agent-manager-test-scroll");
    expect(write).toHaveBeenCalledWith("ls");
    expect((terminal as { copyMode?: boolean }).copyMode).toBe(false);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("기록 보기 중이 아니면 입력할 때마다 tmux를 추가로 부르지 않는다", () => {
    const { dataDir, database, manager, chatId, userId } = buildManager();

    manager.writeTerminal(chatId, "a", { id: userId, username: "admin", role: "admin" } as never);

    expect(exitTmuxCopyMode).not.toHaveBeenCalled();
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
