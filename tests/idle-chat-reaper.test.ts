import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { IdleChatReaper } from "../src/server/services/idle-chat-reaper";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const cleanup: string[] = [];

// 실제 스키마가 적용된 임시 데이터베이스를 연다.
function createDatabase(): AppDatabase {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-idle-"));
  cleanup.push(dataDir);
  return openDatabase({
    rootDir: dataDir, dataDir, homeDir: dataDir, host: "127.0.0.1", port: 0, publicUrl: "",
    allowedRoots: ["/"], sessionTtlHours: 1, runtimeEnabled: false, slack: {}, ntfy: { serverUrl: "https://ntfy.sh" },
  });
}

// 프로젝트 하나와 지정한 상태의 채팅을 만든다.
function seedChat(database: AppDatabase, options: {
  hoursIdle: number;
  status?: string;
  busy?: number;
  historyFile?: string | null;
  updatedAtLiteral?: string;
}): number {
  const projectRow = database.prepare("SELECT id FROM projects WHERE path = '/tmp/idle-test'").get() as { id: number } | undefined;
  const projectId = projectRow?.id ?? Number(database.prepare("INSERT INTO projects(name, path) VALUES ('테스트', '/tmp/idle-test')").run().lastInsertRowid);
  const updatedAt = options.updatedAtLiteral ?? new Date(NOW - options.hoursIdle * HOUR).toISOString();
  const result = database.prepare(`
    INSERT INTO chats(project_id, provider, tmux_name, status, title, busy, history_file, updated_at)
    VALUES (?, 'claude', ?, ?, '테스트 채팅', ?, ?, ?)
  `).run(
    projectId,
    `tmux_${Math.random().toString(36).slice(2)}`,
    options.status ?? "running",
    options.busy ?? 0,
    options.historyFile ?? null,
    updatedAt,
  );
  return Number(result.lastInsertRowid);
}

