import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const ptySpawnMock = vi.hoisted(() => vi.fn());
let ptyExitCallback: ((event: { exitCode: number; signal?: number }) => void) | undefined;

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("node-pty", () => ({ spawn: ptySpawnMock }));

const { openDatabase } = await import("../src/server/core/database");
const { SessionManager } = await import("../src/server/services/session-manager");

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  ptySpawnMock.mockReset();
  ptyExitCallback = undefined;
  spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === "has-session") return { status: 1, stderr: "", stdout: "" };
    return { status: 0, stderr: "", stdout: "" };
  });
  ptySpawnMock.mockReturnValue({
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => { ptyExitCallback = callback; }),
  });
});

// 실제 tmux 없이 세션 ID 예약만 검증할 SessionManager와 채팅을 만든다.
function buildManager(provider: "grok" | "codex" | "claude", supportsNewSessionId: boolean, providerRollouts?: any) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-launch-id-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-launch-project-"));
  temporaryDirectories.push(dataDir, projectPath);
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', ?, 'discovered')").run(projectPath);
  const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectPath) as { id: number };
  const tmuxName = `wamfix_launch_${provider}_${process.pid}_${Date.now()}`;
  database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title) VALUES (?, ?, ?, 'stopped', 'ui')").run(project.id, provider, tmuxName);
  const chatId = (database.prepare("SELECT id FROM chats").get() as { id: number }).id;
  const createLaunch = vi.fn((_cwd: string, resumeSessionId?: string, newSessionId?: string, _profile?: unknown) => {
    const args: string[] = [];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    else if (newSessionId) args.push("--session-id", newSessionId);
    return { command: provider, args };
  });
  const adapter = {
    id: provider,
    displayLabel: provider,
    supportsNewSessionId: supportsNewSessionId || undefined,
    createLaunch,
    parseHistoryFile: (file: string) => {
      const [sessionId, prompt] = fs.readFileSync(file, "utf8").split("\n");
      return {
        provider,
        sessionId,
        cwd: projectPath,
        title: "저장 세션",
        historyFile: file,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: prompt ? [{ id: "user-1", role: "user", kind: "text", content: prompt, createdAt: new Date().toISOString() }] : [],
      };
    },
    detectModel: () => "test-model",
    isReady: () => false,
    isBusy: () => false,
    detectApproval: () => null,
  } as unknown as ProviderAdapter;
  const realtime = { setTerminalHandlers: () => undefined, broadcast: vi.fn(), terminal: vi.fn() };
  const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined, closeChatApprovals: vi.fn() };
  const notify = vi.fn().mockResolvedValue(undefined);
  const manager = new SessionManager(
    database,
    [adapter],
    realtime as never,
    approvals as never,
    { notify },
    { resolveForChat: () => ({ id: 1, config_dir: null }), environment: () => ({}) } as never,
    providerRollouts,
  );
  const setStoredHistory = (sessionId: string): string => {
    const file = path.join(projectPath, `${sessionId}.json`);
    fs.writeFileSync(file, `${sessionId}\n실제 질문`);
    database.prepare("UPDATE chats SET provider_session_id = ?, history_file = ? WHERE id = ?").run(sessionId, file, chatId);
    return file;
  };
  return { database, manager, chatId, createLaunch, tmuxName, notify, projectPath, setStoredHistory };
}

