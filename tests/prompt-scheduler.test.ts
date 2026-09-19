import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import type { ProviderAdapter } from "../src/server/providers/provider";
import type { Provider } from "../src/shared/types";
import { isScheduleDue, localScheduleStamp, PromptScheduler } from "../src/server/services/prompt-scheduler";

interface Fixture {
  root: string;
  database: AppDatabase;
  scheduler: PromptScheduler;
  sent: Array<{ chatId: number; text: string }>;
  started: number[];
  setNow(value: string): void;
}

const fixtures: Fixture[] = [];

function createFixture(nowValue = "2026-09-01T08:00:00.000Z"): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-prompt-scheduler-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config: AppConfig = {
    rootDir: root, homeDir: root, dataDir, projectsDir: root, allowedRoots: [root],
    host: "127.0.0.1", port: 0, publicUrl: "http://127.0.0.1", sessionTtlHours: 1,
    runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  };
  const database = openDatabase(config);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'hash', 'admin')").run();
  database.prepare("INSERT INTO projects(id, name, path) VALUES (1, '스터디', ?)").run(root);
  let now = new Date(nowValue);
  const sent: Fixture["sent"] = [];
  const started: number[] = [];
  const sessions = {
    start(chatId: number): void {
      started.push(chatId);
      database.prepare("UPDATE chats SET status = 'running', provider_session_id = COALESCE(provider_session_id, ?) WHERE id = ?").run(`session-${chatId}`, chatId);
    },
    async sendPrompt(chatId: number, text: string): Promise<string> {
      sent.push({ chatId, text });
      return text;
    },
  };
  const adapters = ["codex", "claude", "grok"].map((id) => ({ id, displayLabel: id }) as ProviderAdapter);
  const accounts = {
    requireForProvider(provider: Provider, accountId?: number | null): { id: number } {
      const row = accountId
        ? database.prepare("SELECT id, provider FROM agent_accounts WHERE id = ?").get(accountId) as { id: number; provider: Provider } | undefined
        : database.prepare("SELECT id, provider FROM agent_accounts WHERE provider = ? AND is_default = 1").get(provider) as { id: number; provider: Provider } | undefined;
      if (!row || row.provider !== provider) throw new Error("계정을 찾을 수 없습니다.");
      return { id: row.id };
    },
  };
  const scheduler = new PromptScheduler(database, sessions, adapters, accounts, () => now);
  const fixture = { root, database, scheduler, sent, started, setNow(value: string) { now = new Date(value); } };
  fixtures.push(fixture);
  return fixture;
}

