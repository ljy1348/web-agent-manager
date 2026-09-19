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
const { claudeQueuedPromptRecorded } = await import("../src/server/providers/claude");

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
    isInitializing: (output: string) => output.trim() === "initializing",
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
  return { database, manager, chatId, adapter, setScreen: (value: string) => { screen = value; } };
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

describe("터미널 진단 스냅샷", () => {
  it("같은 화면에서 서버 DB 상태와 어댑터 판정·대기 승인 정보를 읽기 전용으로 보존한다", () => {
    const { database, manager, chatId } = buildManager("busy", "codex", (output) => output === "busy" ? "남은 초안" : null);
    database.prepare(`
      INSERT INTO approvals(id, chat_id, provider, request_type, request_payload, status)
      VALUES ('approval-snapshot', ?, 'codex', 'terminal_approval', '{}', 'pending')
    `).run(chatId);

    const snapshot = manager.captureTerminalDiagnostic(chatId);

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      serverPid: process.pid,
      chat: { id: chatId, provider: "codex", status: "running", busy: false },
      terminal: { attached: true, rows: 36, copyMode: false },
      classification: { isBusy: true, isReady: false, promptDraft: "남은 초안", approval: null, permissionMode: null },
      pendingApprovals: [{ id: "approval-snapshot", requestType: "terminal_approval", status: "pending" }],
      screen: "busy",
    });
    expect(new Date(snapshot.capturedAt).toString()).not.toBe("Invalid Date");
    expect(chatBusy(database, chatId)).toBe(0);
    database.close();
  });

  it("연결된 터미널이 없으면 빈 파일 대신 명확한 오류를 낸다", () => {
    const { database, manager, chatId } = buildManager("ready");
    (manager as unknown as { terminals: Map<number, unknown> }).terminals.delete(chatId);

    expect(() => manager.captureTerminalDiagnostic(chatId)).toThrow("실행 중인 터미널이 없어");
    database.close();
  });
});

