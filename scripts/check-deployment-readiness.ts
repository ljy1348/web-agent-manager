import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { inspectDeploymentReadiness } from "../src/server/services/deployment-readiness";

function serverProcess(dataDir: string): { pid: number | null; running: boolean; startedAt: string | null } {
  let pid: number | null = null;
  try {
    const parsed = Number(fs.readFileSync(path.join(dataDir, "supervisor", "server.pid"), "utf8").trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) pid = parsed;
  } catch { /* systemd/중지 환경은 pid file이 없을 수 있다. */ }
  if (!pid) return { pid: null, running: false, startedAt: null };
  try {
    process.kill(pid, 0);
    const raw = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const started = Date.parse(raw);
    return { pid, running: true, startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null };
  } catch {
    return { pid, running: false, startedAt: null };
  }
}

const rootDir = process.cwd();
const dataDir = path.resolve(process.argv[2] ?? process.env.WEB_AGENT_MANAGER_DATA_DIR ?? process.env.MYAGENT_DATA_DIR ?? path.join(rootDir, "data"));
const databaseFile = path.join(dataDir, "web-agent-manager.sqlite");
const buildFile = path.join(rootDir, "dist", "server", "src", "server", "index.js");
const buildAvailable = fs.existsSync(buildFile) && fs.statSync(buildFile).isFile();
const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
try {
  const inspectionStarted = performance.now();
  const readiness = inspectDeploymentReadiness(database, { buildAvailable });
  const inspectionMs = Number((performance.now() - inspectionStarted).toFixed(3));
  const server = serverProcess(dataDir);
  const buildCreatedAt = buildAvailable ? fs.statSync(buildFile).mtime.toISOString() : null;
  const runningBuildStale = Boolean(server.running && server.startedAt && buildCreatedAt && Date.parse(buildCreatedAt) > Date.parse(server.startedAt));
  const nextActions = [
    ...(readiness.database.migrationRequired ? ["create_verified_pre_migration_backup"] : []),
    ...(!readiness.workloadSafeForRestart ? ["wait_for_all_blockers_to_reach_zero"] : []),
    ...(readiness.workloadSafeForRestart && runningBuildStale ? ["restart_supervisor_then_verify_health_and_schema"] : []),
  ];
  process.stdout.write(`${JSON.stringify({ ...readiness, inspectionMs, build: { available: buildAvailable, createdAt: buildCreatedAt, runningBuildStale }, server, nextActions }, null, 2)}\n`);
  process.exitCode = readiness.workloadSafeForRestart ? 0 : 2;
} finally {
  database.close();
}
