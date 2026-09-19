import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { readSecretInput } from "../src/server/core/secret-input";

type JsonObject = Record<string, unknown>;

interface ReadinessReport {
  workloadSafeForRestart: boolean;
  blockers: string[];
  database: { integrity: string; migrationRequired: boolean; missingTables: string[]; missingColumns: string[] };
  work: Record<string, number>;
  server: { pid: number | null; running: boolean };
}

interface RunResult {
  schemaVersion: 1;
  runId: string;
  status: "waiting" | "restarting" | "qa" | "passed" | "failed";
  startedAt: string;
  updatedAt: string;
  steps: string[];
  error?: string;
  server?: { oldPid: number; newPid: number };
  qa?: JsonObject;
}

const rootDir = process.cwd();
const dataDir = path.resolve(process.env.WEB_AGENT_MANAGER_DATA_DIR ?? path.join(rootDir, "data"));
const supervisorDir = path.join(dataDir, "supervisor");
const runId = process.env.WAM_APPROVED_RUN_ID?.trim() ?? "";
if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId)) throw new Error("WAM_APPROVED_RUN_ID가 올바르지 않습니다.");
if (process.env.WAM_APPROVED_DEPLOYMENT !== "1") throw new Error("WAM_APPROVED_DEPLOYMENT=1이 필요합니다.");

const resultFile = path.join(supervisorDir, `approved-deployment-${runId}.json`);
const readinessScript = path.join(rootDir, "dist", "server", "scripts", "check-deployment-readiness.js");
const testerScript = path.join(rootDir, "dist", "server", "scripts", "create-test-user.js");
const databaseFile = path.join(dataDir, "web-agent-manager.sqlite");
const backupFile = path.resolve(process.env.WAM_APPROVED_BACKUP_FILE ?? "");
const expectedBackupSha256 = process.env.WAM_APPROVED_BACKUP_SHA256?.trim().toLowerCase() ?? "";
const expectedOldPid = Number(process.env.WAM_APPROVED_SERVER_PID);
const username = process.env.WEB_AGENT_MANAGER_TEST_USERNAME?.trim() ?? "";
const passwordFile = process.env.WEB_AGENT_MANAGER_TEST_PASSWORD_FILE ?? "";
const baseUrl = process.env.WAM_APPROVED_BASE_URL ?? "http://127.0.0.1:14003";
const waitTimeoutMs = Math.max(30_000, Number(process.env.WAM_APPROVED_WAIT_TIMEOUT_MS ?? 1_200_000));

const result: RunResult = {
  schemaVersion: 1,
  runId,
  status: "waiting",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  steps: [],
};

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function writeResult(): void {
  fs.mkdirSync(supervisorDir, { recursive: true, mode: 0o700 });
  const temporary = `${resultFile}.${process.pid}.tmp`;
  result.updatedAt = new Date().toISOString();
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, resultFile);
  fs.chmodSync(resultFile, 0o600);
}

function step(name: string, status?: RunResult["status"]): void {
  if (!result.steps.includes(name)) result.steps.push(name);
  if (status) result.status = status;
  writeResult();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256OwnerOnlyFile(filename: string): string {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      throw new Error("승인된 백업은 owner-only 일반 파일이어야 합니다.");
    }
    if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
      throw new Error("승인된 백업의 소유자가 현재 실행 사용자와 다릅니다.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    try {
      while (true) {
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, position);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        position += count;
      }
    } finally {
      buffer.fill(0);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readiness(): ReadinessReport {
  const execution = spawnSync(process.execPath, [readinessScript, dataDir], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, WEB_AGENT_MANAGER_DATA_DIR: dataDir },
  });
  if (execution.error) throw execution.error;
  if (execution.signal) throw new Error(`readiness 검사가 signal ${execution.signal}로 종료됐습니다.`);
  if (execution.status !== 0 && execution.status !== 2) throw new Error(`readiness 검사가 exit ${execution.status}로 실패했습니다.`);
  try {
    return JSON.parse(execution.stdout) as ReadinessReport;
  } catch {
    throw new Error("readiness 결과 JSON을 해석할 수 없습니다.");
  }
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForIdle(): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const report = readiness();
    if (report.database.integrity !== "ok") throw new Error("운영 DB integrity가 정상이 아닙니다.");
    if (!report.server.running || report.server.pid !== expectedOldPid || !running(expectedOldPid)) {
      throw new Error("승인 시점의 운영 서버 PID가 변경됐습니다.");
    }
    if (report.workloadSafeForRestart) return;
    await sleep(1_000);
  }
  throw new Error("유지보수 대기 시간 안에 workload가 idle이 되지 않았습니다.");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<{ response: Response; elapsedMs: number }> {
  const started = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { response, elapsedMs: Number((performance.now() - started).toFixed(3)) };
}

function percentile(values: number[], percentage: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percentage) - 1)] ?? 0;
}

