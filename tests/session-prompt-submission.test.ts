import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";

const tmuxMocks = vi.hoisted(() => ({
  pastePromptToTmux: vi.fn(),
  sendTmuxEnter: vi.fn(),
  sendTmuxBackspace: vi.fn(),
}));

vi.mock("../src/server/services/tmux-input", () => ({
  ...tmuxMocks,
  sendTmuxEscape: vi.fn(),
  sendTmuxLeft: vi.fn(),
  sendTmuxRight: vi.fn(),
  sendTmuxShiftTab: vi.fn(),
  sendTmuxText: vi.fn(),
  scrollTmuxHistory: vi.fn(() => false),
  exitTmuxCopyMode: vi.fn(),
  resizeTmuxWindow: vi.fn(),
}));

const { openDatabase } = await import("../src/server/core/database");
const { SessionManager } = await import("../src/server/services/session-manager");

const temporaryDirectories: string[] = [];

// 실제 PTY 없이 공급자별 준비·제출 상태 전환만 제어하는 SessionManager를 만든다.
function buildManager(initialScreen: string, provider: "codex" | "claude" = "codex", readPromptDraft?: (output: string) => string | null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-prompt-submit-data-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-prompt-submit-project-"));
  temporaryDirectories.push(dataDir, projectPath);
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'discovered')").run(projectPath);
  const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectPath) as { id: number };
  database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, ?, 'web-agent-manager-test-prompt-submit', 'running', 'ui', 0)").run(project.id, provider);
  const chatId = (database.prepare("SELECT id FROM chats").get() as { id: number }).id;
  let screen = initialScreen;
  const adapter = {
    id: provider,
    displayLabel: provider === "codex" ? "Codex" : "Claude",
    promptQuirks: { pasteSubmitDelayMs: provider === "claude" ? 160 : undefined, verifyPromptSubmission: true },
    isReady: (output: string) => output.trim() === "ready",
    isBusy: (output: string) => output.trim() === "busy",
    detectApproval: () => null,
    ...(readPromptDraft ? { readPromptDraft } : {}),
  } as unknown as ProviderAdapter;
  const realtime = { setTerminalHandlers: () => undefined, broadcast: vi.fn() };
  const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined };
  const manager = new SessionManager(database, [adapter], realtime as never, approvals as never, { notify: async () => undefined }, { resolveForChat: () => ({ id: 1, config_dir: null }), environment: () => ({}) } as never);
  const terminal = {
    pty: { write: vi.fn(), resize: vi.fn() },
    screen: { visibleText: () => screen },
    rows: 36,
    buffer: "",
    approvalFingerprint: null,
    approvalCandidateFingerprint: null,
    tmuxName: "web-agent-manager-test-prompt-submit",
  };
  (manager as unknown as { terminals: Map<number, unknown> }).terminals.set(chatId, terminal);
  return { database, manager, chatId, setScreen: (value: string) => { screen = value; } };
}

// 테스트가 확인할 현재 busy 값을 읽는다.
function chatBusy(database: ReturnType<typeof openDatabase>, chatId: number): number {
  return (database.prepare("SELECT busy FROM chats WHERE id = ?").get(chatId) as { busy: number }).busy;
}

