import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { AppDatabase } from "../core/database";
import type { Provider } from "../../shared/types";
import type { ProviderLaunch } from "../providers/provider";

type VersionReader = (command: string, args: string[]) => Promise<string | null>;

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const defaultVersionReader: VersionReader = (command, args) => new Promise((resolve) => {
  execFile(command, args, { timeout: 10_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C.UTF-8" } }, (error, stdout) => {
    resolve(error ? null : stdout.trim() || null);
  });
});

export class ProviderRolloutService {
  private readonly candidateRoot: string;
  private readonly managedRoot: string;

  constructor(private readonly database: AppDatabase, candidateRoot: string, private readonly readVersion: VersionReader = defaultVersionReader, dataDir?: string) {
    this.candidateRoot = path.resolve(candidateRoot);
    this.managedRoot = path.join(path.resolve(dataDir ?? candidateRoot), "provider-rollout-candidates");
    const rootStat = fs.lstatSync(this.candidateRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o022) !== 0) throw new Error("candidate CLI root가 안전한 디렉터리가 아닙니다.");
  }

  candidateCommand(provider: Provider): string {
    const command = path.join(this.candidateRoot, provider);
    if (path.dirname(path.resolve(command)) !== this.candidateRoot) throw new Error("candidate CLI 경로가 root를 벗어났습니다.");
    const stat = fs.lstatSync(command);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${provider} candidate CLI가 안전한 일반 파일이 아닙니다.`);
    fs.accessSync(command, fs.constants.X_OK);
    return command;
  }

  async start(input: { provider: Provider; canaryRunId: string; candidateVersion: string; candidateSha256: string | null; versionArgs: string[]; maxNewChats: number; idempotencyKey: string; userId: number }): Promise<Record<string, unknown>> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error("유효한 rollout 멱등 키가 필요합니다.");
    if (!Number.isInteger(input.maxNewChats) || input.maxNewChats < 1 || input.maxNewChats > 100) throw new Error("rollout 신규 채팅 수는 1~100이어야 합니다.");
    const existing = this.database.prepare("SELECT id, canary_run_id FROM provider_rollout_runs WHERE provider = ? AND idempotency_key = ?").get(input.provider, input.idempotencyKey) as { id: string; canary_run_id: string } | undefined;
    if (existing) {
      if (existing.canary_run_id !== input.canaryRunId) throw Object.assign(new Error("멱등 키가 다른 canary에 사용되었습니다."), { statusCode: 409 });
      return { ...this.get(existing.id), replay: true };
    }
    const active = this.database.prepare("SELECT id FROM provider_rollout_runs WHERE provider = ? AND state = 'active'").get(input.provider);
    if (active) throw Object.assign(new Error("이 공급자의 단계 rollout이 이미 진행 중입니다."), { statusCode: 409 });
    const sourceCommand = this.candidateCommand(input.provider);
    const sourceSha256 = hashFile(sourceCommand);
    if (!input.candidateSha256 || sourceSha256 !== input.candidateSha256) throw Object.assign(new Error("candidate CLI hash가 canary에서 검증한 파일과 일치하지 않습니다."), { statusCode: 409 });
    const id = crypto.randomUUID();
    const runRoot = path.join(this.managedRoot, id);
    fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    const command = path.join(runRoot, "cli");
    fs.copyFileSync(sourceCommand, command, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(command, fs.statSync(sourceCommand).mode & 0o777);
    const candidateSha256 = hashFile(command);
    if (candidateSha256 !== input.candidateSha256) {
      fs.rmSync(runRoot, { recursive: true, force: true });
      throw Object.assign(new Error("candidate CLI가 관리 복사 중 변경되었습니다."), { statusCode: 409 });
    }
    const actualVersion = await this.readVersion(command, input.versionArgs);
    if (actualVersion !== input.candidateVersion) {
      fs.rmSync(runRoot, { recursive: true, force: true });
      throw Object.assign(new Error("candidate CLI 실제 버전이 canary 후보와 일치하지 않습니다."), { statusCode: 409 });
    }
    try {
      this.database.prepare(`INSERT INTO provider_rollout_runs(id, provider, canary_run_id, idempotency_key, candidate_version, candidate_sha256, max_new_chats, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.provider, input.canaryRunId, input.idempotencyKey, input.candidateVersion, candidateSha256, input.maxNewChats, input.userId);
    } catch (error) {
      fs.rmSync(runRoot, { recursive: true, force: true });
      throw error;
    }
    return { ...this.get(id), replay: false };
  }

  assignNewChat(provider: Provider, chatId: number): string | null {
    return this.database.transaction(() => {
      const chat = this.database.prepare("SELECT provider, provider_session_id, history_file FROM chats WHERE id = ?").get(chatId) as { provider: Provider; provider_session_id: string | null; history_file: string | null } | undefined;
      if (!chat || chat.provider !== provider || chat.provider_session_id || chat.history_file) return null;
      const rollout = this.database.prepare("SELECT id, assigned_count, max_new_chats FROM provider_rollout_runs WHERE provider = ? AND state = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(provider) as { id: string; assigned_count: number; max_new_chats: number } | undefined;
      if (!rollout || rollout.assigned_count >= rollout.max_new_chats) return null;
      const inserted = this.database.prepare("INSERT OR IGNORE INTO provider_rollout_chats(rollout_run_id, chat_id) VALUES (?, ?)").run(rollout.id, chatId);
      if (inserted.changes === 1) this.database.prepare("UPDATE provider_rollout_runs SET assigned_count = assigned_count + 1 WHERE id = ?").run(rollout.id);
      return rollout.id;
    })();
  }

  resolveLaunch(chatId: number, provider: Provider, launch: ProviderLaunch): ProviderLaunch {
    const assigned = this.database.prepare(`SELECT r.state, r.candidate_sha256 FROM provider_rollout_chats rc JOIN provider_rollout_runs r ON r.id = rc.rollout_run_id
      WHERE rc.chat_id = ? AND r.provider = ?`).get(chatId, provider) as { state: string; candidate_sha256: string } | undefined;
    if (assigned?.state !== "active") return launch;
    const command = path.join(this.managedRoot, String((this.database.prepare("SELECT rollout_run_id FROM provider_rollout_chats WHERE chat_id = ?").get(chatId) as { rollout_run_id: string }).rollout_run_id), "cli");
    const stat = fs.lstatSync(command);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("rollout candidate 관리 복사본이 올바르지 않습니다.");
    if (hashFile(command) !== assigned.candidate_sha256) throw new Error("rollout candidate CLI hash가 시작 시점과 달라졌습니다.");
    return { ...launch, command };
  }

  observeChatStatus(chatId: number, status: string): void {
    if (status !== "error") return;
    this.database.prepare("UPDATE provider_rollout_chats SET failure_observed = 1 WHERE chat_id = ?").run(chatId);
  }

  authorizePromotion(id: string, provider: Provider, canaryRunId: string): void {
    const summary = this.get(id) as any;
    if (summary.provider !== provider || summary.canaryRunId !== canaryRunId || summary.state !== "active") throw Object.assign(new Error("승격할 active rollout이 아닙니다."), { statusCode: 409 });
    if (summary.assignedCount < summary.maxNewChats || summary.errorCount > 0) throw Object.assign(new Error("단계 rollout 수가 차지 않았거나 오류 채팅이 있어 전체 적용할 수 없습니다."), { statusCode: 409 });
  }

  promote(id: string, userId: number): void {
    const result = this.database.prepare("UPDATE provider_rollout_runs SET state = 'promoted', decided_by = ?, decision_reason = 'full_update_applied', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'active'").run(userId, id);
    if (result.changes !== 1) throw Object.assign(new Error("active rollout만 승격할 수 있습니다."), { statusCode: 409 });
  }

  halt(id: string, provider: Provider, userId: number, reason = "operator_halted"): Record<string, unknown> {
    const result = this.database.prepare("UPDATE provider_rollout_runs SET state = 'halted', decided_by = ?, decision_reason = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ? AND provider = ? AND state = 'active'")
      .run(userId, reason.slice(0, 80), id, provider);
    if (result.changes !== 1) throw Object.assign(new Error("active rollout만 중단할 수 있습니다."), { statusCode: 409 });
    return this.get(id);
  }

  get(id: string): Record<string, unknown> {
    const row = this.database.prepare(`SELECT r.id, r.provider, r.canary_run_id, r.candidate_version, r.state, r.max_new_chats, r.assigned_count,
      r.decision_reason, r.decided_at, r.created_at,
      COALESCE(SUM(rc.failure_observed), 0) AS error_count
      FROM provider_rollout_runs r LEFT JOIN provider_rollout_chats rc ON rc.rollout_run_id = r.id LEFT JOIN chats c ON c.id = rc.chat_id
      WHERE r.id = ? GROUP BY r.id`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("rollout을 찾을 수 없습니다."), { statusCode: 404 });
    return { id: row.id, provider: row.provider, canaryRunId: row.canary_run_id, candidateVersion: row.candidate_version, state: row.state,
      maxNewChats: row.max_new_chats, assignedCount: row.assigned_count, errorCount: row.error_count, decisionReason: row.decision_reason,
      decidedAt: row.decided_at, createdAt: row.created_at };
  }

  latest(): Record<string, unknown>[] {
    const ids = this.database.prepare(`SELECT id FROM provider_rollout_runs r WHERE rowid = (
      SELECT newer.rowid FROM provider_rollout_runs newer WHERE newer.provider = r.provider ORDER BY newer.created_at DESC, newer.rowid DESC LIMIT 1
    ) ORDER BY provider`).all() as Array<{ id: string }>;
    return ids.map((row) => this.get(row.id));
  }
}