async function waitForNewServer(): Promise<number> {
  const pidFile = path.join(supervisorDir, "server.pid");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let pid = 0;
    try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { /* supervisor 전환 중 */ }
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== expectedOldPid && running(pid)) {
      try {
        const health = await fetchWithTimeout(`${baseUrl}/health`, {}, 3_000);
        await health.response.arrayBuffer();
        if (health.response.ok) return pid;
      } catch { /* 기동 중 */ }
    }
    await sleep(1_000);
  }
  throw new Error("새 서버 PID와 health를 120초 안에 확인하지 못했습니다.");
}

function verifyMigratedSchema(): void {
  const report = readiness();
  if (report.database.integrity !== "ok" || report.database.migrationRequired || report.database.missingTables.length || report.database.missingColumns.length) {
    throw new Error("재시작 뒤 DB schema/integrity 검증이 실패했습니다.");
  }
}

function createTester(): void {
  const execution = spawnSync(process.execPath, [testerScript], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      WEB_AGENT_MANAGER_DATA_DIR: dataDir,
      WEB_AGENT_MANAGER_TEST_USERNAME: username,
      WEB_AGENT_MANAGER_TEST_PASSWORD_FILE: passwordFile,
    },
  });
  if (execution.error) throw execution.error;
  if (execution.status !== 0) throw new Error(`테스터 계정 생성이 exit ${execution.status}로 실패했습니다.`);
}

async function discard(response: Response): Promise<void> {
  await response.arrayBuffer();
}

async function actualQa(): Promise<JsonObject> {
  const password = readSecretInput({
    valueEnvironment: "WEB_AGENT_MANAGER_TEST_PASSWORD",
    fileEnvironment: "WEB_AGENT_MANAGER_TEST_PASSWORD_FILE",
    label: "테스트 계정 비밀번호",
    minimumLength: 12,
    maximumLength: 256,
  });
  let cookie = "";
  let csrfToken = "";
  try {
    const login = await fetchWithTimeout(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const loginBody = await login.response.json() as { user?: JsonObject; csrfToken?: string };
    if (login.response.status !== 200 || loginBody.user?.role !== "user" || loginBody.user?.access_scope !== "test_only" || typeof loginBody.csrfToken !== "string") {
      throw new Error(`실제 test_only 로그인이 기대 상태가 아닙니다(status=${login.response.status}).`);
    }
    csrfToken = loginBody.csrfToken;
    const setCookies = login.response.headers.getSetCookie();
    const sessionCookie = setCookies.find((value) => value.startsWith("web_agent_manager_session="));
    if (!sessionCookie) throw new Error("로그인 응답에 web session cookie가 없습니다.");
    cookie = sessionCookie.split(";", 1)[0] ?? "";

    const headers = { cookie, "x-csrf-token": csrfToken };
    const healthLatency: number[] = [];
    const meLatency: number[] = [];
    const projectsLatency: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const health = await fetchWithTimeout(`${baseUrl}/health`);
      healthLatency.push(health.elapsedMs);
      if (!health.response.ok) throw new Error(`health QA가 ${health.response.status}를 반환했습니다.`);
      await discard(health.response);

      const me = await fetchWithTimeout(`${baseUrl}/api/auth/me`, { headers });
      meLatency.push(me.elapsedMs);
      const meBody = await me.response.json() as { user?: JsonObject };
      if (me.response.status !== 200 || meBody.user?.role !== "user" || meBody.user?.access_scope !== "test_only") {
        throw new Error(`auth/me QA가 기대 상태가 아닙니다(status=${me.response.status}).`);
      }

      const projects = await fetchWithTimeout(`${baseUrl}/api/projects`, { headers });
      projectsLatency.push(projects.elapsedMs);
      if (projects.response.status !== 200) throw new Error(`projects read QA가 ${projects.response.status}를 반환했습니다.`);
      await discard(projects.response);
    }

    const forbiddenCases: Array<[string, string]> = [
      ["POST", "/api/projects"],
      ["POST", "/api/chats/999999999/messages"],
      ["PUT", "/api/admin/webhook-settings"],
    ];
    for (const [method, pathname] of forbiddenCases) {
      const blocked = await fetchWithTimeout(`${baseUrl}${pathname}`, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      const body = await blocked.response.json() as { error?: string };
      if (blocked.response.status !== 403 || body.error !== "테스트 전용 계정은 테스트 기능만 실행할 수 있습니다.") {
        throw new Error(`${method} ${pathname}가 test_only 정책으로 차단되지 않았습니다.`);
      }
    }

    // 허용 경로가 전역 test_only 차단을 통과하는지만 검사한다. Idempotency-Key를 일부러 생략해
    // verification runner나 provider를 실제 실행하기 전에 route validation(400)에서 멈춘다.
    const allowedProbe = await fetchWithTimeout(`${baseUrl}/api/tasks/__qa_missing_task__/verifications`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    await discard(allowedProbe.response);
    if (allowedProbe.response.status !== 400) {
      throw new Error(`허용된 verification 경로의 무부작용 probe가 400 대신 ${allowedProbe.response.status}를 반환했습니다.`);
    }

    const summary = {
      loginMs: login.elapsedMs,
      samples: 20,
      healthMs: { p50: percentile(healthLatency, 0.5), p95: percentile(healthLatency, 0.95), max: Math.max(...healthLatency) },
      authMeMs: { p50: percentile(meLatency, 0.5), p95: percentile(meLatency, 0.95), max: Math.max(...meLatency) },
      projectsMs: { p50: percentile(projectsLatency, 0.5), p95: percentile(projectsLatency, 0.95), max: Math.max(...projectsLatency) },
      forbiddenMutations: forbiddenCases.length,
      allowedVerificationRouteProbe: 400,
    };
    if (summary.healthMs.p95 > 500 || summary.authMeMs.p95 > 750 || summary.projectsMs.p95 > 1_500) {
      throw new Error(`loopback 응답시간 기준을 초과했습니다(health/auth/projects p95=${summary.healthMs.p95}/${summary.authMeMs.p95}/${summary.projectsMs.p95}ms).`);
    }
    return summary;
  } finally {
    if (cookie && csrfToken) {
      try {
        const logout = await fetchWithTimeout(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie, "x-csrf-token": csrfToken } });
        await discard(logout.response);
        if (logout.response.status !== 204) throw new Error(`logout status=${logout.response.status}`);
      } catch { /* 결과에 credential/session 값을 남기지 않고 DB 검사에서 잔여 세션을 잡는다. */ }
    }
  }
}

