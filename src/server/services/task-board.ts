import crypto from "node:crypto";
import type { AppDatabase } from "../core/database";
import type { Provider } from "../../shared/types";

const PROVIDERS = ["codex", "claude", "grok"] as const;
const DEFAULT_LIMITS = { project: 3, provider: 4, account: 2 } as const;

type ScopeType = keyof typeof DEFAULT_LIMITS;
type CheckpointStatus = "pending" | "in_progress" | "completed";
interface Checkpoint { id: string; label: string; status: CheckpointStatus }
interface Candidate {
  provider: Provider;
  accountId: number;
  accountLabel: string;
  remainingPercent: number | null;
  resetAt: string | null;
  active: { project: number; provider: number; account: number };
  limits: { project: number; provider: number; account: number };
  eligible: boolean;
  score: number;
  capability: Record<string, unknown> | null;
  reasons: string[];
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return typeof value === "string" ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function text(value: unknown, label: string, max: number, nullable = false): string | null {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== "string") throw new Error(`${label} 형식이 올바르지 않습니다.`);
  const trimmed = value.trim();
  if ((!trimmed && !nullable) || trimmed.length > max) throw new Error(`${label}은 1~${max}자여야 합니다.`);
  return trimmed || null;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label}은 최대 20개 배열이어야 합니다.`);
  return value.map((item) => text(item, label, 500) as string);
}

function checkpoints(value: unknown): Checkpoint[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("체크포인트는 최대 50개 배열이어야 합니다.");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("체크포인트 형식이 올바르지 않습니다.");
    const raw = item as Record<string, unknown>;
    const id = text(raw.id, "체크포인트 ID", 100) as string;
    const label = text(raw.label, "체크포인트", 500) as string;
    const status = raw.status as CheckpointStatus;
    if (ids.has(id) || !["pending", "in_progress", "completed"].includes(status)) throw new Error("체크포인트 ID 또는 상태가 올바르지 않습니다.");
    ids.add(id);
    return { id, label, status };
  });
}

function budget(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("예산 형식이 올바르지 않습니다.");
  const source = value as Record<string, unknown>;
  const allowed = ["tokens", "costUsd", "activeMinutes"];
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw new Error("지원하지 않는 예산 항목입니다.");
  const result: Record<string, number> = {};
  for (const key of allowed) {
    if (source[key] === undefined || source[key] === null) continue;
    const amount = Number(source[key]);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error("예산 값이 올바르지 않습니다.");
    result[key] = amount;
  }
  return result;
}

export class TaskBoardConflictError extends Error {
  readonly statusCode = 409;
}

export class TaskBoardService {
  private timer?: NodeJS.Timeout;

  constructor(private readonly database: AppDatabase) {}

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.reconcileQueue();
    this.timer = setInterval(() => this.reconcileQueue(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private appendEvent(taskId: string, key: string, type: string, payload: Record<string, unknown>): void {
    const sequence = (this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM agent_task_events WHERE task_id = ?").get(taskId) as { value: number }).value;
    this.database.prepare("INSERT OR IGNORE INTO agent_task_events(id, task_id, sequence, idempotency_key, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, sequence, key, type, JSON.stringify(payload));
  }

  list(limit = 500): Record<string, unknown> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("작업 보드 조회 개수는 1~1000이어야 합니다.");
    const rows = this.database.prepare(`
      SELECT t.*, p.name AS project_name, c.title AS chat_title, c.provider AS chat_provider, c.account_id,
        c.busy, c.status AS chat_status, a.label AS account_label,
        CASE WHEN w.chat_id IS NULL THEN 0 ELSE 1 END AS rate_limit_waiting,
        w.resume_after,
        q.state AS queue_state, q.priority AS queue_priority, q.queued_at, q.admitted_at,
        rr.id AS recommendation_id, rr.status AS recommendation_status, rr.candidates_json, rr.evidence_json,
        pt.url AS preview_url, pt.viewport_width AS preview_viewport_width, pt.viewport_height AS preview_viewport_height,
        vb.artifact_id AS visual_baseline_artifact_id
      FROM agent_tasks t
      JOIN projects p ON p.id = t.project_id
      JOIN chats c ON c.id = t.chat_id
      LEFT JOIN agent_accounts a ON a.id = COALESCE(t.selected_account_id, c.account_id)
      LEFT JOIN rate_limit_waits w ON w.chat_id = c.id
      LEFT JOIN task_queue_entries q ON q.task_id = t.id
      LEFT JOIN project_preview_targets pt ON pt.project_id = t.project_id
      LEFT JOIN task_visual_baselines vb ON vb.task_id = t.id
      LEFT JOIN task_routing_recommendations rr ON rr.id = (
        SELECT r2.id FROM task_routing_recommendations r2 WHERE r2.task_id = t.id ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1
      )
      ORDER BY CASE t.state WHEN 'needs_input' THEN 0 WHEN 'verifying' THEN 1 WHEN 'running' THEN 2 WHEN 'created' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
        t.priority DESC, t.updated_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    const columns: Record<string, Array<Record<string, unknown>>> = { working: [], needs_input: [], verifying: [], failed: [], completed: [], scheduled: [] };
    for (const row of rows) {
      const publicRow = { ...row };
      for (const key of ["acceptance_criteria_json", "checkpoints_json", "budget_json", "last_verified_checkpoint", "candidates_json", "evidence_json"]) delete publicRow[key];
      const state = String(row.state);
      const column = state === "needs_input" ? "needs_input" : state === "verifying" ? "verifying"
        : ["failed", "cancelled", "budget_exceeded"].includes(state) ? "failed" : state === "completed" ? "completed" : "working";
      const activityKind = row.rate_limit_waiting ? "rate_limit_wait" : row.queue_state === "queued" ? "queued"
        : row.busy ? "active" : state === "running" ? "idle" : "ready";
      columns[column].push({
        ...publicRow,
        acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
        checkpoints: parseJson(row.checkpoints_json, []),
        budget: parseJson(row.budget_json, {}),
        lastVerifiedCheckpoint: parseJson(row.last_verified_checkpoint, null),
        recommendation: row.recommendation_id ? {
          id: row.recommendation_id, status: row.recommendation_status,
          candidates: parseJson(row.candidates_json, []), evidence: parseJson(row.evidence_json, {}),
        } : null,
        activityKind,
      });
    }
    const scheduled = this.database.prepare(`
      SELECT s.id, s.name, s.project_id, p.name AS project_name, s.mode, s.provider, s.account_id,
        a.label AS account_label, s.chat_id, s.daily_time, s.timezone, s.run_date, s.last_status, s.last_error, s.updated_at
      FROM prompt_schedules s JOIN projects p ON p.id = s.project_id
      LEFT JOIN agent_accounts a ON a.id = s.account_id WHERE s.enabled = 1
      ORDER BY COALESCE(s.run_date, '9999-12-31'), s.daily_time LIMIT ?
    `).all(limit);
    columns.scheduled = scheduled as Array<Record<string, unknown>>;
    return { columns, limits: this.limits(), updatedAt: new Date().toISOString() };
  }

  update(taskId: string, input: Record<string, unknown>, idempotencyKey: string): Record<string, unknown> {
    return this.database.transaction(() => {
      const task = this.database.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
      if (!task) throw new Error("작업을 찾을 수 없습니다.");
      const prior = this.database.prepare("SELECT 1 FROM agent_task_events WHERE task_id = ? AND idempotency_key = ?").get(taskId, `board:${idempotencyKey}`);
      if (prior) return this.list(1_000);
      const nextGoal = input.goal === undefined ? task.goal : text(input.goal, "목표", 2_000, true);
      const nextAction = input.nextAction === undefined ? task.next_action : text(input.nextAction, "다음 행동", 2_000, true);
      const criteria = input.acceptanceCriteria === undefined ? parseJson(task.acceptance_criteria_json, []) : stringList(input.acceptanceCriteria, "완료 조건");
      const points = input.checkpoints === undefined ? parseJson(task.checkpoints_json, []) : checkpoints(input.checkpoints);
      const nextBudget = input.budget === undefined ? parseJson(task.budget_json, {}) : budget(input.budget);
      const priority = input.priority === undefined ? Number(task.priority) : Number(input.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error("우선순위는 0~100 정수여야 합니다.");
      this.database.prepare(`UPDATE agent_tasks SET goal = ?, acceptance_criteria_json = ?, checkpoints_json = ?, next_action = ?, budget_json = ?, priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(nextGoal, JSON.stringify(criteria), JSON.stringify(points), nextAction, JSON.stringify(nextBudget), priority, taskId);
      this.database.prepare("UPDATE task_queue_entries SET priority = ? WHERE task_id = ?").run(priority, taskId);
      this.appendEvent(taskId, `board:${idempotencyKey}`, "task.plan_updated", { priority, acceptanceCriteriaCount: criteria.length, checkpointCount: points.length, hasBudget: Object.keys(nextBudget).length > 0 });
      return this.list(1_000);
    })();
  }

  limits(): Record<string, number> {
    const rows = this.database.prepare("SELECT scope_type, scope_id, max_running FROM task_concurrency_limits").all() as Array<{ scope_type: ScopeType; scope_id: string; max_running: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) result[`${row.scope_type}:${row.scope_id}`] = row.max_running;
    return result;
  }

  setLimit(scopeType: ScopeType, scopeId: string, maxRunning: number, userId: number): void {
    if (!["project", "provider", "account"].includes(scopeType) || !scopeId.trim() || scopeId.length > 100) throw new Error("동시 실행 범위가 올바르지 않습니다.");
    if (!Number.isInteger(maxRunning) || maxRunning < 1 || maxRunning > 100) throw new Error("동시 실행 상한은 1~100이어야 합니다.");
    if (scopeType === "provider" && !PROVIDERS.includes(scopeId as Provider)) throw new Error("공급자 범위가 올바르지 않습니다.");
    this.database.prepare(`INSERT INTO task_concurrency_limits(scope_type, scope_id, max_running, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id) DO UPDATE SET max_running = excluded.max_running, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
      .run(scopeType, scopeId, maxRunning, userId);
  }

  private limit(scope: ScopeType, id: string): number {
    return (this.database.prepare("SELECT max_running FROM task_concurrency_limits WHERE scope_type = ? AND scope_id = ?").get(scope, id) as { max_running: number } | undefined)?.max_running ?? DEFAULT_LIMITS[scope];
  }

  private occupancy(): Array<{ project_id: number; provider: Provider; account_id: number; count: number }> {
    return this.database.prepare(`SELECT t.project_id, c.provider, COALESCE(t.selected_account_id, c.account_id) AS account_id, COUNT(*) AS count
      FROM agent_tasks t JOIN chats c ON c.id = t.chat_id LEFT JOIN task_queue_entries q ON q.task_id = t.id
      WHERE t.state IN ('running', 'verifying') OR q.state = 'admitted'
      GROUP BY t.project_id, c.provider, COALESCE(t.selected_account_id, c.account_id)`).all() as Array<{ project_id: number; provider: Provider; account_id: number; count: number }>;
  }

  reconcileQueue(): { admitted: string[]; released: string[] } {
    return this.database.transaction(() => {
      const released = (this.database.prepare(`SELECT q.task_id FROM task_queue_entries q JOIN agent_tasks t ON t.id = q.task_id
        WHERE q.state IN ('queued', 'admitted') AND t.state IN ('completed', 'failed', 'cancelled', 'budget_exceeded')`).all() as Array<{ task_id: string }>).map((row) => row.task_id);
      if (released.length) this.database.prepare(`UPDATE task_queue_entries SET state = 'released', released_at = CURRENT_TIMESTAMP
        WHERE state IN ('queued', 'admitted') AND task_id IN (SELECT id FROM agent_tasks WHERE state IN ('completed', 'failed', 'cancelled', 'budget_exceeded'))`).run();
      const counts = this.occupancy();
      const count = (scope: ScopeType, id: string | number): number => counts.filter((row) => scope === "project" ? row.project_id === Number(id) : scope === "provider" ? row.provider === id : row.account_id === Number(id)).reduce((sum, row) => sum + row.count, 0);
      const queued = this.database.prepare(`SELECT q.task_id, q.provider, q.account_id, t.project_id FROM task_queue_entries q JOIN agent_tasks t ON t.id = q.task_id
        WHERE q.state = 'queued' AND t.state IN ('created', 'needs_input') ORDER BY q.priority DESC, q.queued_at, q.task_id`).all() as Array<{ task_id: string; provider: Provider; account_id: number; project_id: number }>;
      const admitted: string[] = [];
      for (const item of queued) {
        if (count("project", item.project_id) >= this.limit("project", String(item.project_id))
          || count("provider", item.provider) >= this.limit("provider", item.provider)
          || count("account", item.account_id) >= this.limit("account", String(item.account_id))) continue;
        this.database.prepare("UPDATE task_queue_entries SET state = 'admitted', admitted_at = CURRENT_TIMESTAMP WHERE task_id = ? AND state = 'queued'").run(item.task_id);
        counts.push({ project_id: item.project_id, provider: item.provider, account_id: item.account_id, count: 1 });
        admitted.push(item.task_id);
        this.appendEvent(item.task_id, `queue:${item.task_id}:admitted:${Date.now()}`, "task.queue_admitted", { provider: item.provider, accountId: item.account_id });
      }
      return { admitted, released };
    })();
  }

  recommend(taskId: string, idempotencyKey: string, userId: number): Record<string, unknown> {
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM task_routing_recommendations WHERE task_id = ? AND idempotency_key = ?").get(taskId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return { recommendation: { ...existing, candidates: parseJson(existing.candidates_json, []), evidence: parseJson(existing.evidence_json, {}) }, replayed: true };
      const task = this.database.prepare(`SELECT t.*, c.provider AS chat_provider, c.account_id, c.provider_session_id, c.history_file,
        pv.config_snapshot_json FROM agent_tasks t JOIN chats c ON c.id = t.chat_id
        LEFT JOIN agent_preset_versions pv ON pv.id = t.profile_version_id WHERE t.id = ?`).get(taskId) as Record<string, unknown> | undefined;
      if (!task) throw new Error("작업을 찾을 수 없습니다.");
      const pinnedConfig = parseJson<Record<string, unknown>>(task.config_snapshot_json, {});
      const pinnedProvider = PROVIDERS.includes(pinnedConfig.provider as Provider) ? pinnedConfig.provider as Provider : null;
      const accounts = this.database.prepare(`SELECT a.id, a.provider, a.label, u.remaining_percent, u.reset_at,
        u.data_status FROM agent_accounts a LEFT JOIN usage_status u ON u.provider = a.provider AND u.account_id = a.id
        ORDER BY a.provider, a.is_default DESC, a.id`).all() as Array<{ id: number; provider: Provider; label: string; remaining_percent: number | null; reset_at: string | null; data_status: string | null }>;
      const activeRows = this.occupancy();
      const capabilityRows = this.database.prepare(`SELECT s.provider, s.capabilities_json FROM provider_capability_snapshots s WHERE s.checked_at =
        (SELECT MAX(s2.checked_at) FROM provider_capability_snapshots s2 WHERE s2.provider = s.provider)`).all() as Array<{ provider: Provider; capabilities_json: string }>;
      const capability = new Map(capabilityRows.map((row) => [row.provider, parseJson<Record<string, unknown>>(row.capabilities_json, {})]));
      const projectId = Number(task.project_id);
      const candidates: Candidate[] = accounts.filter((account) => !pinnedProvider || account.provider === pinnedProvider).map((account) => {
        const projectActive = activeRows.filter((row) => row.project_id === projectId).reduce((sum, row) => sum + row.count, 0);
        const providerActive = activeRows.filter((row) => row.provider === account.provider).reduce((sum, row) => sum + row.count, 0);
        const accountActive = activeRows.filter((row) => row.account_id === account.id).reduce((sum, row) => sum + row.count, 0);
        const limits = { project: this.limit("project", String(projectId)), provider: this.limit("provider", account.provider), account: this.limit("account", String(account.id)) };
        const remaining = account.data_status === "fresh" ? account.remaining_percent : null;
        const eligible = projectActive < limits.project && providerActive < limits.provider && accountActive < limits.account && remaining !== 0;
        const reasons = [remaining === null ? "usage_unknown" : `remaining_${remaining}%`, `active_${projectActive}/${providerActive}/${accountActive}`, capability.has(account.provider) ? "capability_observed" : "capability_unknown"];
        return { provider: account.provider, accountId: account.id, accountLabel: account.label, remainingPercent: remaining, resetAt: account.reset_at,
          active: { project: projectActive, provider: providerActive, account: accountActive }, limits, eligible,
          score: (eligible ? 1_000 : 0) + (remaining ?? 50) - accountActive * 20 - providerActive * 5,
          capability: capability.get(account.provider) ?? null, reasons };
      }).sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider) || a.accountId - b.accountId);
      if (!candidates.length) throw new Error("추천할 공급자 계정이 없습니다.");
      const id = crypto.randomUUID();
      const evidence = { projectId, pinnedProfileVersionId: task.profile_version_id ?? null, pinnedProvider,
        requestedModel: typeof pinnedConfig.model === "string" ? pinnedConfig.model : null,
        modelCapability: typeof pinnedConfig.model === "string" ? "profile_pinned_provider_only" : "unknown",
        cost: { status: "unavailable", reason: "interactive_provider_cost_not_reported" }, generatedAt: new Date().toISOString() };
      this.database.prepare(`INSERT INTO task_routing_recommendations(id, task_id, idempotency_key, candidates_json, evidence_json, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, taskId, idempotencyKey, JSON.stringify(candidates), JSON.stringify(evidence), userId);
      this.appendEvent(taskId, `routing:${id}:recommended`, "task.routing_recommended", { recommendationId: id, candidateCount: candidates.length, eligibleCount: candidates.filter((item) => item.eligible).length });
      return { recommendation: { id, task_id: taskId, status: "pending", candidates, evidence }, replayed: false };
    })();
  }

  apply(taskId: string, recommendationId: string, provider: Provider, accountId: number, userId: number): Record<string, unknown> {
    return this.database.transaction(() => {
      const recommendation = this.database.prepare("SELECT * FROM task_routing_recommendations WHERE id = ? AND task_id = ?").get(recommendationId, taskId) as Record<string, unknown> | undefined;
      if (!recommendation) throw new Error("라우팅 추천을 찾을 수 없습니다.");
      if (recommendation.status === "applied") return { applied: true, replayed: true };
      if (recommendation.status !== "pending") throw new TaskBoardConflictError("이미 종료된 라우팅 추천입니다.");
      const candidate = parseJson<Candidate[]>(recommendation.candidates_json, []).find((item) => item.provider === provider && item.accountId === accountId);
      if (!candidate) throw new Error("추천 snapshot에 없는 공급자·계정입니다.");
      const task = this.database.prepare(`SELECT t.state, t.profile_version_id, t.priority, c.id AS chat_id, c.status, c.busy, c.provider_session_id, c.history_file
        FROM agent_tasks t JOIN chats c ON c.id = t.chat_id WHERE t.id = ?`).get(taskId) as Record<string, unknown>;
      if (!["created", "needs_input"].includes(String(task.state)) || task.busy || task.status !== "stopped") throw new TaskBoardConflictError("실행 중인 작업의 라우팅은 바꿀 수 없습니다.");
      if (task.profile_version_id && provider !== candidate.provider) throw new TaskBoardConflictError("고정 profile 공급자는 바꿀 수 없습니다.");
      const currentProvider = (this.database.prepare("SELECT provider FROM chats WHERE id = ?").get(task.chat_id) as { provider: Provider }).provider;
      if (provider !== currentProvider && (task.provider_session_id || task.history_file || task.profile_version_id)) throw new TaskBoardConflictError("기존 session 또는 profile이 있는 채팅의 공급자는 바꿀 수 없습니다.");
      const occupancy = this.occupancy();
      const projectId = Number((this.database.prepare("SELECT project_id FROM agent_tasks WHERE id = ?").get(taskId) as { project_id: number }).project_id);
      const occupied = (scope: ScopeType): number => occupancy.filter((row) => scope === "project" ? row.project_id === projectId : scope === "provider" ? row.provider === provider : row.account_id === accountId).reduce((sum, row) => sum + row.count, 0);
      const eligibleNow = candidate.remainingPercent !== 0
        && occupied("project") < this.limit("project", String(projectId))
        && occupied("provider") < this.limit("provider", provider)
        && occupied("account") < this.limit("account", String(accountId));
      this.database.prepare("UPDATE chats SET provider = ?, account_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(provider, accountId, task.chat_id);
      this.database.prepare("DELETE FROM rate_limit_waits WHERE chat_id = ?").run(task.chat_id);
      this.database.prepare("UPDATE agent_tasks SET selected_provider = ?, selected_account_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(provider, accountId, taskId);
      this.database.prepare("UPDATE task_routing_recommendations SET status = 'applied', selected_provider = ?, selected_account_id = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(provider, accountId, userId, recommendationId);
      this.database.prepare(`INSERT INTO task_queue_entries(task_id, priority, state, provider, account_id, admitted_at)
        VALUES (?, ?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)
        ON CONFLICT(task_id) DO UPDATE SET priority = excluded.priority, state = excluded.state, provider = excluded.provider, account_id = excluded.account_id,
          admitted_at = excluded.admitted_at, released_at = NULL`).run(taskId, task.priority, eligibleNow ? "admitted" : "queued", provider, accountId, eligibleNow ? 1 : 0);
      this.appendEvent(taskId, `routing:${recommendationId}:applied`, "task.routing_applied", { recommendationId, provider, accountId, queueState: eligibleNow ? "admitted" : "queued" });
      return { applied: true, replayed: false, queueState: eligibleNow ? "admitted" : "queued" };
    })();
  }
}
