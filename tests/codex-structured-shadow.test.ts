import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase, type AppDatabase } from "../src/server/core/database";
import { AgentAccountService } from "../src/server/services/agent-accounts";
import { CodexStructuredShadowService, codexThreadStatusForTest, codexTurnListParamsForTest, codexTurnPageForTest } from "../src/server/services/codex-structured-shadow";

const temporaryDirectories: string[] = [];

function fixture(busy = false): { database: AppDatabase; accounts: AgentAccountService; chatId: number } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wam-codex-shadow-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "wam-codex-shadow-project-"));
  temporaryDirectories.push(dataDir, projectPath);
  const config = { dataDir, homeDir: os.homedir() } as AppConfig;
  const database = openDatabase(config);
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(projectPath).lastInsertRowid);
  const chatId = Number(database.prepare(`
    INSERT INTO chats(project_id, provider, provider_session_id, tmux_name, status, title, busy)
    VALUES (?, 'codex', 'thread-1', 'shadow-chat', 'running', 'chat', ?)
  `).run(projectId, Number(busy)).lastInsertRowid);
  return { database, accounts: new AgentAccountService(config, database), chatId };
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("Codex structured shadow", () => {
  it("현재 app-server thread status 계약을 busy 비교값으로 제한해 해석한다", () => {
    expect(codexThreadStatusForTest({ thread: { status: { type: "active", activeFlags: ["waitingOnApproval"] } } })).toEqual({ status: "active", busy: true });
    expect(codexThreadStatusForTest({ thread: { status: { type: "idle" } } })).toEqual({ status: "idle", busy: false });
    expect(codexThreadStatusForTest({ thread: { status: { type: "notLoaded" } } })).toEqual({ status: "notLoaded", busy: null });
    expect(codexThreadStatusForTest({})).toEqual({ status: "unknown", busy: null });
    expect(codexTurnListParamsForTest("thread-1")).toEqual({ threadId: "thread-1", limit: 100, sortDirection: "desc", itemsView: "notLoaded" });
  });

  it("thread status와 본문 없는 turn lifecycle만 원장에 저장하고 재관측을 중복하지 않는다", async () => {
    const { database, accounts, chatId } = fixture(false);
    const calls: Array<{ threadId: string; timeoutMs: number }> = [];
    const service = new CodexStructuredShadowService(database, accounts, true, async (_environment, threadId, timeoutMs) => {
      calls.push({ threadId, timeoutMs });
      return {
        thread: { id: threadId, status: { type: "idle" } },
        turns: [{ id: "turn-1", status: "completed", startedAt: 1_700_000_000, completedAt: 1_700_000_002, durationMs: 2_000,
          items: [{ type: "agentMessage", text: "must-not-persist" }], error: { message: "must-not-persist" } }],
      };
    });

    const observation = await service.probeChat(chatId);
    await service.probeChat(chatId);

    expect(calls).toEqual([{ threadId: "thread-1", timeoutMs: 5_000 }, { threadId: "thread-1", timeoutMs: 5_000 }]);
    expect(observation).toMatchObject({ chatId, structuredStatus: "idle", structuredBusy: false, tuiBusy: false, comparison: "match", errorCode: null });
    expect(database.prepare("SELECT turn_id, event_type, source_at, duration_ms FROM provider_shadow_turn_events ORDER BY event_type DESC").all()).toEqual([
      { turn_id: "turn-1", event_type: "started", source_at: "2023-11-14T22:13:20.000Z", duration_ms: null },
      { turn_id: "turn-1", event_type: "completed", source_at: "2023-11-14T22:13:22.000Z", duration_ms: 2_000 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM provider_shadow_turn_scans").get()).toEqual({ count: 2 });
    expect(JSON.stringify(database.prepare("SELECT * FROM provider_shadow_turn_events").all()) + JSON.stringify(database.prepare("SELECT * FROM provider_shadow_turn_scans").all())).not.toContain("must-not-persist");
    expect(service.snapshot()).toMatchObject({ enabled: true, mode: "read_only_shadow", summary: { match: 2 }, latest: expect.arrayContaining([expect.objectContaining({ chatId, comparison: "match" })]),
      readiness: { scope: "thread_status_and_turn_history", candidateEligible: false, transitionEligible: false, transitionBlockers: expect.arrayContaining(["thread_status_shadow_not_ready", "turn_history_shadow_not_ready", "interactive_transport_candidate_flag_required"]),
        turnHistory: { metrics: { scans: 2, startedTurns: 1, terminalTurns: 1, pairedTurns: 1, missingPairs: 0, invalidTurns: 0 } } } });
    database.close();
  });

  it("잘못된 turn metadata와 terminal 역행을 본문 없이 보수적으로 차단한다", async () => {
    expect(codexTurnPageForTest({ turns: [
      { id: "missing-start", status: "completed", completedAt: 10, items: [{ text: "private" }] },
      { id: "bad-status", status: "queued", startedAt: 10 },
      { id: "reversed", status: "failed", startedAt: 20, completedAt: 10 },
    ] })).toMatchObject({ turns: [], invalidTurns: 3, issues: ["turn_started_at_missing", "turn_status_invalid", "turn_time_reversed"] });
    const { database, accounts, chatId } = fixture(false);
    let completed = true;
    const service = new CodexStructuredShadowService(database, accounts, true, async () => ({
      thread: { status: { type: "idle" } },
      turns: [{ id: "turn-regression", status: completed ? "completed" : "inProgress", startedAt: 100, completedAt: completed ? 101 : null }],
    }));
    await service.probeChat(chatId); completed = false; await service.probeChat(chatId);
    expect(database.prepare("SELECT invalid_turns, issues_json FROM provider_shadow_turn_scans ORDER BY rowid DESC LIMIT 1").get()).toEqual({ invalid_turns: 1, issues_json: "[\"turn_terminal_regression\"]" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM provider_shadow_turn_events").get()).toEqual({ count: 2 });
    expect((service.snapshot() as any).readiness.turnHistory).toMatchObject({ status: "not_ready", reasons: expect.arrayContaining(["turn_metadata_invalid"]) });
    database.close();
  });

  it("불일치와 오류를 메시지 원문 없이 관측하며 비활성 flag에서는 프로세스를 호출하지 않는다", async () => {
    const mismatch = fixture(false);
    const service = new CodexStructuredShadowService(mismatch.database, mismatch.accounts, true, async () => ({ thread: { status: { type: "active" } } }));
    await expect(service.probeChat(mismatch.chatId)).resolves.toMatchObject({ comparison: "mismatch" });
    mismatch.database.close();

    const disabled = fixture(false);
    let called = false;
    const off = new CodexStructuredShadowService(disabled.database, disabled.accounts, false, async () => { called = true; return {}; });
    await expect(off.probeChat(disabled.chatId)).rejects.toMatchObject({ statusCode: 409 });
    expect(await off.probeActiveChats()).toBe(0);
    expect(called).toBe(false);
    disabled.database.close();
  });

  it("실제 running 상태의 Codex 채팅을 주기 관찰 대상으로 선택한다", async () => {
    const { database, accounts } = fixture(false);
    let calls = 0;
    const service = new CodexStructuredShadowService(database, accounts, true, async () => {
      calls += 1;
      return { thread: { status: { type: "idle" } }, turns: [] };
    });
    await expect(service.probeActiveChats()).resolves.toBe(1);
    expect(calls).toBe(1);
    database.close();
  });

  it("7일 thread·turn-history gate와 명시적 candidate flag를 모두 충족해야 전환 후보를 연다", () => {
    const { database, accounts, chatId } = fixture(false);
    const insert = database.prepare(`INSERT INTO provider_shadow_observations(
      id,provider,chat_id,session_id,structured_status,structured_busy,tui_status,tui_busy,comparison,latency_ms,observed_at
    ) VALUES (?, 'codex', ?, 'thread-1', ?, ?, 'running', ?, 'match', ?, ?)`);
    for (let index = 0; index < 105; index += 1) {
      const busy = index % 2; const observedAt = new Date(Date.now() - (index % 7) * 24 * 60 * 60_000).toISOString();
      insert.run(`obs-${index}`, chatId, busy ? "active" : "idle", busy, busy, 20 + index, observedAt);
      database.prepare(`INSERT INTO provider_shadow_turn_scans(id,provider,chat_id,session_id,turns_seen,started_seen,terminal_seen,paired_seen,invalid_turns,latency_ms,observed_at)
        VALUES (?, 'codex', ?, 'thread-1', 10, 10, 10, 10, 0, ?, ?)`).run(`scan-${index}`, chatId, 30 + index, observedAt);
    }
    for (let index = 0; index < 10; index += 1) {
      const observedAt = new Date(Date.now() - (index % 7) * 24 * 60 * 60_000).toISOString();
      database.prepare(`INSERT INTO provider_shadow_turn_events(id,provider,chat_id,session_id,turn_id,event_type,source_at,observed_at)
        VALUES (?, 'codex', ?, 'thread-1', ?, 'started', ?, ?)`).run(`start-${index}`, chatId, `turn-${index}`, observedAt, observedAt);
      database.prepare(`INSERT INTO provider_shadow_turn_events(id,provider,chat_id,session_id,turn_id,event_type,source_at,observed_at)
        VALUES (?, 'codex', ?, 'thread-1', ?, 'completed', ?, ?)`).run(`end-${index}`, chatId, `turn-${index}`, observedAt, observedAt);
    }
    const service = new CodexStructuredShadowService(database, accounts, true, undefined, undefined, undefined, true, "cohort-2026-09", 2);
    const started = performance.now(); const readiness = (service.snapshot() as any).readiness; expect(performance.now() - started).toBeLessThan(500);
    expect(readiness).toMatchObject({ scope: "thread_status_and_turn_history", status: "ready", reasons: [], candidateEligible: true, candidateBlockers: [], transitionEligible: true, transitionBlockers: [], interactiveCandidateEnabled: true, interactiveCandidateCohort: "cohort-2026-09", interactiveCandidateMaxNewChats: 2,
      threadStatus: { status: "ready", metrics: { observations: 105, observedDays: 7, observedChats: 1, eligibleChats: 1, busySamples: 52, idleSamples: 53 } },
      turnHistory: { status: "ready", metrics: { scans: 105, observedDays: 7, startedTurns: 10, terminalTurns: 10, pairedTurns: 10, missingPairs: 0, invalidTurns: 0, errors: 0 } } });
    database.prepare("UPDATE provider_shadow_observations SET comparison='mismatch' WHERE id='obs-1'").run();
    expect((service.snapshot() as any).readiness).toMatchObject({ status: "not_ready", reasons: ["mismatch_observed"], candidateEligible: false, transitionEligible: false, candidateBlockers: ["thread_status_shadow_not_ready"], transitionBlockers: ["thread_status_shadow_not_ready"] });
    database.close();
  });
});
