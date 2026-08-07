import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { HistorySynchronizer } from "../src/server/services/history-sync";
import { HistoryCache } from "../src/server/services/history-cache";
import { ApprovalService } from "../src/server/services/approval";
import { ClaudeAdapter } from "../src/server/providers/claude";
import type { RealtimeHub } from "../src/server/services/realtime";
import type { Notifier } from "../src/server/services/notifier";

// 계정 슬롯은 인증 파일을 백업·교체하는 대신 CLI가 공식 지원하는 설정 디렉터리 환경변수
// (Claude는 CLAUDE_CONFIG_DIR)로 나눈다. 그래서 계정마다 기록 루트도 갈라지고, 한 루트만 스캔하면
// 다른 계정에서 만든 채팅이 목록에 아예 안 나타난다 — 그 동작을 여기서 고정한다.

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function makeConfig(): AppConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-accounts-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, allowedRoots: ["/"], publicUrl: "http://127.0.0.1:4317" } as AppConfig;
}

function prepare(): { config: AppConfig; database: AppDatabase; accounts: AgentAccountService } {
  const config = makeConfig();
  const database = openDatabase(config);
  cleanup.push(() => database.close());
  return { config, database, accounts: new AgentAccountService(config, database) };
}

describe("계정 슬롯", () => {
  it("기본 계정은 환경변수를 주입하지 않아 기존 CLI 인증을 그대로 쓴다", () => {
    const { accounts } = prepare();
    const base = accounts.defaultAccount("claude");

    expect(base.is_default).toBe(1);
    expect(base.config_dir).toBeNull();
    expect(accounts.environment(base)).toEqual({});
  });

  it("추가 계정은 전용 설정 디렉터리를 만들고 그 경로를 환경변수로 넘긴다", () => {
    const { accounts } = prepare();
    const account = accounts.create("claude", "회사 계정");

    expect(account.config_dir).toBeTruthy();
    expect(fs.existsSync(account.config_dir!)).toBe(true);
    expect(accounts.environment(account)).toEqual({ CLAUDE_CONFIG_DIR: account.config_dir });
    expect(accounts.environment(accounts.create("codex", "회사 계정"))).toHaveProperty("CODEX_HOME");
  });

  it("기본 계정과 채팅이 남아 있는 계정은 삭제하지 않는다", () => {
    const { database, accounts } = prepare();
    const base = accounts.defaultAccount("claude");
    const extra = accounts.create("claude", "second");
    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'manual')").run();
    database.prepare(`
      INSERT INTO chats(project_id, provider, account_id, tmux_name, status, title)
      VALUES ((SELECT id FROM projects), 'claude', ?, 'tmux-1', 'stopped', '작업')
    `).run(extra.id);

    expect(() => accounts.remove(base.id, false)).toThrow("기본 계정은 삭제할 수 없습니다.");
    expect(() => accounts.remove(extra.id, false)).toThrow("채팅이 1개");
  });

  it("사용량 조회 범위 설정에 따라 조회 대상 계정이 달라진다", () => {
    const { accounts } = prepare();
    accounts.create("claude", "second");

    expect(accounts.usageScope()).toBe("default");
    expect(accounts.monitorTargets("claude")).toHaveLength(1);

    accounts.setUsageScope("all");
    expect(accounts.monitorTargets("claude")).toHaveLength(2);
  });
});

describe("계정별 기록 동기화", () => {
  it("계정마다 다른 기록 루트를 모두 스캔해 채팅을 그 계정에 귀속시킨다", () => {
    const { config, database, accounts } = prepare();
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-work-"));
    cleanup.push(() => fs.rmSync(cwdDir, { recursive: true, force: true }));
    const extra = accounts.create("claude", "second");
    const base = accounts.defaultAccount("claude");

    // 기본 계정 기록 루트는 실제 홈(~/.claude/projects)이라 테스트에서는 임시 폴더로 바꿔치기한다.
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-base-history-"));
    cleanup.push(() => fs.rmSync(baseRoot, { recursive: true, force: true }));
    const adapter = new ClaudeAdapter("", {});
    (adapter as { historyRoot: string }).historyRoot = baseRoot;

    const write = (root: string, sessionId: string): void => {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, `${sessionId}.jsonl`), JSON.stringify({
        type: "user",
        sessionId,
        cwd: cwdDir,
        message: { content: `${sessionId} 세션의 첫 메시지` },
        timestamp: "2026-08-07T00:00:00.000Z",
      }));
    };
    write(baseRoot, "session-base");
    write(adapter.historyRootFor(extra.config_dir), "session-extra");

    const realtime = { broadcast: () => undefined } as unknown as RealtimeHub;
    const notifications: Notifier = { notify: async () => undefined };
    const approvals = new ApprovalService(config, database, realtime, notifications);
    const sync = new HistorySynchronizer(config, database, [adapter], realtime, notifications, new HistoryCache(), approvals, accounts);

    sync.syncAll(false);

    const rows = database.prepare("SELECT provider_session_id AS sessionId, account_id AS accountId FROM chats ORDER BY provider_session_id").all() as Array<{ sessionId: string; accountId: number }>;
    expect(rows).toEqual([
      { sessionId: "session-base", accountId: base.id },
      { sessionId: "session-extra", accountId: extra.id },
    ]);
  });
});
