import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/core/database";
import type { AppConfig } from "../src/server/core/config";
import { SessionManager } from "../src/server/services/session-manager";
import { exactTmuxTarget } from "../src/server/services/tmux-input";

const createdSessions: string[] = [];

// 이 테스트가 만든 tmux 세션만 정확 이름으로 지운다.
function killOwnSession(name: string): void {
  spawnSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
}

afterEach(() => {
  for (const name of createdSessions.splice(0)) killOwnSession(name);
});

// prefix 충돌을 재현할 고유 세션 이름 쌍을 만든다.
function uniquePair(shortId: string, longId: string): { shortName: string; longName: string } {
  const stamp = `wamfix_exact_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return { shortName: `${stamp}_chat_${shortId}`, longName: `${stamp}_chat_${longId}` };
}

// 실제 터미널 없이 stop()만 호출할 SessionManager와 채팅을 구성한다.
function buildManager(tmuxName: string): { dataDir: string; database: ReturnType<typeof openDatabase>; manager: SessionManager; chatId: number } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-tmux-exact-"));
  const database = openDatabase({ dataDir } as unknown as AppConfig);
  database.prepare("INSERT INTO projects(name, path, source) VALUES ('p', '/tmp/p', 'discovered')").run();
  const project = database.prepare("SELECT id FROM projects WHERE path = '/tmp/p'").get() as { id: number };
  database.prepare("INSERT INTO chats(project_id, provider, tmux_name, status, title, busy) VALUES (?, 'codex', ?, 'running', 'ui', 0)").run(project.id, tmuxName);
  const chatId = (database.prepare("SELECT id FROM chats").get() as { id: number }).id;
  const realtime = { setTerminalHandlers: () => undefined, broadcast: () => undefined };
  const approvals = { setTerminalDecisionHandler: () => undefined, setTerminalLiveCheckHandler: () => undefined };
  const manager = new SessionManager(database, [], realtime as never, approvals as never, { notify: async () => undefined }, { resolveForChat: () => ({ id: 1, config_dir: null }), environment: () => ({}) } as never);
  return { dataDir, database, manager, chatId };
}

describe("tmux 세션 정확 이름 매칭", () => {
  it("10만 있을 때 1을 종료해도 10이 남는다", async () => {
    const { shortName, longName } = uniquePair("1", "10");
    const created = spawnSync("tmux", ["new-session", "-d", "-s", longName, "--", "sleep", "60"], { encoding: "utf8" });
    expect(created.status, created.stderr).toBe(0);
    createdSessions.push(longName);

    // prefix 매칭이면 없는 chat_1이 chat_10으로 잡힌다. 이 가정이 깨지면 회귀 테스트 자체가 무의미하다.
    expect(spawnSync("tmux", ["has-session", "-t", shortName], { stdio: "ignore" }).status).toBe(0);

    const { dataDir, database, manager, chatId } = buildManager(shortName);
    await manager.stop(chatId, { id: null } as never);

    expect(spawnSync("tmux", ["has-session", "-t", `=${longName}`], { stdio: "ignore" }).status).toBe(0);
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("판 대상 표기가 실제 tmux에서 해석되고 prefix가 다른 세션을 치지 않는다", () => {
    // 목만으로 검증하면 문자열 모양만 맞고 실제 tmux가 거부하는 형태를 놓친다. 실제로
    // `=이름`은 판 대상에서 can't find pane으로 실패해 새 채팅 생성이 통째로 깨졌다.
    const { shortName, longName } = uniquePair("1", "10");
    const created = spawnSync("tmux", ["new-session", "-d", "-s", longName, "--", "sleep", "60"], { encoding: "utf8" });
    expect(created.status, created.stderr).toBe(0);
    createdSessions.push(longName);

    const capture = spawnSync("tmux", ["capture-pane", "-p", "-t", exactTmuxTarget(longName)], { encoding: "utf8" });
    expect(capture.status, capture.stderr).toBe(0);

    // 존재하지 않는 chat_1을 노리면 chat_10이 잡히면 안 된다.
    expect(spawnSync("tmux", ["capture-pane", "-p", "-t", exactTmuxTarget(shortName)], { encoding: "utf8" }).status).not.toBe(0);
  });
});
