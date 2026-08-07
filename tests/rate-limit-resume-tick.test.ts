import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { RateLimitResumeService } from "../src/server/services/rate-limit-resume";
import type { SessionManager } from "../src/server/services/session-manager";
import type { Notifier } from "../src/server/services/notifier";
import type { RealtimeHub } from "../src/server/services/realtime";
import type { ProviderAdapter } from "../src/server/providers/provider";

// 실제 운영에서 재현된 버그: CLI가 예고한 "재개 예정 시각"이 지나면 실제 사용량을 다시 확인하지 않고
// 곧바로 "한도 해제됐다"고 알린 뒤 재개를 시도했다. Codex가 "03:02 리셋"을 예고했는데 그 시각이 된
// 순간 실제로 다시 조회한 사용량은 여전히 remaining 0%였다(2026-07-10 실사용 중 확인) — 예고 시각
// 자체가 부정확했던 것. 이 테스트는 그 상황을 그대로 재현해 재개하지 않는지 확인한다.

// 실제 터미널 생존 여부를 바꿔 자동 재개 서비스의 전송 경계를 재현한다.
function buildService(config: AppConfig, sendPrompt: () => Promise<void>, terminalActive = true) {
  const database = openDatabase(config);
  const sessions = {
    sendPromptIfRunning: async (chatId: number) => {
      const chat = database.prepare("SELECT status, busy FROM chats WHERE id = ?").get(chatId) as { status: string; busy: number } | undefined;
      if (!terminalActive || chat?.status !== "running" || chat.busy) return false;
      await sendPrompt();
      return true;
    },
  } as unknown as SessionManager;
  const notified: string[] = [];
  const notifications: Notifier = { notify: async (eventId) => { notified.push(eventId); } };
  const realtime = { broadcast: () => undefined } as unknown as RealtimeHub;
  const adapters = [{ id: "codex", displayLabel: "Codex" } as unknown as ProviderAdapter];
  const service = new RateLimitResumeService(database, sessions, notifications, realtime, adapters);
  return { database, service, notified };
}

