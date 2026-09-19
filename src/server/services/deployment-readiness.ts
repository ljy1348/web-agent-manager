import type { AppDatabase } from "../core/database";
import { expectedDatabaseShape } from "../core/database";

export interface DeploymentReadinessOptions {
  buildAvailable: boolean;
}

export interface DeploymentReadinessReport {
  schemaVersion: 1;
  workloadSafeForRestart: boolean;
  backupRequired: boolean;
  blockers: string[];
  database: {
    integrity: "ok" | "failed";
    migrationRequired: boolean;
    missingTables: string[];
    missingColumns: string[];
  };
  work: Record<string, number>;
}

function tableExists(database: AppDatabase, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", name));
}

function count(database: AppDatabase, table: string, sql: string, values: unknown[] = []): number {
  if (!tableExists(database, table)) return 0;
  return Number((database.prepare(sql).get(...values) as { count: number }).count);
}

// 이 검사는 migration을 호출하지 않는다. 진행 중 work를 완료/실패로 바꾸지도 않으며 재시작 가능 여부만 반환한다.
export function inspectDeploymentReadiness(database: AppDatabase, options: DeploymentReadinessOptions): DeploymentReadinessReport {
  const expected = expectedDatabaseShape();
  const actualTables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table") as Array<{ name: string }>).map((row) => row.name));
  const missingTables = Object.keys(expected).filter((table) => !actualTables.has(table)).sort();
  const missingColumns: string[] = [];
  for (const [table, columns] of Object.entries(expected)) {
    if (!actualTables.has(table)) continue;
    const actual = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    for (const column of columns) if (!actual.has(column)) missingColumns.push(`${table}.${column}`);
  }
  missingColumns.sort();
  const quickCheck = database.pragma("quick_check") as Array<Record<string, unknown>>;
  const integrity = quickCheck.length === 1 && Object.values(quickCheck[0] ?? {})[0] === "ok" ? "ok" : "failed";
  const work = {
    busyOrTransitioningChats: count(database, "chats", "SELECT COUNT(*) AS count FROM chats WHERE busy = 1 OR status IN (?, ?, ?)", ["starting", "resuming", "stopping"]),
    verifyingTasks: count(database, "agent_tasks", "SELECT COUNT(*) AS count FROM agent_tasks WHERE state = ?", ["verifying"]),
    inFlightPromptCommands: count(database, "prompt_commands", "SELECT COUNT(*) AS count FROM prompt_commands WHERE state IN (?, ?)", ["received", "dispatching"]),
    activeExperiments: count(database, "experiment_runs", "SELECT COUNT(*) AS count FROM experiment_runs WHERE status IN (?, ?)", ["preparing", "running"]),
    activeVerifications: count(database, "verification_runs", "SELECT COUNT(*) AS count FROM verification_runs WHERE state IN (?, ?)", ["pending", "running"]),
    activeCanaries: count(database, "provider_canary_runs", "SELECT COUNT(*) AS count FROM provider_canary_runs WHERE state IN (?, ?)", ["pending", "running"]),
    activeProviderUpdates: count(database, "provider_update_runs", "SELECT COUNT(*) AS count FROM provider_update_runs WHERE state IN (?, ?, ?)", ["pending", "updating", "rolling_back"]),
    activeProviderRollouts: count(database, "provider_rollout_runs", "SELECT COUNT(*) AS count FROM provider_rollout_runs WHERE state = ?", ["active"]),
    activeRemoteDispatches: count(database, "remote_worker_dispatches", "SELECT COUNT(*) AS count FROM remote_worker_dispatches WHERE state = ?", ["dispatching"]),
    activeStructuredDeliveries: count(database, "codex_structured_delivery_receipts", "SELECT COUNT(*) AS count FROM codex_structured_delivery_receipts WHERE state IN (?, ?)", ["dispatching", "accepted"]),
  };
  const blockers = [
    ...(integrity !== "ok" ? ["database_integrity_failed"] : []),
    ...(!options.buildAvailable ? ["production_build_missing"] : []),
    ...Object.entries(work).filter(([, value]) => value > 0).map(([name]) => name),
  ];
  return {
    schemaVersion: 1,
    workloadSafeForRestart: blockers.length === 0,
    backupRequired: missingTables.length > 0 || missingColumns.length > 0,
    blockers,
    database: { integrity, migrationRequired: missingTables.length > 0 || missingColumns.length > 0, missingTables, missingColumns },
    work,
  };
}
