import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { HistorySynchronizer } from "../src/server/services/history-sync";
import { HistoryCache } from "../src/server/services/history-cache";
import { ClaudeAdapter } from "../src/server/providers/claude";
import type { RealtimeHub } from "../src/server/services/realtime";
import type { Notifier } from "../src/server/services/notifier";

// history-sync가 제목을 자동으로 계속 업그레이드하되(공급자 쪽 더 나은 제목이 새로 생기면), 사람이
// SessionManager.renameSession으로 직접 바꾼 제목(title_source='manual')은 절대 덮어쓰지 않는지 확인한다.
// 실제로 aiTitle 우선순위를 CLI 표시 이름 우선으로 바꾼 뒤, 이미 이전 우선순위로 자동 채워진 제목이
// 새 우선순위를 못 따라가는 문제를 발견해 title_source 컬럼을 추가하게 됐다.

let cwdDir: string;
let projectDir: string;

function writeSessionFixture(sessionId: string, aiTitle: string | null): string {
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const record: Record<string, unknown> = {
    type: "user",
    sessionId,
    cwd: cwdDir,
    message: { content: "이 프로젝트 배포 스크립트 좀 손봐줘 아주 길게 쓴 첫 메시지입니다" },
    timestamp: "2026-07-06T00:00:00.000Z",
  };
  if (aiTitle) record.aiTitle = aiTitle;
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

function buildSynchronizer(config: AppConfig) {
  const database = openDatabase(config);
  const realtime = { broadcast: () => undefined } as unknown as RealtimeHub;
  const notifications: Notifier = { notify: async () => undefined };
  const adapter = new ClaudeAdapter("", {});
  // historyRoot는 보통 ~/.claude/projects 고정이라, 테스트에서는 실제 홈 디렉터리를 건드리지 않도록
  // 임시 프로젝트 디렉터리로 바꿔치기한다(런타임엔 TS readonly가 강제되지 않아 그대로 대입 가능).
  (adapter as { historyRoot: string }).historyRoot = projectDir;
  const sync = new HistorySynchronizer(config, database, [adapter], realtime, notifications, new HistoryCache());
  return { database, sync };
}

afterEach(() => {
  fs.rmSync(cwdDir, { recursive: true, force: true });
});

describe("history-sync 제목 자동 업그레이드와 수동 잠금", () => {
  it("아직 아무도 안 바꾼 제목은 새 aiTitle이 생기면 계속 업그레이드된다", () => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-cwd-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-proj-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-data-"));
    const config = { dataDir, allowedRoots: [cwdDir] } as unknown as AppConfig;
    const sessionId = "s1";
    const file = writeSessionFixture(sessionId, null);
    const { database, sync } = buildSynchronizer(config);

    sync.syncAll(false);
    const first = database.prepare("SELECT title, title_source FROM chats WHERE provider_session_id = ?").get(sessionId) as any;
    expect(first.title).toBe("이 프로젝트 배포 스크립트 좀 손봐줘 아주 길게 쓴 첫 메시지입니다");
    expect(first.title_source).toBeNull();

    // aiTitle이 새로 생기면(대화가 진행되며) 자동으로 그 값으로 업그레이드돼야 한다.
    fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId, cwd: cwdDir, message: { content: "이 프로젝트 배포 스크립트 좀 손봐줘 아주 길게 쓴 첫 메시지입니다" }, aiTitle: "배포 스크립트 개선", timestamp: "2026-07-06T00:00:01.000Z" }));
    sync.syncAll(false);
    const second = database.prepare("SELECT title FROM chats WHERE provider_session_id = ?").get(sessionId) as any;
    expect(second.title).toBe("배포 스크립트 개선");
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("title_source가 manual이면 더 나은 aiTitle이 새로 생겨도 절대 덮어쓰지 않는다", () => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-cwd-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-proj-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-data-"));
    const config = { dataDir, allowedRoots: [cwdDir] } as unknown as AppConfig;
    const sessionId = "s2";
    const file = writeSessionFixture(sessionId, "초기 자동 제목");
    const { database, sync } = buildSynchronizer(config);
    sync.syncAll(false);
    const chat = database.prepare("SELECT id FROM chats WHERE provider_session_id = ?").get(sessionId) as any;

    // renameSession이 하는 것과 동일하게 사람이 직접 이름을 바꾼 상태를 흉내낸다.
    database.prepare("UPDATE chats SET title = ?, title_source = 'manual' WHERE id = ?").run("내가 직접 지은 이름", chat.id);

    fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId, cwd: cwdDir, message: { content: "이 프로젝트 배포 스크립트 좀 손봐줘 아주 길게 쓴 첫 메시지입니다" }, aiTitle: "완전히 다른 더 나은 제목", timestamp: "2026-07-06T00:00:02.000Z" }));
    sync.syncAll(false);
    const after = database.prepare("SELECT title FROM chats WHERE id = ?").get(chat.id) as any;
    expect(after.title).toBe("내가 직접 지은 이름");
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Task 도구로 뜬 서브에이전트 기록(`<세션ID>/subagents/agent-*.jsonl`)은 자기 고유 ID 없이 부모
  // 세션의 sessionId를 그대로 들고 있어, 스캔 대상에 포함되면 persist()가 "같은 세션"으로 보고 부모
  // 채팅의 history_file·제목을 서브에이전트 내용으로 덮어써버린다(실사용 보고로 확인, 2026-07-24).
  it("서브에이전트 기록이 부모 세션의 history_file·제목을 덮어쓰지 않는다", () => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-cwd-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-proj-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-title-data-"));
    const config = { dataDir, allowedRoots: [cwdDir] } as unknown as AppConfig;
    const sessionId = "s3";
    const parentFile = writeSessionFixture(sessionId, "부모 세션 제목");
    const subagentDir = path.join(projectDir, sessionId, "subagents");
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentDir, "agent-abc123.jsonl"),
      JSON.stringify({ parentUuid: null, isSidechain: true, agentId: "abc123", type: "user", sessionId, cwd: cwdDir, message: { content: "서브에이전트 조사 프롬프트" }, timestamp: "2026-07-06T00:00:03.000Z" }),
    );
    const { database, sync } = buildSynchronizer(config);

    sync.syncAll(false);
    const chat = database.prepare("SELECT history_file, title FROM chats WHERE provider_session_id = ?").get(sessionId) as any;
    expect(chat.history_file).toBe(parentFile);
    expect(chat.title).toBe("부모 세션 제목");
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("외부에서 발견한 종료 채팅은 완료 레코드 없는 user 메시지만 있어도 busy로 만들지 않는다", () => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-stopped-cwd-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-stopped-proj-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-stopped-data-"));
    const config = { dataDir, allowedRoots: [cwdDir] } as unknown as AppConfig;
    const sessionId = "stopped-user-only";
    writeSessionFixture(sessionId, null);
    const { database, sync } = buildSynchronizer(config);

    sync.syncAll(false);
    const chat = database.prepare("SELECT status, busy FROM chats WHERE provider_session_id = ?").get(sessionId) as any;
    expect(chat).toEqual({ status: "stopped", busy: 0 });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
