import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import type { Provider } from "../../shared/types";

type UpdateState = "pending" | "updating" | "applied" | "failed" | "rollback_required" | "rolling_back" | "rolled_back" | "rollback_failed";

const TRANSITIONS: Record<UpdateState, UpdateState[]> = {
  pending: ["updating", "failed"],
  updating: ["applied", "rollback_required"],
  applied: ["rolling_back"],
  failed: [],
  rollback_required: ["rolling_back"],
  rolling_back: ["rolled_back", "rollback_failed"],
  rolled_back: [],
  rollback_failed: ["rolling_back"],
};

function safeEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["reason", "installedVersion", "invariantsPreserved", "restartedMonitorCount", "restartedChatCount"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const item = value[key];
    return typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null ? [[key, item]] : [];
  }));
}

export class ProviderUpdateLedger {
  constructor(private readonly database: AppDatabase) {}

  private invariant(provider: Provider): { hash: string; count: number } {
    const rows = this.database.prepare(`
      SELECT c.id AS chat_id, c.provider_session_id, c.preset_version_id, c.preset_config_json,
             t.id AS task_id, t.state AS task_state, t.profile_version_id
      FROM chats c LEFT JOIN agent_tasks t ON t.chat_id = c.id
      WHERE c.provider = ? ORDER BY c.id, t.created_at, t.id
    `).all(provider);
    const encoded = JSON.stringify(rows);
    return { hash: crypto.createHash("sha256").update(encoded).digest("hex"), count: (rows as unknown[]).length };
  }