beforeEach(() => {
  vi.useFakeTimers();
  tmuxMocks.pastePromptToTmux.mockReset();
  tmuxMocks.sendTmuxEnter.mockReset();
  tmuxMocks.sendTmuxBackspace.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("Codex 채팅 제출 확인", () => {
  it("첫 Enter 뒤 작업중 화면이면 즉시 제출 성공으로 처리한다", async () => {
    const { database, manager, chatId } = buildManager("busy");

    await manager.sendPrompt(chatId, "짧은 질문", null);

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("본문이 입력창에 남으면 Enter를 한 번만 재시도한다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready");
    tmuxMocks.sendTmuxEnter.mockImplementation(() => {
      setScreen(tmuxMocks.sendTmuxEnter.mock.calls.length === 1 ? "draft" : "busy");
    });

    const sending = manager.sendPrompt(chatId, "재시도 질문", null);
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(2);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("두 번 모두 제출되지 않으면 초안을 지우고 busy를 원복한다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready");
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("draft"));
    const sending = manager.sendPrompt(chatId, "실패😀", null).then(() => null, (error: Error) => error);

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await sending;

    expect(error?.message).toContain("제출을 확인하지 못했습니다");
    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(2);
    expect(tmuxMocks.sendTmuxBackspace).toHaveBeenCalledWith("web-agent-manager-test-prompt-submit", 3);
    expect(chatBusy(database, chatId)).toBe(0);
    database.close();
  });
});

describe("Claude 채팅 제출 확인", () => {
  it("붙여넣기 직후 Enter가 소비돼 초안이 남으면 한 번만 재시도한다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready", "claude");
    tmuxMocks.sendTmuxEnter.mockImplementation(() => {
      setScreen(tmuxMocks.sendTmuxEnter.mock.calls.length === 1 ? "draft" : "busy");
    });

    const sending = manager.sendPrompt(chatId, "긴 위임 프롬프트", null);
    await vi.advanceTimersByTimeAsync(2_500);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(2);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("초기화 중인 terminal map이 있어도 빈 입력 프롬프트가 나타난 뒤 붙여넣는다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("booting", "claude");
    setTimeout(() => setScreen("ready"), 300);
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("busy"));

    const sending = manager.sendPrompt(chatId, "준비 뒤 전송", null);
    await vi.advanceTimersByTimeAsync(200);
    expect(tmuxMocks.pastePromptToTmux).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;

    expect(tmuxMocks.pastePromptToTmux).toHaveBeenCalledTimes(1);
    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("두 번 모두 제출되지 않으면 Claude 오류로 남기고 초안을 지운다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready", "claude");
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("draft"));
    const sending = manager.sendPrompt(chatId, "실패 위임", null).then(() => null, (error: Error) => error);

    await vi.advanceTimersByTimeAsync(2_500);
    const error = await sending;

    expect(error?.message).toContain("Claude가 메시지 제출을 확인하지 못했습니다");
    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(2);
    expect(tmuxMocks.sendTmuxBackspace).toHaveBeenCalledTimes(1);
    expect(chatBusy(database, chatId)).toBe(0);
    database.close();
  });
});

// 채팅 #257 교착의 회귀 방어다. 입력창에 미전송 초안이 남으면 isReady·isBusy가 동시에 false여서 예전에는
// 준비 대기가 15초마다 타임아웃하며 상태를 error로 덮어써 웹에서 복구할 수 없었다. 이제는 초안이 남은
// 입력창도 입력 가능으로 보고, 남은 글자를 지운 뒤 새 입력으로 덮어쓴다.
describe("입력창에 남은 초안 덮어쓰기", () => {
  const draftReader = (output: string): string | null => {
    const screen = output.trim();
    if (screen === "draft") return "남은초안";
    if (screen === "ready" || screen === "busy") return "";
    return null;
  };

  it("초안이 남아 준비·작업중이 모두 아닌 화면에서도 초안을 지우고 전송한다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("draft", "claude", draftReader);
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("busy"));

    const sending = manager.sendPrompt(chatId, "새 질문", null);
    await vi.advanceTimersByTimeAsync(2_500);
    await sending;

    expect(tmuxMocks.sendTmuxBackspace).toHaveBeenCalledWith("web-agent-manager-test-prompt-submit", 4);
    expect(tmuxMocks.pastePromptToTmux).toHaveBeenCalledWith("web-agent-manager-test-prompt-submit", "새 질문");
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("입력창이 비어 있으면 지울 초안이 없어 백스페이스를 보내지 않는다", async () => {
    const { database, manager, chatId } = buildManager("busy", "claude", draftReader);

    const sending = manager.sendPrompt(chatId, "작업 중 추가 입력", null);
    await vi.advanceTimersByTimeAsync(2_500);
    await sending;

    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    expect(tmuxMocks.pastePromptToTmux).toHaveBeenCalledWith("web-agent-manager-test-prompt-submit", "작업 중 추가 입력");
    database.close();
  });

  it("입력창이 없는 승인·메뉴 화면에서는 전송하지 않고 이유를 알린다", async () => {
    const { database, manager, chatId } = buildManager("menu", "claude", draftReader);

    const sending = manager.sendPrompt(chatId, "보내면 안 되는 입력", null).then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = await sending;

    expect(error?.message).toContain("CLI가 입력 가능한 상태가 되지 않았습니다");
    expect(tmuxMocks.pastePromptToTmux).not.toHaveBeenCalled();
    database.close();
  });
});