describe("Codex 채팅 제출 확인", () => {
  it("resume 초기화 화면이 끝나기 전에는 composer가 보여도 질문을 붙여넣지 않는다", async () => {
    const draftReader = (output: string): string | null => output.trim() === "initializing" || output.trim() === "ready" ? "" : null;
    const { database, manager, chatId, setScreen } = buildManager("initializing", "codex", draftReader);
    setTimeout(() => setScreen("ready"), 300);
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("busy"));

    const sending = manager.sendPrompt(chatId, "재개 뒤 질문", null);
    await vi.advanceTimersByTimeAsync(200);
    expect(tmuxMocks.pastePromptToTmux).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;

    expect(tmuxMocks.pastePromptToTmux).toHaveBeenCalledTimes(1);
    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("첫 Enter 뒤 작업중 화면이면 즉시 제출 성공으로 처리한다", async () => {
    const { database, manager, chatId } = buildManager("busy");

    await manager.sendPrompt(chatId, "짧은 질문", null);

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    expect(chatBusy(database, chatId)).toBe(1);
    expect(database.prepare("SELECT chat_id AS chatId, prompt FROM chat_history_claims").get())
      .toEqual({ chatId, prompt: "짧은 질문" });
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

  it("새 세션 MCP 부팅 busy 중에도 composer에 프롬프트가 남으면 Enter를 재시도한다", async () => {
    const draftReader = (output: string): string | null => {
      if (output.trim() === "busy") return "전송되지 않은 위임 프롬프트";
      if (output.trim() === "ready") return "";
      return null;
    };
    const { database, manager, chatId, setScreen } = buildManager("ready", "codex", draftReader);
    tmuxMocks.sendTmuxEnter.mockImplementation(() => {
      setScreen(tmuxMocks.sendTmuxEnter.mock.calls.length === 1 ? "busy" : "ready");
    });

    const sending = manager.sendPrompt(chatId, "새 Codex 위임", null);
    await vi.advanceTimersByTimeAsync(3_000);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(2);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("기존 Codex 세션은 busy 화면만으로 성공 처리하지 않고 실제 새 user 기록을 확인한다", async () => {
    const { database, manager, chatId, adapter, setScreen } = buildManager("ready", "codex");
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-prompt-history-"));
    temporaryDirectories.push(historyDir);
    const historyFile = path.join(historyDir, "session.json");
    let users = [{ id: "old-user", content: "이전 질문" }];
    const persist = () => fs.writeFileSync(historyFile, JSON.stringify(users));
    persist();
    adapter.parseHistoryFile = () => ({
      sessionId: "session-1",
      provider: "codex",
      title: "기존 세션",
      cwd: historyDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      historyFile,
      messages: users.map((item) => ({ id: item.id, role: "user" as const, kind: "message", content: item.content, createdAt: new Date().toISOString() })),
    });
    database.prepare("UPDATE chats SET history_file = ?, provider_session_id = 'session-1' WHERE id = ?").run(historyFile, chatId);
    tmuxMocks.sendTmuxEnter.mockImplementation(() => {
      setScreen("busy");
      if (tmuxMocks.sendTmuxEnter.mock.calls.length === 2) {
        users = [...users, { id: "new-user", content: "실제 질문" }];
        persist();
      }
    });

    const sending = manager.sendPrompt(chatId, "실제 질문", null);
    await vi.advanceTimersByTimeAsync(2_000);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(2);
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("Enter를 세 번 더 시도해도 제출되지 않으면 초안을 지우고 busy를 원복한다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready");
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("draft"));
    const sending = manager.sendPrompt(chatId, "실패😀", null).then(() => null, (error: Error) => error);

    await vi.advanceTimersByTimeAsync(7_000);
    const error = await sending;

    expect(error?.message).toContain("제출을 확인하지 못했습니다");
    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(4);
    expect(tmuxMocks.sendTmuxBackspace).toHaveBeenCalledWith("web-agent-manager-test-prompt-submit", 3);
    expect(chatBusy(database, chatId)).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM chat_history_claims").get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("원장 추적 전송은 ACK가 모호해도 Enter를 반복하거나 초안을 지우지 않는다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready");
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("draft"));
    const sending = manager.sendPrompt(chatId, "한 번만 시도", null, { trackedDelivery: true }).then(() => null, (error: Error) => error);

    await vi.advanceTimersByTimeAsync(7_000);
    const error = await sending;

    expect(error?.name).toBe("PromptDeliveryUnknownError");
    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    expect((database.prepare("SELECT COUNT(*) AS count FROM chat_history_claims").get() as { count: number }).count).toBe(1);
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

  it("Enter를 세 번 더 시도해도 제출되지 않으면 Claude 오류로 남기고 초안을 지운다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready", "claude");
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("draft"));
    const sending = manager.sendPrompt(chatId, "실패 위임", null).then(() => null, (error: Error) => error);

    await vi.advanceTimersByTimeAsync(7_500);
    const error = await sending;

    expect(error?.message).toContain("Claude가 메시지 제출을 확인하지 못했습니다");
    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(4);
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

  it("실행 표식 없이 composer 초안만 남았으면 고착된 busy를 대기 상태로 내린다", () => {
    const { database, manager, chatId } = buildManager("draft", "codex", draftReader);
    database.prepare("UPDATE chats SET busy = 1 WHERE id = ?").run(chatId);
    const chat = (manager as unknown as { getChat(id: number): unknown }).getChat(chatId);

    (manager as unknown as { syncTerminalBusy(chat: unknown, snapshot: string): void }).syncTerminalBusy(chat, "draft");

    expect(chatBusy(database, chatId)).toBe(0);
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

describe("위임 채팅 origin 승격", () => {
  it("사람이 직접 보낸 프롬프트는 origin을 user로 승격한다", async () => {
    const { database, manager, chatId } = buildManager("busy");
    database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
    database.prepare("UPDATE chats SET origin = 'delegation' WHERE id = ?").run(chatId);

    await manager.sendPrompt(chatId, "직접 이어서 작업하세요.", { id: 1, username: "admin", role: "admin" });

    expect((database.prepare("SELECT origin FROM chats WHERE id = ?").get(chatId) as { origin: string }).origin).toBe("user");
    expect((database.prepare("SELECT last_user_activity_at AS value FROM chats WHERE id = ?").get(chatId) as { value: string | null }).value).not.toBeNull();
    database.close();
  });

  it("실제 제출이 실패해도 웹 사용자의 전송 시각은 즉시 남긴다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready", "codex");
    database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("draft"));

    const sending = manager.sendPrompt(chatId, "실패해도 활동", { id: 1, username: "admin", role: "admin" }).then(() => null, (error: Error) => error);
    const activity = (database.prepare("SELECT last_user_activity_at AS value FROM chats WHERE id = ?").get(chatId) as { value: string | null }).value;
    expect(activity).not.toBeNull();
    await vi.advanceTimersByTimeAsync(7_000);
    expect((await sending)?.message).toContain("제출을 확인하지 못했습니다");
    database.close();
  });

  it("user가 null인 시스템 자동 입력은 origin을 바꾸지 않는다", async () => {
    const { database, manager, chatId } = buildManager("busy");
    database.prepare("UPDATE chats SET origin = 'delegation' WHERE id = ?").run(chatId);

    await manager.sendPrompt(chatId, "위임 작업입니다.", null);

    expect((database.prepare("SELECT origin FROM chats WHERE id = ?").get(chatId) as { origin: string }).origin).toBe("delegation");
    database.close();
  });
});

// #98 회귀 방어: Codex 전송 확인이 실제 제출을 실패로 오판하거나(대기열·기록 지연), 작업 중 후속 입력을
// 확인하지 않던 문제. 실패는 글이 입력창에 계속 남아 있을 때만 판정한다.
describe("전송 확인 증거 확대(#98)", () => {
  // "draft"면 보낸 글이 입력창에 남은 상태, "ready"·"busy"면 빈 입력창, "menu"면 입력창이 없는 화면이다.
  const draftReader = (output: string): string | null => {
    const screen = output.trim();
    if (screen === "draft") return "보낸 질문";
    if (screen === "ready" || screen === "busy") return "";
    return null;
  };

  it("기록 있는 Codex 채팅은 JSONL 기록이 늦어도 입력창이 비워지면 성공 처리하고 입력을 지우지 않는다", async () => {
    const { database, manager, chatId, adapter, setScreen } = buildManager("ready", "codex", draftReader);
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-prompt-history-"));
    temporaryDirectories.push(historyDir);
    const historyFile = path.join(historyDir, "session.json");
    fs.writeFileSync(historyFile, "[]");
    // 대기열에 들어간 질문은 한참 뒤에야 기록된다(실측 #1061: 7.6초). 여기서는 끝까지 기록하지 않는다.
    adapter.parseHistoryFile = () => ({ sessionId: "s", provider: "codex", title: "t", cwd: historyDir, createdAt: "", updatedAt: "", historyFile, messages: [] });
    database.prepare("UPDATE chats SET history_file = ?, provider_session_id = 's' WHERE id = ?").run(historyFile, chatId);
    tmuxMocks.pastePromptToTmux.mockImplementation(() => setScreen("draft"));
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("busy"));

    const sending = manager.sendPrompt(chatId, "보낸 질문", null);
    await vi.advanceTimersByTimeAsync(1_500);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("작업 중 후속 입력도 글이 입력창에 남으면 Enter를 재시도해 대기열에 넣는다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("busy", "codex", draftReader);
    database.prepare("UPDATE chats SET busy = 1 WHERE id = ?").run(chatId);
    tmuxMocks.pastePromptToTmux.mockImplementation(() => setScreen("draft"));
    tmuxMocks.sendTmuxEnter.mockImplementation(() => {
      if (tmuxMocks.sendTmuxEnter.mock.calls.length >= 2) setScreen("busy");
    });

    const sending = manager.sendPrompt(chatId, "보낸 질문", null);
    await vi.advanceTimersByTimeAsync(2_500);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(2);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    database.close();
  });

  it("UserPromptSubmit 훅이 오면 입력창을 판독할 수 없는 화면이어도 바로 성공 처리한다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready", "codex", draftReader);
    tmuxMocks.pastePromptToTmux.mockImplementation(() => setScreen("draft"));
    tmuxMocks.sendTmuxEnter.mockImplementation(() => {
      setScreen("menu");
      manager.notePromptSubmitted(chatId);
    });

    const sending = manager.sendPrompt(chatId, "보낸 질문", null);
    await vi.advanceTimersByTimeAsync(500);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    database.close();
  });

  it("입력창이 사라진 화면에서 글이 남았다는 증거가 없으면 지우지 않고 성공으로 둔다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready", "codex", draftReader);
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("menu"));

    const sending = manager.sendPrompt(chatId, "보낸 질문", null).then(() => "ok", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(7_000);

    expect(await sending).toBe("ok");
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    database.close();
  });

  it("붙여넣은 글이 입력창에 보이기 전에는 Enter를 보내지 않는다", async () => {
    const { database, manager, chatId, setScreen } = buildManager("ready", "codex", draftReader);
    tmuxMocks.pastePromptToTmux.mockImplementation(() => { setTimeout(() => setScreen("draft"), 300); });
    tmuxMocks.sendTmuxEnter.mockImplementation(() => setScreen("busy"));

    const sending = manager.sendPrompt(chatId, "보낸 질문", null);
    await vi.advanceTimersByTimeAsync(250);
    expect(tmuxMocks.sendTmuxEnter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("CLI가 줄바꿈·연속 공백을 다르게 기록해도 같은 질문의 JSONL 기록을 제출 증거로 인정한다", async () => {
    const { database, manager, chatId, adapter, setScreen } = buildManager("ready", "codex");
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-prompt-history-"));
    temporaryDirectories.push(historyDir);
    const historyFile = path.join(historyDir, "session.json");
    let recorded: string[] = [];
    const persist = () => fs.writeFileSync(historyFile, JSON.stringify(recorded));
    persist();
    adapter.parseHistoryFile = () => ({ sessionId: "s", provider: "codex", title: "t", cwd: historyDir, createdAt: "", updatedAt: "", historyFile,
      messages: recorded.map((content, index) => ({ id: `u${index}`, role: "user" as const, kind: "message", content, createdAt: "" })) });
    database.prepare("UPDATE chats SET history_file = ?, provider_session_id = 's' WHERE id = ?").run(historyFile, chatId);
    tmuxMocks.sendTmuxEnter.mockImplementation(() => {
      setScreen("busy");
      recorded = ["첫 줄 둘째 줄"];
      persist();
    });

    const sending = manager.sendPrompt(chatId, "첫 줄\n\n둘째   줄", null);
    await vi.advanceTimersByTimeAsync(1_000);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    database.close();
  });
});

// 실사용 #1095: 작업 중인 Claude에 보낸 후속 입력이 0.3초 만에 대기열에 들어갔는데(JSONL queue-operation
// enqueue) 훅도 user 기록도 없고 입력창 판독이 6초 내내 "글이 남음"으로 틀려 실패로 판정됐고, 실패 처리가
// 진행 중인 턴의 busy까지 껐다.
describe("Claude 작업 중 입력 제출 확인(#103)", () => {
  // 붙여넣은 뒤로는 입력창 판독이 계속 보낸 글이 남았다고 읽는 화면(대기열 표시 오판)을 흉내 낸다.
  const misreadingDraft = (output: string): string | null => output.trim() === "draft" ? "보낸 질문" : "";
  const enqueueLine = (content: string, at: number) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date(at).toISOString(), sessionId: "s", content });

  // 작업 중인 Claude 채팅과 기록 파일을 준비한다.
  function buildBusyClaude() {
    const built = buildManager("busy", "claude", misreadingDraft);
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-claude-queue-"));
    temporaryDirectories.push(historyDir);
    const historyFile = path.join(historyDir, "session.jsonl");
    fs.writeFileSync(historyFile, `${JSON.stringify({ type: "user", message: { content: "원래 질문" } })}\n`);
    built.adapter.hasQueuedPrompt = claudeQueuedPromptRecorded;
    built.database.prepare("UPDATE chats SET busy = 1, history_file = ? WHERE id = ?").run(historyFile, built.chatId);
    tmuxMocks.pastePromptToTmux.mockImplementation(() => built.setScreen("draft"));
    return { ...built, historyFile };
  }

  it("입력창 판독이 글이 남았다고 틀려도 JSONL 대기열 기록이 생기면 성공으로 보고 busy를 유지한다", async () => {
    const { database, manager, chatId, historyFile } = buildBusyClaude();
    tmuxMocks.sendTmuxEnter.mockImplementation(() => fs.appendFileSync(historyFile, `${enqueueLine("보낸 질문", Date.now())}\n`));

    const sending = manager.sendPrompt(chatId, "보낸 질문", null);
    await vi.advanceTimersByTimeAsync(1_500);
    await sending;

    expect(tmuxMocks.sendTmuxEnter).toHaveBeenCalledTimes(1);
    expect(tmuxMocks.sendTmuxBackspace).not.toHaveBeenCalled();
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("작업 중이던 채팅은 후속 입력 제출 확인이 끝내 실패해도 진행 중인 턴의 busy를 끄지 않는다", async () => {
    const { database, manager, chatId } = buildBusyClaude();
    const sending = manager.sendPrompt(chatId, "보낸 질문", null).then(() => null, (error: Error) => error);

    await vi.advanceTimersByTimeAsync(7_500);
    const error = await sending;

    expect(error?.message).toContain("Claude가 메시지 제출을 확인하지 못했습니다");
    expect(chatBusy(database, chatId)).toBe(1);
    database.close();
  });

  it("보낸 시각 이후·같은 내용의 enqueue만 인정하고 이전 기록·다른 내용·remove는 무시한다", () => {
    const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-claude-queue-"));
    temporaryDirectories.push(historyDir);
    const historyFile = path.join(historyDir, "session.jsonl");
    const sentAt = Date.parse("2026-09-11T05:54:54.400Z");
    fs.writeFileSync(historyFile, [
      "잘린 앞 조각",
      enqueueLine("보낸 질문", sentAt - 60_000),
      enqueueLine("다른 질문", sentAt + 300),
      JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: new Date(sentAt + 400).toISOString(), content: "보낸 질문" }),
    ].join("\n"));
    expect(claudeQueuedPromptRecorded(historyFile, "보낸 질문", sentAt)).toBe(false);

    fs.appendFileSync(historyFile, `\n${enqueueLine("보낸\n  질문", sentAt + 325)}\n`);
    expect(claudeQueuedPromptRecorded(historyFile, "보낸 질문", sentAt)).toBe(true);
    expect(claudeQueuedPromptRecorded(path.join(historyDir, "없는파일.jsonl"), "보낸 질문", sentAt)).toBe(false);
  });
});