  start(input: { provider: Provider; canaryRunId: string; idempotencyKey: string; previousVersion: string | null; candidateVersion: string; userId: number; rolloutRunId?: string | null }): Record<string, unknown> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error("유효한 update 멱등 키가 필요합니다.");
    const existing = this.database.prepare("SELECT id, canary_run_id FROM provider_update_runs WHERE provider = ? AND idempotency_key = ?").get(input.provider, input.idempotencyKey) as { id: string; canary_run_id: string } | undefined;
    if (existing) {
      if (existing.canary_run_id !== input.canaryRunId) throw Object.assign(new Error("멱등 키가 다른 canary에 사용되었습니다."), { statusCode: 409 });
      return { ...this.get(existing.id), replay: true };
    }
    const id = crypto.randomUUID();
    const invariant = this.invariant(input.provider);
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO provider_update_runs(
        id, provider, canary_run_id, idempotency_key, previous_version, candidate_version, rollout_run_id, session_invariant_hash, session_invariant_count, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.provider, input.canaryRunId, input.idempotencyKey, input.previousVersion, input.candidateVersion, input.rolloutRunId ?? null, invariant.hash, invariant.count, input.userId);
      this.appendEvent(id, "pending", { reason: "update_authorized" });
    })();
    return { ...this.get(id), replay: false };
  }

  findByIdempotency(provider: Provider, idempotencyKey: string, canaryRunId: string): Record<string, unknown> | undefined {
    if (!idempotencyKey) return undefined;
    const existing = this.database.prepare("SELECT id, canary_run_id FROM provider_update_runs WHERE provider = ? AND idempotency_key = ?")
      .get(provider, idempotencyKey) as { id: string; canary_run_id: string } | undefined;
    if (!existing) return undefined;
    if (existing.canary_run_id !== canaryRunId) throw Object.assign(new Error("멱등 키가 다른 canary에 사용되었습니다."), { statusCode: 409 });
    return this.get(existing.id);
  }

  latest(): Record<string, unknown>[] {
    const rows = this.database.prepare(`
      SELECT id, provider, canary_run_id, previous_version, candidate_version, installed_version, rollout_run_id, state, error_code, started_at, finished_at, created_at
      FROM provider_update_runs r WHERE rowid = (
        SELECT newer.rowid FROM provider_update_runs newer WHERE newer.provider = r.provider ORDER BY newer.created_at DESC, newer.rowid DESC LIMIT 1
      ) ORDER BY provider
    `).all() as Array<Record<string, unknown>>;
    return rows.map((run) => ({
      id: run.id,
      provider: run.provider,
      canaryRunId: run.canary_run_id,
      previousVersion: run.previous_version,
      candidateVersion: run.candidate_version,
      installedVersion: run.installed_version,
      rolloutRunId: run.rollout_run_id,
      state: run.state,
      errorCode: run.error_code,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      createdAt: run.created_at,
    }));
  }

  transition(id: string, next: UpdateState, evidence: Record<string, unknown> = {}): Record<string, unknown> {
    const current = this.database.prepare("SELECT state FROM provider_update_runs WHERE id = ?").get(id) as { state: UpdateState } | undefined;
    if (!current) throw Object.assign(new Error("update 실행을 찾을 수 없습니다."), { statusCode: 404 });
    if (!TRANSITIONS[current.state].includes(next)) throw Object.assign(new Error(`${current.state}에서 ${next}로 전환할 수 없습니다.`), { statusCode: 409 });
    const installedVersion = typeof evidence.installedVersion === "string" ? evidence.installedVersion : null;
    const errorCode = typeof evidence.reason === "string" && next !== "applied" ? evidence.reason.slice(0, 80) : null;
    this.database.transaction(() => {
      this.database.prepare(`UPDATE provider_update_runs SET state = ?, installed_version = COALESCE(?, installed_version), error_code = ?,
        started_at = CASE WHEN ? = 'updating' THEN CURRENT_TIMESTAMP ELSE started_at END,
        finished_at = CASE WHEN ? IN ('applied','failed','rolled_back','rollback_failed') THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE id = ?`)
        .run(next, installedVersion, errorCode, next, next, id);
      this.appendEvent(id, next, evidence);
    })();
    return this.get(id);
  }

  invariantsPreserved(id: string): boolean {
    const row = this.database.prepare("SELECT provider, session_invariant_hash, session_invariant_count FROM provider_update_runs WHERE id = ?").get(id) as { provider: Provider; session_invariant_hash: string; session_invariant_count: number } | undefined;
    if (!row) throw Object.assign(new Error("update 실행을 찾을 수 없습니다."), { statusCode: 404 });
    const current = this.invariant(row.provider);
    return current.hash === row.session_invariant_hash && current.count === row.session_invariant_count;
  }

  setBackupManifest(id: string, manifest: Record<string, unknown>): void {
    const result = this.database.prepare("UPDATE provider_update_runs SET backup_manifest_json = ? WHERE id = ? AND state = 'pending'").run(JSON.stringify(manifest), id);
    if (result.changes !== 1) throw Object.assign(new Error("pending update에만 backup manifest를 연결할 수 있습니다."), { statusCode: 409 });
  }

  beginRollback(id: string, idempotencyKey: string, userId: number): { replay: boolean; record: Record<string, unknown> } {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("유효한 rollback 멱등 키가 필요합니다.");
    const current = this.database.prepare("SELECT state, rollback_idempotency_key FROM provider_update_runs WHERE id = ?").get(id) as { state: UpdateState; rollback_idempotency_key: string | null } | undefined;
    if (!current) throw Object.assign(new Error("update 실행을 찾을 수 없습니다."), { statusCode: 404 });
    if (current.rollback_idempotency_key && current.rollback_idempotency_key !== idempotencyKey) throw Object.assign(new Error("다른 rollback 멱등 키가 이미 사용되었습니다."), { statusCode: 409 });
    if (current.state === "rolled_back") return { replay: true, record: this.get(id) };
    if (!["applied", "rollback_required", "rollback_failed"].includes(current.state)) throw Object.assign(new Error("현재 update 상태에서는 rollback할 수 없습니다."), { statusCode: 409 });
    this.database.prepare("UPDATE provider_update_runs SET rollback_idempotency_key = ?, rolled_back_by = ? WHERE id = ?").run(idempotencyKey, userId, id);
    return { replay: false, record: this.transition(id, "rolling_back", { reason: "rollback_requested" }) };
  }

  backupManifest(id: string): Record<string, unknown> {
    const row = this.database.prepare("SELECT backup_manifest_json FROM provider_update_runs WHERE id = ?").get(id) as { backup_manifest_json: string } | undefined;
    if (!row) throw Object.assign(new Error("update 실행을 찾을 수 없습니다."), { statusCode: 404 });
    try { return JSON.parse(row.backup_manifest_json) as Record<string, unknown>; } catch { throw new Error("backup manifest를 읽을 수 없습니다."); }
  }

  recoverInterruptedRuns(): number {
    const result = this.database.prepare("UPDATE provider_update_runs SET state = 'rollback_required', error_code = 'server_restart_during_update' WHERE state = 'updating'").run();
    const ids = this.database.prepare("SELECT id FROM provider_update_runs WHERE state = 'rollback_required' AND error_code = 'server_restart_during_update'").all() as Array<{ id: string }>;
    for (const row of ids) {
      const exists = this.database.prepare("SELECT 1 FROM provider_update_events WHERE update_run_id = ? AND state = 'rollback_required' AND json_extract(evidence_json, '$.reason') = 'server_restart_during_update'").get(row.id);
      if (!exists) this.appendEvent(row.id, "rollback_required", { reason: "server_restart_during_update" });
    }
    return result.changes;
  }

  get(id: string): Record<string, unknown> {
    const run = this.database.prepare(`SELECT id, provider, canary_run_id, previous_version, candidate_version, installed_version, rollout_run_id, state,
      session_invariant_hash, session_invariant_count, backup_manifest_json, rollback_idempotency_key, rolled_back_by, error_code, created_by, started_at, finished_at, created_at
      FROM provider_update_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!run) throw Object.assign(new Error("update 실행을 찾을 수 없습니다."), { statusCode: 404 });
    const events = this.database.prepare("SELECT sequence, state, evidence_json, created_at FROM provider_update_events WHERE update_run_id = ? ORDER BY sequence").all(id) as Array<Record<string, unknown>>;
    return { run, events: events.map((event) => ({ ...event, evidence: JSON.parse(String(event.evidence_json)), evidence_json: undefined })) };
  }

  private appendEvent(id: string, state: UpdateState, evidence: Record<string, unknown>): void {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM provider_update_events WHERE update_run_id = ?").get(id) as { sequence: number };
    this.database.prepare("INSERT INTO provider_update_events(id, update_run_id, sequence, state, evidence_json) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), id, row.sequence, state, JSON.stringify(safeEvidence(evidence)));
  }
}