describe("RateLimitResumeService.tick", () => {
  it("예정 재개 시각이 지나도 방금 재확인한 사용량이 여전히 한도에 걸려 있으면 재개하지 않는다", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-rate-tick-"));
    const config = { dataDir } as unknown as AppConfig;
    let resumed = false;
    const { database, service } = buildService(config, async () => { resumed = true; });

    database.prepare(`
      INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')
    `).run();
    const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
    database.prepare(`
      INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'tmux1', 'running', 'ui', 0)
    `).run(project.id);
    const chat = database.prepare("SELECT id FROM chats").get() as { id: number };

    const now = new Date();
    const staleResumeAfter = new Date(now.getTime() - 60_000).toISOString(); // 이미 지난 예정 시각
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider, resume_after) VALUES (?, 'codex', ?)").run(chat.id, staleResumeAfter);
    // 방금 재확인한 실제 사용량: 여전히 0% 남음, 다음 예정 리셋은 아직 안 지난 미래 시각(HH:MM, 타임존 없음 → 서버 로컬 시간).
    const futureLocal = new Date(now.getTime() + 5 * 60_000);
    const hh = String(futureLocal.getHours()).padStart(2, "0");
    const mm = String(futureLocal.getMinutes()).padStart(2, "0");
    database.prepare(`
      INSERT INTO usage_status(provider, account_id, monitor_status, data_status, used_percent, remaining_percent, reset_at)
      VALUES ('codex', (SELECT id FROM agent_accounts WHERE provider = 'codex' AND is_default = 1), 'ready', 'fresh', 100, 0, ?)
    `).run(`${hh}:${mm}`);

    await (service as unknown as { tick: () => Promise<void> }).tick();

    expect(resumed).toBe(false);
    const wait = database.prepare("SELECT resume_after FROM rate_limit_waits WHERE chat_id = ?").get(chat.id) as { resume_after: string } | undefined;
    expect(wait).toBeDefined();
    // 대기 시각이 usage_status의 새 reset_at으로 밀렸는지(=다음 폴링에서 그 시각 기준으로 재시도).
    expect(new Date(wait!.resume_after).getTime()).toBeGreaterThan(now.getTime());
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("실제 사용량이 회복됐으면(remaining >= 10%) 예정 시각이 지난 뒤 정상적으로 재개한다", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-rate-tick-"));
    const config = { dataDir } as unknown as AppConfig;
    let resumed = false;
    const { database, service } = buildService(config, async () => { resumed = true; });

    database.prepare(`INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')`).run();
    const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
    database.prepare(`INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'tmux1', 'running', 'ui', 0)`).run(project.id);
    const chat = database.prepare("SELECT id FROM chats").get() as { id: number };

    const now = new Date();
    const staleResumeAfter = new Date(now.getTime() - 60_000).toISOString();
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider, resume_after) VALUES (?, 'codex', ?)").run(chat.id, staleResumeAfter);
    database.prepare(`
      INSERT INTO usage_status(provider, account_id, monitor_status, data_status, used_percent, remaining_percent, reset_at)
      VALUES ('codex', (SELECT id FROM agent_accounts WHERE provider = 'codex' AND is_default = 1), 'ready', 'fresh', 20, 80, '23:59')
    `).run();

    await (service as unknown as { tick: () => Promise<void> }).tick();

    expect(resumed).toBe(true);
    const wait = database.prepare("SELECT * FROM rate_limit_waits WHERE chat_id = ?").get(chat.id);
    expect(wait).toBeUndefined();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("종료된 채팅은 대기 기록만 정리하고 자동 재개나 해제 알림을 보내지 않는다", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-rate-tick-"));
    const config = { dataDir } as unknown as AppConfig;
    let resumed = false;
    const { database, service, notified } = buildService(config, async () => { resumed = true; });

    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')").run();
    const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
    database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'tmux-stopped', 'stopped', 'ui', 0)").run(project.id);
    const chat = database.prepare("SELECT id FROM chats").get() as { id: number };
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider, resume_after) VALUES (?, 'codex', ?)").run(chat.id, new Date(Date.now() - 60_000).toISOString());
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, used_percent, remaining_percent, reset_at) VALUES ('codex', (SELECT id FROM agent_accounts WHERE provider = 'codex' AND is_default = 1), 'ready', 'fresh', 20, 80, '23:59')").run();

    await (service as unknown as { tick: () => Promise<void> }).tick();

    expect(resumed).toBe(false);
    expect(notified).toEqual([]);
    expect(database.prepare("SELECT * FROM rate_limit_waits WHERE chat_id = ?").get(chat.id)).toBeUndefined();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("DB가 running이어도 실제 관리 중인 터미널이 없으면 자동 시작하지 않는다", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-rate-tick-"));
    const config = { dataDir } as unknown as AppConfig;
    let resumed = false;
    const { database, service, notified } = buildService(config, async () => { resumed = true; }, false);

    database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')").run();
    const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
    database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', 'tmux-missing', 'running', 'ui', 0)").run(project.id);
    const chat = database.prepare("SELECT id FROM chats").get() as { id: number };
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider, resume_after) VALUES (?, 'codex', ?)").run(chat.id, new Date(Date.now() - 60_000).toISOString());
    database.prepare("INSERT INTO usage_status(provider, account_id, monitor_status, data_status, used_percent, remaining_percent, reset_at) VALUES ('codex', (SELECT id FROM agent_accounts WHERE provider = 'codex' AND is_default = 1), 'ready', 'fresh', 20, 80, '23:59')").run();

    await (service as unknown as { tick: () => Promise<void> }).tick();

    expect(resumed).toBe(false);
    expect(notified).toEqual([]);
    expect(database.prepare("SELECT * FROM rate_limit_waits WHERE chat_id = ?").get(chat.id)).toBeUndefined();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