function verifyTesterAndLogout(): JsonObject {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    const tester = database.prepare("SELECT id, role, access_scope, temporary_expires_at FROM users WHERE username = ?").get(username) as {
      id: number; role: string; access_scope: string; temporary_expires_at: string | null;
    } | undefined;
    if (!tester || tester.role !== "user" || tester.access_scope !== "test_only" || tester.temporary_expires_at !== null) {
      throw new Error("운영 DB의 tester role/scope가 기대값과 다릅니다.");
    }
    const activeSessions = Number((database.prepare("SELECT COUNT(*) AS count FROM web_sessions WHERE user_id = ? AND expires_at > datetime('now')").get(tester.id) as { count: number }).count);
    if (activeSessions !== 0) throw new Error("실제 QA 뒤 tester web session이 정리되지 않았습니다.");
    return { role: tester.role, accessScope: tester.access_scope, activeSessions };
  } finally {
    database.close();
  }
}

async function main(): Promise<void> {
  if (!path.isAbsolute(passwordFile) || !path.isAbsolute(backupFile)) throw new Error("secret/backup path는 absolute여야 합니다.");
  if (!/^[a-f0-9]{64}$/.test(expectedBackupSha256)) throw new Error("승인된 backup SHA-256이 올바르지 않습니다.");
  if (!Number.isSafeInteger(expectedOldPid) || expectedOldPid < 2) throw new Error("승인된 server PID가 올바르지 않습니다.");
  if (!/^[^\s\x00-\x1f]{2,64}$/.test(username)) throw new Error("tester username이 올바르지 않습니다.");
  new URL(baseUrl);

  // 시작 시 secret 계약만 확인하며 값은 결과·로그에 넣지 않는다.
  readSecretInput({ valueEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE", fileEnvironment: "WEB_AGENT_MANAGER_BACKUP_PASSPHRASE_FILE", label: "백업 passphrase", minimumLength: 16, maximumLength: 1024 });
  readSecretInput({ valueEnvironment: "WEB_AGENT_MANAGER_TEST_PASSWORD", fileEnvironment: "WEB_AGENT_MANAGER_TEST_PASSWORD_FILE", label: "테스트 계정 비밀번호", minimumLength: 12, maximumLength: 256 });
  if (sha256OwnerOnlyFile(backupFile) !== expectedBackupSha256) throw new Error("승인된 backup SHA-256이 변경됐습니다.");
  step("inputs_validated");

  await waitForIdle();
  step("workload_idle");
  if (sha256OwnerOnlyFile(backupFile) !== expectedBackupSha256) throw new Error("idle 대기 중 backup이 변경됐습니다.");
  const finalReadiness = readiness();
  if (!finalReadiness.workloadSafeForRestart || finalReadiness.server.pid !== expectedOldPid) throw new Error("재시작 직전 readiness가 변경됐습니다.");
  step("restart_requested", "restarting");
  process.kill(expectedOldPid, "SIGTERM");

  const newPid = await waitForNewServer();
  result.server = { oldPid: expectedOldPid, newPid };
  step("new_server_healthy");
  verifyMigratedSchema();
  step("schema_migrated");

  createTester();
  step("tester_created", "qa");
  result.qa = await actualQa();
  step("http_qa_passed");
  result.qa = { ...result.qa, tester: verifyTesterAndLogout() };
  step("tester_session_cleaned");
  result.status = "passed";
  step("completed");
}

main().catch((error) => {
  result.status = "failed";
  result.error = safeError(error);
  try { writeResult(); } catch { /* stdout에도 secret은 쓰지 않는다. */ }
  process.stderr.write(`approved deployment failed: ${result.error}\n`);
  process.exitCode = 1;
});
