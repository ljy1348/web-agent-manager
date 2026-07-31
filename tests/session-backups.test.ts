import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { CodexAdapter } from "../src/server/providers/codex";
import { ClaudeAdapter } from "../src/server/providers/claude";
import { HistoryCache } from "../src/server/services/history-cache";
import { SessionBackupService } from "../src/server/services/session-backups";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 테스트용 앱 설정과 SQLite DB를 만든다.
function createHarness(): { config: AppConfig; database: AppDatabase; projectPath: string; dataDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-backup-"));
  const dataDir = path.join(root, "data");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    rootDir: root,
    homeDir: root,
    dataDir,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:0",
    allowedRoots: [root],
    sessionTtlHours: 1,
    runtimeEnabled: false,
    slack: {},
    ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'tester', 'hash', 'admin')").run();
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { config, database, projectPath, dataDir };
}

// 실제 파서를 쓰되 historyRoot만 테스트 폴더로 바꾼 어댑터를 만든다.
function testAdapter(base: CodexAdapter | ClaudeAdapter, historyRoot: string): ProviderAdapter {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "historyRoot") return historyRoot;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ProviderAdapter;
}

// 공급자별 세션 백업 서비스와 DB 레코드를 준비한다.
function prepareService(provider: "codex" | "claude") {
  const { config, database, projectPath } = createHarness();
  const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), `web-agent-manager-${provider}-history-`));
  cleanup.push(() => fs.rmSync(historyRoot, { recursive: true, force: true }));
  const adapter = provider === "codex" ? testAdapter(new CodexAdapter(), historyRoot) : testAdapter(new ClaudeAdapter("", {}), historyRoot);
  const historyCache = new HistoryCache();
  const service = new SessionBackupService(config, database, [adapter], historyCache);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('project', ?, 'manual')").run(projectPath);
  const project = database.prepare("SELECT id FROM projects WHERE path = ?").get(projectPath) as { id: number };
  return { database, projectPath, historyRoot, historyCache, service, projectId: project.id, adapter };
}

// Codex JSONL fixture를 작성한다.
function writeCodexHistory(historyRoot: string, cwd: string): string {
  const dir = path.join(historyRoot, "2026", "07", "07");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout.jsonl");
  const lines = [
    { type: "session_meta", payload: { id: "codex-session-1", cwd }, timestamp: "2026-07-07T00:00:00.000Z" },
    { type: "turn_context", payload: { model: "gpt-5.5", effort: "high" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "코덱스 백업 테스트" }] }, timestamp: "2026-07-07T00:00:01.000Z" },
    { type: "response_item", payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "복원 가능합니다." }] }, timestamp: "2026-07-07T00:00:02.000Z" },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

// Claude JSONL fixture를 작성한다.
function writeClaudeHistory(historyRoot: string, cwd: string): string {
  const dir = path.join(historyRoot, "project");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "claude-session-1.jsonl");
  const lines = [
    { type: "user", sessionId: "claude-session-1", cwd, message: { content: "클로드 백업 테스트" }, timestamp: "2026-07-07T00:00:00.000Z" },
    { type: "assistant", sessionId: "claude-session-1", cwd, message: { content: [{ type: "text", text: "복원 가능합니다." }], model: "claude-sonnet-5" }, timestamp: "2026-07-07T00:00:01.000Z" },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

// 채팅 DB 레코드를 생성한다.
function insertChat(database: AppDatabase, projectId: number, provider: "codex" | "claude", historyFile: string, sessionId: string): number {
  const result = database.prepare(`
    INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, history_file, model)
    VALUES (?, ?, ?, ?, 'stopped', ?, ?, ?)
  `).run(projectId, provider, sessionId, `tmux_${provider}`, `${provider} 세션`, historyFile, provider === "codex" ? "gpt-5.5 high" : "Sonnet 5");
  return Number(result.lastInsertRowid);
}

describe("세션 백업/삭제/복원", () => {
  it("Codex JSONL 세션을 백업하고 삭제한 뒤 복원한다", () => {
    const { database, projectPath, historyRoot, historyCache, service, projectId, adapter } = prepareService("codex");
    const historyFile = writeCodexHistory(historyRoot, projectPath);
    const chatId = insertChat(database, projectId, "codex", historyFile, "codex-session-1");

    const backup = service.backupChat(chatId, 1);
    expect(backup.provider).toBe("codex");
    expect(service.listProjectBackups(projectId)).toHaveLength(1);

    service.deleteChat(chatId, 1);
    expect(fs.existsSync(historyFile)).toBe(false);
    expect(database.prepare("SELECT id FROM chats WHERE id = ?").get(chatId)).toBeUndefined();

    const restored = service.restoreBackup(backup.id, 1);
    expect(restored.chat.provider).toBe("codex");
    expect(restored.chat.provider_session_id).toBe("codex-session-1");
    const restoredSession = historyCache.get(adapter, String(restored.chat.history_file));
    expect(restoredSession?.messages.map((message) => message.content)).toContain("코덱스 백업 테스트");
  });

  it("Claude JSONL 세션을 백업하고 삭제한 뒤 복원한다", () => {
    const { database, projectPath, historyRoot, historyCache, service, projectId, adapter } = prepareService("claude");
    const historyFile = writeClaudeHistory(historyRoot, projectPath);
    const chatId = insertChat(database, projectId, "claude", historyFile, "claude-session-1");

    const backup = service.backupChat(chatId, 1);
    expect(backup.provider).toBe("claude");
    expect(service.listProjectBackups(projectId)[0].chatExists).toBe(true);

    service.deleteChat(chatId, 1);
    expect(fs.existsSync(historyFile)).toBe(false);
    expect(database.prepare("SELECT id FROM chats WHERE id = ?").get(chatId)).toBeUndefined();

    const restored = service.restoreBackup(backup.id, 1);
    expect(restored.chat.provider).toBe("claude");
    expect(restored.chat.provider_session_id).toBe("claude-session-1");
    const restoredSession = historyCache.get(adapter, String(restored.chat.history_file));
    expect(restoredSession?.messages.map((message) => message.content)).toContain("클로드 백업 테스트");
  });

  it("백업 사본만 지우고 원본 채팅은 건드리지 않는다", () => {
    const { database, projectPath, historyRoot, service, projectId } = prepareService("codex");
    const historyFile = writeCodexHistory(historyRoot, projectPath);
    const chatId = insertChat(database, projectId, "codex", historyFile, "codex-session-1");

    const backup = service.backupChat(chatId, 1);
    expect(service.listProjectBackups(projectId)).toHaveLength(1);

    service.deleteBackup(backup.id, 1);
    expect(service.listProjectBackups(projectId)).toHaveLength(0);
    // 원본 채팅·JSONL은 그대로 남아 있어야 한다.
    expect(fs.existsSync(historyFile)).toBe(true);
    expect(database.prepare("SELECT id FROM chats WHERE id = ?").get(chatId)).toBeDefined();
  });

  it("존재하지 않는 백업을 지우려 하면 실패한다", () => {
    const { service } = prepareService("codex");
    expect(() => service.deleteBackup("codex-nope", 1)).toThrow("세션 백업을 찾을 수 없습니다.");
  });
});