// 종료 호출을 기록하는 reaper를 만든다.
function createReaper(database: AppDatabase): { reaper: IdleChatReaper; stopped: number[] } {
  const stopped: number[] = [];
  const reaper = new IdleChatReaper(database, async (chatId) => { stopped.push(chatId); }, () => NOW);
  return { reaper, stopped };
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("유휴 채팅 자동 종료", () => {
  it("기준 시간을 넘긴 실행 중 채팅만 종료한다", async () => {
    const database = createDatabase();
    const idle = seedChat(database, { hoursIdle: 30 });
    seedChat(database, { hoursIdle: 3 });
    const { reaper, stopped } = createReaper(database);

    expect(await reaper.sweep()).toBe(1);
    expect(stopped).toEqual([idle]);
    database.close();
  });

  it("작업 중·리밋 대기·승인 대기 채팅은 아무리 오래됐어도 종료하지 않는다", async () => {
    const database = createDatabase();
    seedChat(database, { hoursIdle: 100, busy: 1 });
    const waiting = seedChat(database, { hoursIdle: 100 });
    database.prepare("INSERT INTO rate_limit_waits(chat_id, provider) VALUES (?, 'claude')").run(waiting);
    const approving = seedChat(database, { hoursIdle: 100 });
    database.prepare(`
      INSERT INTO approvals(id, chat_id, provider, request_type, request_payload, status)
      VALUES ('a1', ?, 'claude', 'permission', '{}', 'pending')
    `).run(approving);
    const { reaper, stopped } = createReaper(database);

    expect(await reaper.sweep()).toBe(0);
    expect(stopped).toEqual([]);
    database.close();
  });

  it("이미 멈춘 채팅과 시작·종료 진행 중인 채팅은 대상에서 뺀다", async () => {
    const database = createDatabase();
    for (const status of ["stopped", "starting", "resuming", "stopping", "error"]) {
      seedChat(database, { hoursIdle: 100, status });
    }
    const { reaper, stopped } = createReaper(database);

    expect(await reaper.sweep()).toBe(0);
    expect(stopped).toEqual([]);
    database.close();
  });

  it("DB 시각이 오래됐어도 기록 파일이 최근이면 살아 있는 것으로 본다", async () => {
    const database = createDatabase();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-idle-file-"));
    cleanup.push(dataDir);
    const historyFile = path.join(dataDir, "session.jsonl");
    fs.writeFileSync(historyFile, "{}\n");
    const recent = new Date(NOW - HOUR);
    fs.utimesSync(historyFile, recent, recent);
    seedChat(database, { hoursIdle: 100, historyFile });
    const { reaper, stopped } = createReaper(database);

    expect(await reaper.sweep()).toBe(0);
    expect(stopped).toEqual([]);
    database.close();
  });

  it("서버 재시작으로 DB 시각만 새로 찍혀도 기록 파일이 오래됐으면 종료한다", async () => {
    // 재시작 시 restore()가 setStatus로 updated_at을 현재 시각으로 덮어쓴다. 그 값을 활동으로 인정하면
    // 재시작을 반복하는 동안 자동 종료가 영영 발동하지 않아, 실제 대화가 기록되는 JSONL을 기준으로 본다.
    const database = createDatabase();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-idle-restart-"));
    cleanup.push(dataDir);
    const historyFile = path.join(dataDir, "session.jsonl");
    fs.writeFileSync(historyFile, "{}\n");
    const old = new Date(NOW - 30 * HOUR);
    fs.utimesSync(historyFile, old, old);
    const chatId = seedChat(database, { hoursIdle: 0, historyFile });
    const { reaper, stopped } = createReaper(database);

    expect(await reaper.sweep()).toBe(1);
    expect(stopped).toEqual([chatId]);
    database.close();
  });

  it("SQLite CURRENT_TIMESTAMP 형식(UTC)도 시간대 오차 없이 해석한다", async () => {
    const database = createDatabase();
    // 30시간 전을 SQLite 기본 형식으로 저장한다. UTC로 해석해야만 기준 시간을 넘긴 것으로 판정된다.
    const literal = new Date(NOW - 30 * HOUR).toISOString().replace("T", " ").slice(0, 19);
    const idle = seedChat(database, { hoursIdle: 0, updatedAtLiteral: literal });
    const { reaper, stopped } = createReaper(database);

    expect(await reaper.sweep()).toBe(1);
    expect(stopped).toEqual([idle]);
    database.close();
  });

  it("정책을 끄면 아무 것도 종료하지 않는다", async () => {
    const database = createDatabase();
    seedChat(database, { hoursIdle: 100 });
    const { reaper, stopped } = createReaper(database);
    reaper.updateSettings(false, 24);

    expect(await reaper.sweep()).toBe(0);
    expect(stopped).toEqual([]);
    database.close();
  });

  it("저장한 기준 시간을 적용하고 허용 범위를 벗어난 값은 거부한다", async () => {
    const database = createDatabase();
    seedChat(database, { hoursIdle: 5 });
    const { reaper, stopped } = createReaper(database);

    expect(reaper.settings()).toEqual({ enabled: true, timeoutHours: 24 });
    reaper.updateSettings(true, 3);
    expect(await reaper.sweep()).toBe(1);
    expect(stopped.length).toBe(1);
    expect(() => reaper.updateSettings(true, 0)).toThrow("기준 시간");
    expect(() => reaper.updateSettings(true, 100_000)).toThrow("기준 시간");
    database.close();
  });

  it("한 채팅 종료가 실패해도 나머지는 계속 정리한다", async () => {
    const database = createDatabase();
    const failing = seedChat(database, { hoursIdle: 40 });
    const ok = seedChat(database, { hoursIdle: 40 });
    const stopped: number[] = [];
    const reaper = new IdleChatReaper(database, async (chatId) => {
      if (chatId === failing) throw new Error("tmux 종료 실패");
      stopped.push(chatId);
    }, () => NOW);

    expect(await reaper.sweep()).toBe(1);
    expect(stopped).toEqual([ok]);
    database.close();
  });

  it("종료한 채팅을 감사 로그에 시스템 주체로 남긴다", async () => {
    const database = createDatabase();
    const idle = seedChat(database, { hoursIdle: 40 });
    const { reaper } = createReaper(database);

    await reaper.sweep();

    const log = database.prepare("SELECT user_id AS userId, action, target_id AS targetId FROM audit_logs WHERE action = 'chat.idle_auto_stop'").get() as { userId: number | null; action: string; targetId: string };
    expect(log).toMatchObject({ userId: null, action: "chat.idle_auto_stop", targetId: String(idle) });
    database.close();
  });
});
