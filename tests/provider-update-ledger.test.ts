import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/core/config";
import { openDatabase } from "../src/server/core/database";
import { ProviderUpdateLedger } from "../src/server/services/provider-update-ledger";

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wam-update-ledger-"));
  roots.push(root);
  const database = openDatabase({ dataDir: root } as AppConfig);
  database.prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
  const projectId = Number(database.prepare("INSERT INTO projects(name, path) VALUES ('p', ?)").run(root).lastInsertRowid);
  const chatId = Number(database.prepare(`INSERT INTO chats(project_id, provider, tmux_name, title, provider_session_id, preset_config_json)
    VALUES (?, 'codex', 'c', 'c', 'session-stable', '{"runtime":{"provider":"codex"}}')`).run(projectId).lastInsertRowid);
  database.prepare("INSERT INTO agent_tasks(id, chat_id, project_id, state, profile_version_id) VALUES ('task-stable', ?, ?, 'running', NULL)").run(chatId, projectId);
  database.prepare(`INSERT INTO provider_canary_runs(id, provider, idempotency_key, suite_version, current_version, candidate_version, reported_version, state, current_capabilities_json, finished_at)
    VALUES ('canary', 'codex', 'c', 'v1', '1', '2', '2', 'passed', '{}', CURRENT_TIMESTAMP)`).run();
  return { database, chatId };
}

describe("provider update ledger", () => {
  it("상태 전이와 session/task/profile 불변성을 append-only event로 기록한다", () => {
    const { database, chatId } = fixture();
    const ledger = new ProviderUpdateLedger(database);
    const created = ledger.start({ provider: "codex", canaryRunId: "canary", idempotencyKey: "update-1", previousVersion: "1", candidateVersion: "2", userId: 1 }) as any;
    const replay = ledger.start({ provider: "codex", canaryRunId: "canary", idempotencyKey: "update-1", previousVersion: "1", candidateVersion: "2", userId: 1 }) as any;
    expect(replay.run.id).toBe(created.run.id);
    expect(replay.replay).toBe(true);
    ledger.transition(created.run.id, "updating");
    expect(ledger.invariantsPreserved(created.run.id)).toBe(true);
    ledger.transition(created.run.id, "applied", { installedVersion: "2", invariantsPreserved: true, restartedChatCount: 1 });
    const final = ledger.get(created.run.id) as any;
    expect(final.run).toMatchObject({ state: "applied", previous_version: "1", candidate_version: "2", installed_version: "2", session_invariant_count: 1 });
    expect(final.events.map((event: any) => [event.sequence, event.state])).toEqual([[1, "pending"], [2, "updating"], [3, "applied"]]);
    expect(ledger.latest()).toEqual([expect.objectContaining({ id: created.run.id, provider: "codex", state: "applied", previousVersion: "1", candidateVersion: "2", installedVersion: "2" })]);
    expect(JSON.stringify(ledger.latest())).not.toContain("backup_manifest");

    database.prepare("UPDATE chats SET provider_session_id = 'changed' WHERE id = ?").run(chatId);
    expect(ledger.invariantsPreserved(created.run.id)).toBe(false);
    expect(() => ledger.transition(created.run.id, "failed")).toThrow("전환할 수 없습니다");
    database.close();
  });

  it("서버 재시작 중 updating 상태를 rollback_required로 한 번만 복구한다", () => {
    const { database } = fixture();
    const ledger = new ProviderUpdateLedger(database);
    const created = ledger.start({ provider: "codex", canaryRunId: "canary", idempotencyKey: "update-2", previousVersion: "1", candidateVersion: "2", userId: 1 }) as any;
    ledger.transition(created.run.id, "updating");
    expect(ledger.recoverInterruptedRuns()).toBe(1);
    expect(ledger.recoverInterruptedRuns()).toBe(0);
    const recovered = ledger.get(created.run.id) as any;
    expect(recovered.run).toMatchObject({ state: "rollback_required", error_code: "server_restart_during_update" });
    expect(recovered.events.map((event: any) => event.state)).toEqual(["pending", "updating", "rollback_required"]);
    database.close();
  });
});