describe("SessionManager 새 세션 ID 예약", () => {
  it("세션 ID를 예약하는 공급자도 rollout 배정을 먼저 받고 후보 command로 실행한다", () => {
    let providerSessionAtAssignment: string | null | undefined;
    let databaseRef: any;
    let chatIdRef = 0;
    const rollouts = {
      assignNewChat: (_provider: string, chatId: number) => {
        providerSessionAtAssignment = (databaseRef.prepare("SELECT provider_session_id FROM chats WHERE id = ?").get(chatId) as any).provider_session_id;
      },
      resolveLaunch: (_chatId: number, _provider: string, launch: any) => ({ ...launch, command: "/candidate/grok" }),
      observeChatStatus: () => undefined,
    };
    const built = buildManager("grok", true, rollouts);
    databaseRef = built.database; chatIdRef = built.chatId;
    built.manager.start(chatIdRef, false);
    expect(providerSessionAtAssignment).toBeNull();
    const launchArgs = spawnSyncMock.mock.calls.find((call) => call[1]?.[0] === "new-session")?.[1] as string[];
    expect(launchArgs).toContain("/candidate/grok");
    built.manager.close();
  });

  it("Grok 새 채팅은 시작 전에 UUID를 저장하고 --session-id로 실행한다", () => {
    const { database, manager, chatId, createLaunch } = buildManager("grok", true);
    manager.start(chatId, false);
    const row = database.prepare("SELECT provider_session_id AS sessionId FROM chats WHERE id = ?").get(chatId) as { sessionId: string };
    expect(row.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(createLaunch).toHaveBeenCalledWith(expect.any(String), undefined, row.sessionId, undefined);
    const launchArgs = spawnSyncMock.mock.calls.find((call) => call[1]?.[0] === "new-session")?.[1] as string[];
    expect(launchArgs).toContain("--session-id");
    expect(launchArgs).toContain(row.sessionId);
    manager.close();
  });

  it("Codex 새 채팅은 세션 ID를 미리 정하지 않는다", () => {
    const { database, manager, chatId, createLaunch } = buildManager("codex", false);
    manager.start(chatId, false);
    const row = database.prepare("SELECT provider_session_id AS sessionId FROM chats WHERE id = ?").get(chatId) as { sessionId: string | null };
    expect(row.sessionId).toBeNull();
    expect(createLaunch).toHaveBeenCalledWith(expect.any(String), undefined, undefined, undefined);
    manager.close();
  });

  it("CLI 업데이트용 공급자 재시작은 실행 중 채팅을 종료한 뒤 같은 세션으로 재개한다", async () => {
    const { database, manager, chatId, createLaunch, setStoredHistory } = buildManager("codex", false);
    setStoredHistory("saved-session");
    manager.start(chatId, true);

    const result = await manager.restartProviderTerminals("codex", { id: null } as never);

    expect(result).toEqual({ restartedChatIds: [chatId], failures: [] });
    expect(createLaunch).toHaveBeenCalledTimes(2);
    expect(createLaunch).toHaveBeenLastCalledWith(expect.any(String), "saved-session", undefined, undefined);
    const status = database.prepare("SELECT status FROM chats WHERE id = ?").get(chatId) as { status: string };
    expect(status.status).toBe("running");
    manager.close();
  });

  it("오류 상태여도 실제 PTY가 붙은 채팅은 CLI 업데이트 재시작 대상이다", async () => {
    const { database, manager, chatId, createLaunch, setStoredHistory } = buildManager("codex", false);
    setStoredHistory("saved-session");
    manager.start(chatId, true);
    database.prepare("UPDATE chats SET status = 'error' WHERE id = ?").run(chatId);

    const result = await manager.restartProviderTerminals("codex", { id: null } as never);

    expect(result).toEqual({ restartedChatIds: [chatId], failures: [] });
    expect(createLaunch).toHaveBeenCalledTimes(2);
    expect(createLaunch).toHaveBeenLastCalledWith(expect.any(String), "saved-session", undefined, undefined);
    manager.close();
  });

  it("예상하지 못한 빈 터미널 종료는 채팅을 목록에서 제거하고 외부 알림은 보내지 않는다", async () => {
    const { database, manager, chatId, notify } = buildManager("codex", false);
    manager.start(chatId, false);

    ptyExitCallback?.({ exitCode: 1 });
    await Promise.resolve();

    expect(database.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    manager.close();
  });

  it("실제 사용자 대화 기록이 있는 터미널은 종료돼도 채팅을 보존한다", async () => {
    const { database, manager, chatId, setStoredHistory } = buildManager("codex", false);
    setStoredHistory("conversation-session");
    manager.start(chatId, true);

    ptyExitCallback?.({ exitCode: 0 });
    await Promise.resolve();

    expect(database.prepare("SELECT status FROM chats WHERE id = ?").get(chatId)).toEqual({ status: "stopped" });
    manager.close();
  });

  it("방금 제출한 질문 claim이 있으면 발견 주기 동안 빈 채팅 삭제를 유예한다", async () => {
    vi.useFakeTimers();
    const { database, manager, chatId } = buildManager("codex", false);
    database.prepare("INSERT INTO chat_history_claims(chat_id, prompt, created_at) VALUES (?, '질문', ?)").run(chatId, new Date().toISOString());
    manager.start(chatId, false);

    ptyExitCallback?.({ exitCode: 1 });
    await Promise.resolve();
    expect(database.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)).toBeDefined();

    await vi.advanceTimersByTimeAsync(35_001);
    expect(database.prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId)).toBeUndefined();
    manager.close();
    vi.useRealTimers();
  });

  it("채팅 CLI를 띄울 때 WEB_AGENT_MANAGER_CHAT_ID를 tmux 환경에 넣는다", () => {
    const { manager, chatId } = buildManager("codex", false);
    manager.start(chatId, false);
    const launchCall = spawnSyncMock.mock.calls.find((call) => call[1]?.[0] === "new-session") as
      | [string, string[], { env?: Record<string, string> }]
      | undefined;
    expect(launchCall?.[1]).toContain(`WEB_AGENT_MANAGER_CHAT_ID=${chatId}`);
    expect(launchCall?.[2]?.env).toMatchObject({ WEB_AGENT_MANAGER_CHAT_ID: String(chatId) });
    manager.close();
  });

  it("tmux 생성 실패 시 예약했던 세션 ID를 되돌린다", () => {
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "has-session") return { status: 1, stderr: "", stdout: "" };
      if (args[0] === "new-session") return { status: 1, stderr: "tmux failed", stdout: "" };
      return { status: 0, stderr: "", stdout: "" };
    });
    const { database, manager, chatId } = buildManager("grok", true);
    expect(() => manager.start(chatId, false)).toThrow(/tmux failed/);
    const row = database.prepare("SELECT provider_session_id AS sessionId FROM chats WHERE id = ?").get(chatId) as { sessionId: string | null };
    expect(row.sessionId).toBeNull();
    manager.close();
  });

  it("실제 기록 없는 예약 UUID는 resume하지 않고 새 세션 ID로 교체한다", () => {
    const { database, manager, chatId, createLaunch } = buildManager("claude", true);
    database.prepare("UPDATE chats SET provider_session_id = 'reserved-without-history' WHERE id = ?").run(chatId);

    manager.start(chatId, true);

    const row = database.prepare("SELECT provider_session_id AS sessionId, history_file AS historyFile FROM chats WHERE id = ?").get(chatId) as
      { sessionId: string; historyFile: string | null };
    expect(row.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(row.sessionId).not.toBe("reserved-without-history");
    expect(row.historyFile).toBeNull();
    expect(createLaunch).toHaveBeenCalledWith(expect.any(String), undefined, row.sessionId, undefined);
    manager.close();
  });

  it("pinned profile snapshot을 검증해 provider launch에 전달하고 resume에도 같은 경계를 유지한다", () => {
    const { database, manager, chatId, createLaunch, projectPath, setStoredHistory } = buildManager("codex", false);
    database.prepare("UPDATE chats SET preset_config_json=? WHERE id=?").run(JSON.stringify({
      taskKind: "implementation",
      runtime: { model: "profile-model", reasoningEffort: "high" },
      permissions: { sandbox: "workspace-write", approvalMode: "untrusted", additionalWritePaths: [] },
    }), chatId);
    setStoredHistory("profile-session");
    manager.start(chatId, true);
    expect(createLaunch).toHaveBeenCalledWith(projectPath, "profile-session", undefined, {
      sandbox: "workspace-write", approvalMode: "on-request", model: "profile-model", reasoningEffort: "high",
      additionalWritePaths: [], allowedTools: [], disallowedTools: [],
    });
    manager.close();
  });

  it("손상되거나 위험한 profile은 CLI를 띄우기 전에 채팅을 error로 차단한다", () => {
    const { database, manager, chatId, createLaunch } = buildManager("codex", false);
    database.prepare("UPDATE chats SET preset_config_json=? WHERE id=?").run(JSON.stringify({
      taskKind: "analysis", permissions: { sandbox: "danger-full-access", approvalMode: "never" },
    }), chatId);
    expect(() => manager.start(chatId, false)).toThrow("analysis profile");
    expect(createLaunch).not.toHaveBeenCalled();
    expect(database.prepare("SELECT status FROM chats WHERE id=?").get(chatId)).toEqual({ status: "error" });
    manager.close();
  });
});
