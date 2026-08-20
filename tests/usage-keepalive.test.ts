import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import type { ProviderAdapter } from "../src/server/providers/provider";
import { USAGE_KEEPALIVE_PROMPT } from "../src/shared/usage-keepalive";
import { openDatabase } from "../src/server/core/database";
import { UsageMonitor } from "../src/server/services/usage-monitor";

const temporaryDirectories: string[] = [];

// 실제 계정 테이블과 중복 기록을 쓰는 테스트용 UsageMonitor를 만든다.
function buildMonitor() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-keepalive-"));
  temporaryDirectories.push(dataDir);
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  const accountId = (database.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number }).id;
  const adapter = { id: "claude", isReady: () => true, isBusy: () => false } as unknown as ProviderAdapter;
  const monitor = new UsageMonitor(database, [adapter], { broadcast: vi.fn() } as never, {} as never);
  const state = { adapter, account: { id: accountId }, screen: { reset: vi.fn(), text: vi.fn(() => "ready") }, terminal: { write: vi.fn() } };
  return { database, monitor, state, accountId };
}

afterEach(() => {
  vi.useRealTimers();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("사용량 창 최소 턴 전송", () => {
  it("같은 계정의 같은 초기화 창 중복 전송을 DB 기록으로 막는다", async () => {
    const { database, monitor, state, accountId } = buildMonitor();
    const send = vi.fn(async () => undefined);
    (monitor as unknown as { sendUsageKeepalivePrompt: typeof send }).sendUsageKeepalivePrompt = send;
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status) VALUES ('claude', ?, 'ready', 'fresh')").run(accountId);

    const trigger = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]) };
    await (monitor as any).maybeSendUsageKeepalive(state, trigger);
    await (monitor as any).maybeSendUsageKeepalive(state, trigger);

    expect(send).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT reason FROM usage_keepalive_prompts WHERE provider = 'claude' AND account_id = ?").get(accountId)).toEqual({ reason: "claude_session_zero" });
    expect(monitor.list().find((row) => row.provider === "claude")).toMatchObject({
      keepalive_reason: "claude_session_zero",
      keepalive_sent_at: expect.any(String),
    });
    database.close();
  });

  it("초기화 창이 바뀌면 직전 전송 후 5시간 전이라도 즉시 전송한다", async () => {
    const { database, monitor, state } = buildMonitor();
    const send = vi.fn(async () => undefined);
    (monitor as unknown as { sendUsageKeepalivePrompt: typeof send }).sendUsageKeepalivePrompt = send;
    const first = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]) };
    const next = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T18:40:00.000Z" }]) };

    await (monitor as any).maybeSendUsageKeepalive(state, first);
    await (monitor as any).maybeSendUsageKeepalive(state, next);

    expect(send).toHaveBeenCalledTimes(2);
    expect(database.prepare("SELECT window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({ window_key: next.windowKey });
    database.close();
  });

  it("기존 전송 시각이 현재 Claude 창 안이면 창 키만 승계한다", async () => {
    const { database, monitor, state, accountId } = buildMonitor();
    const send = vi.fn(async () => undefined);
    (monitor as unknown as { sendUsageKeepalivePrompt: typeof send }).sendUsageKeepalivePrompt = send;
    database.prepare("INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at) VALUES ('claude', ?, 'claude_session_zero', ?)")
      .run(accountId, "2026-08-11T08:43:00.981Z");
    const trigger = { reason: "claude_session_zero", windowKey: JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]) };

    await (monitor as any).maybeSendUsageKeepalive(state, trigger);

    expect(send).not.toHaveBeenCalled();
    expect(database.prepare("SELECT window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({ window_key: trigger.windowKey });
    database.close();
  });

  it("새 창 전송이 실패하면 직전 창 기록을 복원한다", async () => {
    const { database, monitor, state, accountId } = buildMonitor();
    const previousKey = JSON.stringify([{ id: "session", resetAt: "2026-08-11T13:40:00.000Z" }]);
    const nextKey = JSON.stringify([{ id: "session", resetAt: "2026-08-11T18:40:00.000Z" }]);
    database.prepare("INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at, window_key) VALUES ('claude', ?, 'claude_session_zero', ?, ?)")
      .run(accountId, "2026-08-11T08:43:00.981Z", previousKey);
    (monitor as unknown as { sendUsageKeepalivePrompt: () => Promise<void> }).sendUsageKeepalivePrompt = vi.fn(async () => { throw new Error("전송 실패"); });

    await (monitor as any).maybeSendUsageKeepalive(state, { reason: "claude_session_missing", windowKey: nextKey });

    expect(database.prepare("SELECT reason, sent_at, window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({
      reason: "claude_session_zero",
      sent_at: "2026-08-11T08:43:00.981Z",
      window_key: previousKey,
    });
    database.close();
  });

  it("기존 DB의 최소 단답 행을 보존하며 창 키 컬럼을 추가한다", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-usage-keepalive-migration-"));
    temporaryDirectories.push(dataDir);
    const config = { dataDir } as unknown as AppConfig;
    const initial = openDatabase(config);
    const accountId = (initial.prepare("SELECT id FROM agent_accounts WHERE provider = 'claude' AND is_default = 1").get() as { id: number }).id;
    initial.prepare("INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at) VALUES ('claude', ?, 'claude_session_zero', ?)")
      .run(accountId, "2026-08-11T08:43:00.981Z");
    initial.close();
    const legacy = new Database(path.join(dataDir, "web-agent-manager.sqlite"));
    legacy.exec(`
      ALTER TABLE usage_keepalive_prompts RENAME TO usage_keepalive_prompts_new;
      CREATE TABLE usage_keepalive_prompts (
        provider TEXT NOT NULL,
        account_id INTEGER NOT NULL REFERENCES agent_accounts(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY(provider, account_id)
      );
      INSERT INTO usage_keepalive_prompts(provider, account_id, reason, sent_at)
      SELECT provider, account_id, reason, sent_at FROM usage_keepalive_prompts_new;
      DROP TABLE usage_keepalive_prompts_new;
    `);
    legacy.close();

    const migrated = openDatabase(config);

    expect(migrated.prepare("PRAGMA table_info(usage_keepalive_prompts)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "window_key" })]));
    expect(migrated.prepare("SELECT reason, sent_at, window_key FROM usage_keepalive_prompts WHERE provider = 'claude'").get()).toEqual({
      reason: "claude_session_zero",
      sent_at: "2026-08-11T08:43:00.981Z",
      window_key: null,
    });
    migrated.close();
  });

  it("누적 조회 세션 대신 새 PTY에 고정 프롬프트를 보내고 응답 뒤 폐기한다", async () => {
    vi.useFakeTimers();
    const { database, monitor, state } = buildMonitor();
    let receiveData: ((data: string) => void) | undefined;
    const freshTerminal = {
      write: vi.fn((value: string) => { if (value === "\r") receiveData?.("1\n$"); }),
      onData: vi.fn((callback: (data: string) => void) => { receiveData = callback; }),
      onExit: vi.fn(),
      kill: vi.fn(),
    };
    const spawn = vi.fn(() => freshTerminal);
    (monitor as any).spawnProviderTerminal = spawn;
    const sending = (monitor as any).sendUsageKeepalivePrompt(state);

    await vi.advanceTimersByTimeAsync(1_000);
    await sending;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(state.terminal.write).not.toHaveBeenCalled();
    expect(freshTerminal.write.mock.calls.map((call) => call[0])).toEqual([USAGE_KEEPALIVE_PROMPT, "\r"]);
    expect(freshTerminal.kill).toHaveBeenCalledTimes(1);
    database.close();
  });
});
