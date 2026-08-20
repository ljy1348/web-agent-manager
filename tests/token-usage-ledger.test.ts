import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { HistorySession } from "../src/server/providers/provider";
import { TokenUsageLedger, tokenUsageSnapshotForChat } from "../src/server/services/token-usage-ledger";

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

// 임시 DB에 프로젝트·채팅을 넣고 토큰 원장 테스트 구성을 만든다.
function createHarness(): { database: AppDatabase; ledger: TokenUsageLedger; chatId: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-token-ledger-"));
  const config = {
    rootDir: root, dataDir: root, homeDir: root, host: "127.0.0.1", port: 0,
    publicUrl: "http://127.0.0.1", allowedRoots: [root], sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  } as AppConfig;
  const database = openDatabase(config);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('원장 프로젝트', ?, 'manual')").run(path.join(root, "project"));
  const project = database.prepare("SELECT id FROM projects").get() as { id: number };
  const account = database.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number };
  const result = database.prepare(`
    INSERT INTO chats(project_id, provider, account_id, provider_session_id, tmux_name, status, title, model)
    VALUES (?, 'claude', ?, 'session-1', 'tmux-ledger', 'stopped', '원장 채팅', 'Sonnet 5')
  `).run(project.id, account.id);
  cleanup.push(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, ledger: new TokenUsageLedger(database), chatId: Number(result.lastInsertRowid) };
}

// 날짜가 다른 두 응답이 든 공통 세션 fixture를 만든다.
function usageSession(): HistorySession {
  return {
    provider: "claude", sessionId: "session-1", cwd: "/tmp/project", title: "원장 채팅",
    historyFile: "/tmp/session.jsonl", createdAt: "2026-08-10T14:00:00.000Z", updatedAt: "2026-08-11T16:00:00.000Z",
    messages: [
      { id: "a1", role: "assistant", kind: "text", content: "첫 답", createdAt: "2026-08-10T15:30:00.000Z", tokenUsage: {
        inputTokens: 100, cachedInputTokens: 0, cacheCreationInputTokens: 30, cacheReadInputTokens: 20,
        outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 160,
      } },
      { id: "a2", role: "assistant", kind: "text", content: "둘째 답", createdAt: "2026-08-11T16:00:00.000Z", tokenUsage: {
        inputTokens: 200, cachedInputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 50,
        outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 270,
      } },
    ],
  };
}

describe("영구 토큰 사용량 원장", () => {
  it("같은 메시지를 재동기화해도 중복하지 않고 프로젝트·채팅 합계를 만든다", () => {
    const { database, ledger, chatId } = createHarness();
    const snapshot = tokenUsageSnapshotForChat(database, chatId);
    expect(snapshot).not.toBeNull();
    ledger.recordSession(usageSession(), snapshot!);
    ledger.recordSession(usageSession(), snapshot!);

    const project = ledger.aggregate({ groupBy: "project", days: null, timezoneOffsetMinutes: 540 }) as any;
    expect(project.summary).toMatchObject({ messageCount: 2, chatCount: 1, projectCount: 1, totalTokens: 430, inputTokens: 300, outputTokens: 30 });
    expect(project.rows).toHaveLength(1);
    expect(project.rows[0]).toMatchObject({ label: "원장 프로젝트", totalTokens: 430, deleted: false });

    ledger.markChatDeleted(chatId);
    const chat = ledger.aggregate({ groupBy: "chat", days: null, timezoneOffsetMinutes: 540 }) as any;
    expect(chat.rows[0]).toMatchObject({ label: "원장 채팅", deleted: true, totalTokens: 430 });
  });

  it("브라우저 시간대 기준 일자와 조회 기간을 적용한다", () => {
    const { database, ledger, chatId } = createHarness();
    ledger.recordSession(usageSession(), tokenUsageSnapshotForChat(database, chatId)!);

    const days = ledger.aggregate({ groupBy: "day", days: null, timezoneOffsetMinutes: 540 }) as any;
    expect(days.rows.map((row: any) => row.key)).toEqual(["2026-08-12", "2026-08-11"]);

    const recent = ledger.aggregate({ groupBy: "provider", days: 1, timezoneOffsetMinutes: 540, now: new Date("2026-08-12T00:00:00.000Z") }) as any;
    expect(recent.summary).toMatchObject({ messageCount: 1, totalTokens: 270 });
  });

  it("Grok 공급자 집계 표시명을 Claude로 묶지 않는다", () => {
    const { database, ledger, chatId } = createHarness();
    const snapshot = tokenUsageSnapshotForChat(database, chatId)!;
    ledger.recordSession({
      ...usageSession(),
      provider: "grok",
      sessionId: "grok-session-1",
      model: "grok-4.6",
    }, snapshot);
    const grouped = ledger.aggregate({ groupBy: "provider", days: null, timezoneOffsetMinutes: 540 }) as any;
    expect(grouped.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "grok", label: "Grok", totalTokens: 430 }),
    ]));
  });
});