function addChat(database: AppDatabase, provider: Provider = "claude"): number {
  const account = database.prepare("SELECT id FROM agent_accounts WHERE provider = ? AND is_default = 1").get(provider) as { id: number };
  const result = database.prepare(`
    INSERT INTO chats(project_id, provider, account_id, provider_session_id, tmux_name, status, title)
    VALUES (1, ?, ?, ?, ?, 'stopped', '매일 이어갈 채팅')
  `).run(provider, account.id, `existing-${provider}`, `existing-${provider}`);
  return Number(result.lastInsertRowid);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.scheduler.stop();
    fixture.database.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("영구 프롬프트 스케줄러", () => {
  it("시간대 현지 날짜와 시각을 안정적으로 계산한다", () => {
    expect(localScheduleStamp(new Date("2026-09-01T15:30:00.000Z"), "Asia/Seoul")).toEqual({ date: "2026-09-02", time: "00:30" });
    expect(() => localScheduleStamp(new Date(), "Not/A-Timezone")).toThrow("IANA 시간대");
  });

  it("정해진 시각에 새 채팅을 한 번만 만들어 프롬프트를 보낸다", async () => {
    const fixture = createFixture();
    const schedule = fixture.scheduler.create({
      name: "아침 스터디", projectId: 1, mode: "new_chat", provider: "codex",
      prompt: "오늘 공부할 내용을 정리해줘", dailyTime: "09:00", timezone: "UTC",
    }, 1);

    fixture.setNow("2026-09-01T09:00:00.000Z");
    await fixture.scheduler.tick();
    await fixture.scheduler.tick();

    expect(fixture.started).toHaveLength(1);
    expect(fixture.sent).toEqual([{ chatId: fixture.started[0], text: "오늘 공부할 내용을 정리해줘" }]);
    expect(fixture.database.prepare("SELECT title FROM chats WHERE id = ?").get(fixture.started[0])).toEqual({ title: "예약 · 아침 스터디" });
    expect(fixture.scheduler.list().find((item) => item.id === schedule.id)).toMatchObject({ last_status: "success", last_run_date: "2026-09-01" });
  });

  it("기존 채팅 방식은 새 채팅 없이 지정 채팅에 보내고 다음 날 다시 실행한다", async () => {
    const fixture = createFixture();
    const chatId = addChat(fixture.database);
    fixture.scheduler.create({
      name: "매일 회고", projectId: 1, mode: "existing_chat", chatId,
      prompt: "오늘 진행 상황을 회고해줘", dailyTime: "09:00", timezone: "UTC",
    }, 1);

    fixture.setNow("2026-09-01T09:05:00.000Z");
    await fixture.scheduler.tick();
    fixture.setNow("2026-09-02T09:05:00.000Z");
    await fixture.scheduler.tick();

    expect(fixture.started).toEqual([]);
    expect(fixture.sent).toEqual([
      { chatId, text: "오늘 진행 상황을 회고해줘" },
      { chatId, text: "오늘 진행 상황을 회고해줘" },
    ]);
  });

  it("이미 지난 오늘 시각으로 새 일정을 만들면 즉시 실행하지 않고 다음 날 실행한다", async () => {
    const fixture = createFixture("2026-09-01T10:00:00.000Z");
    fixture.scheduler.create({
      name: "늦게 만든 일정", projectId: 1, mode: "new_chat", provider: "grok",
      prompt: "상태 확인", dailyTime: "09:00", timezone: "UTC",
    }, 1);

    await fixture.scheduler.tick();
    expect(fixture.sent).toHaveLength(0);
    fixture.setNow("2026-09-02T09:00:00.000Z");
    await fixture.scheduler.tick();
    expect(fixture.sent).toHaveLength(1);
  });

  it("실행일 선점이 DB에 남아 스케줄러를 다시 만들어도 중복 실행하지 않는다", async () => {
    const fixture = createFixture();
    const chatId = addChat(fixture.database, "codex");
    fixture.scheduler.create({
      name: "중복 방지", projectId: 1, mode: "existing_chat", chatId,
      prompt: "한 번만", dailyTime: "09:00", timezone: "UTC",
    }, 1);
    fixture.setNow("2026-09-01T09:00:00.000Z");
    await fixture.scheduler.tick();

    const restarted = new PromptScheduler(fixture.database, {
      start() { throw new Error("새 채팅 생성 아님"); },
      async sendPrompt(id, text) { fixture.sent.push({ chatId: id, text }); return text; },
    }, [{ id: "codex", displayLabel: "Codex" } as ProviderAdapter], {
      requireForProvider() { throw new Error("기존 채팅에서는 계정 조회 안 함"); },
    }, () => new Date("2026-09-01T09:30:00.000Z"));
    await restarted.tick();

    expect(fixture.sent).toEqual([{ chatId, text: "한 번만" }]);
  });
});

describe("지정 날짜 1회 실행(#99)", () => {
  const oneShot = { name: "재확인", projectId: 1, mode: "new_chat" as const, provider: "claude" as const, prompt: "재확인해줘", dailyTime: "10:30", timezone: "Asia/Seoul", runDate: "2026-09-18" };

  it("지정 날짜의 시각에 한 번만 실행하고 예약을 끈다", async () => {
    const fixture = createFixture("2026-09-11T01:00:00.000Z"); // 서울 9/11 10:00
    const schedule = fixture.scheduler.create(oneShot, 1);

    fixture.setNow("2026-09-17T01:30:00.000Z"); // 전날 같은 시각
    await fixture.scheduler.tick();
    fixture.setNow("2026-09-18T01:29:00.000Z"); // 당일 10:29
    await fixture.scheduler.tick();
    expect(fixture.sent).toEqual([]);

    fixture.setNow("2026-09-18T01:30:00.000Z"); // 당일 10:30
    await fixture.scheduler.tick();
    fixture.setNow("2026-09-19T01:30:00.000Z"); // 다음 날
    await fixture.scheduler.tick();

    expect(fixture.sent).toEqual([{ chatId: fixture.started[0], text: "재확인해줘" }]);
    expect(fixture.scheduler.list().find((item) => item.id === schedule.id)).toMatchObject({ enabled: 0, run_date: "2026-09-18", last_status: "success", last_run_date: "2026-09-18" });
  });

  it("서버가 지정 날짜에 꺼져 있었다면 이후 첫 확인 때 한 번 실행한다", async () => {
    const fixture = createFixture("2026-09-11T01:00:00.000Z");
    fixture.scheduler.create(oneShot, 1);

    fixture.setNow("2026-09-20T00:00:00.000Z");
    await fixture.scheduler.tick();
    await fixture.scheduler.tick();

    expect(fixture.sent).toHaveLength(1);
  });

  it("지난 날짜·시각의 1회 예약은 즉시 실행 사고를 막기 위해 저장과 재활성화를 거부한다", () => {
    const fixture = createFixture("2026-09-18T01:31:00.000Z"); // 서울 9/18 10:31
    expect(() => fixture.scheduler.create(oneShot, 1)).toThrow("이미 지난 1회 실행 시각");
    expect(() => fixture.scheduler.create({ ...oneShot, runDate: "2026-09-17" }, 1)).toThrow("이미 지난 1회 실행 시각");
    // 꺼 둔 상태로는 저장할 수 있지만 다시 켤 수는 없다.
    const paused = fixture.scheduler.create({ ...oneShot, enabled: false }, 1);
    expect(() => fixture.scheduler.setEnabled(Number(paused.id), true, 1)).toThrow("이미 지난 1회 실행 시각");
    expect(() => fixture.scheduler.create({ ...oneShot, runDate: "2026-02-30" }, 1)).toThrow("YYYY-MM-DD");
  });

  it("1회 예약을 즉시 실행하면 그 한 번을 쓴 것으로 보고 끈다", async () => {
    const fixture = createFixture("2026-09-11T01:00:00.000Z");
    const schedule = fixture.scheduler.create(oneShot, 1);

    await fixture.scheduler.runNow(Number(schedule.id), 1);
    fixture.setNow("2026-09-18T01:30:00.000Z");
    await fixture.scheduler.tick();

    expect(fixture.sent).toHaveLength(1);
    expect(fixture.scheduler.list().find((item) => item.id === schedule.id)).toMatchObject({ enabled: 0 });
  });

  it("실행 판정은 1회 예약과 매일 예약을 구분한다", () => {
    const stamp = { date: "2026-09-18", time: "10:30" };
    expect(isScheduleDue({ daily_time: "10:30", run_date: "2026-09-18", last_run_date: null }, stamp)).toBe(true);
    expect(isScheduleDue({ daily_time: "10:30", run_date: "2026-09-18", last_run_date: "2026-09-18" }, stamp)).toBe(false);
    expect(isScheduleDue({ daily_time: "10:30", run_date: "2026-09-19", last_run_date: null }, stamp)).toBe(false);
    expect(isScheduleDue({ daily_time: "10:30", run_date: null, last_run_date: "2026-09-17" }, stamp)).toBe(true);
    expect(isScheduleDue({ daily_time: "10:31", run_date: null, last_run_date: null }, stamp)).toBe(false);
  });
});
