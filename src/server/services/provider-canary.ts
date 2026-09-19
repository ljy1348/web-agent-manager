import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppDatabase } from "../core/database";
import type { ProviderAdapter } from "../providers/provider";
import type { Provider } from "../../shared/types";
import type { ProviderCapabilities } from "../../shared/provider-runtime";
import { capabilitiesForAdapter } from "./provider-capabilities";

const SUITE_VERSION = "provider-cli-v1";
const OUTPUT_LIMIT = 64 * 1024;
export const PROVIDER_CANARY_STEPS = [
  "login", "new_session", "resume", "idle_input", "follow_up", "approval", "interrupt", "completion", "rate_limit_sample", "usage_read",
] as const;
export type ProviderCanaryStepName = typeof PROVIDER_CANARY_STEPS[number];

export interface ProviderCanaryProbeInput {
  provider: Provider;
  step: ProviderCanaryStepName;
  expectedVersion: string;
  homeDir: string;
  workspaceDir: string;
  timeoutMs: number;
  candidateCommand?: string;
}

export interface ProviderCanaryProbeResult {
  state: "passed" | "failed" | "blocked";
  reportedVersion: string | null;
  evidence?: { code?: string; sessionObserved?: boolean; eventObserved?: boolean };
  capabilities?: Partial<ProviderCapabilities>;
  candidateSha256?: string;
}

export type ProviderCanaryRunner = (input: ProviderCanaryProbeInput) => Promise<ProviderCanaryProbeResult>;

const CAPABILITY_FIELDS = [
  "transport", "structuredSession", "deliveryAcknowledgement", "queueAcknowledgement", "sessionEvents", "turnEvents",
  "approvalEvents", "toolEvents", "usageEvents", "interrupt", "resume", "evidencePriority", "fallbackReasons",
] as const;

function safeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 && !/[\r\n\0]/.test(trimmed) ? trimmed : null;
}

function safeEvidence(value: ProviderCanaryProbeResult["evidence"]): Record<string, unknown> {
  const code = typeof value?.code === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value.code) ? value.code : undefined;
  return {
    ...(code ? { code } : {}),
    ...(typeof value?.sessionObserved === "boolean" ? { sessionObserved: value.sessionObserved } : {}),
    ...(typeof value?.eventObserved === "boolean" ? { eventObserved: value.eventObserved } : {}),
  };
}

function safeCapabilities(provider: Provider, version: string, value: Partial<ProviderCapabilities>): Record<string, unknown> {
  const result: Record<string, unknown> = { schemaVersion: 1, provider, cliVersion: version };
  for (const field of CAPABILITY_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "boolean" || typeof candidate === "string") result[field] = candidate;
    else if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")) result[field] = candidate.slice(0, 30);
  }
  return result;
}

function isProbeState(value: unknown): value is ProviderCanaryProbeResult["state"] {
  return value === "passed" || value === "failed" || value === "blocked";
}

function hasMinimumCapabilities(value: Record<string, unknown>): boolean {
  return typeof value.transport === "string"
    && typeof value.structuredSession === "boolean"
    && typeof value.interrupt === "boolean"
    && typeof value.resume === "boolean";
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function assertPrivateDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label}은 symlink가 아닌 소유자 전용 디렉터리여야 합니다.`);
  }
}

function copyPrivateSeed(sourceRoot: string, targetRoot: string): void {
  let totalBytes = 0;
  const copyDirectory = (source: string, target: string): void => {
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("canary credential seed에 허용되지 않은 경로가 있습니다.");
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      const from = path.join(source, entry);
      const to = path.join(target, entry);
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) throw new Error("canary credential seed에는 symlink를 사용할 수 없습니다.");
      if (stat.isDirectory()) copyDirectory(from, to);
      else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > 10 * 1024 * 1024) throw new Error("canary credential seed가 10MiB 제한을 넘었습니다.");
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(to, 0o600);
      } else throw new Error("canary credential seed에는 일반 파일과 디렉터리만 사용할 수 있습니다.");
    }
  };
  copyDirectory(sourceRoot, targetRoot);
}

export function diffProviderCapabilities(before: Record<string, unknown>, candidate: Record<string, unknown>): Array<Record<string, unknown>> {
  const diff: Array<Record<string, unknown>> = [];
  for (const field of CAPABILITY_FIELDS) {
    const previous = before[field];
    const next = candidate[field];
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    diff.push({ field, before: previous ?? null, after: next ?? null, change: previous === undefined ? "added" : next === undefined ? "removed" : "changed" });
  }
  return diff;
}

// 고정된 harness argv만 shell 없이 실행한다. 요청 본문은 command/argv를 제공할 수 없다.
export function createProcessProviderCanaryRunner(command: string, args: string[] = []): ProviderCanaryRunner {
  return (input) => new Promise((resolve, reject) => {
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: input.homeDir,
      TMPDIR: path.join(input.homeDir, "tmp"),
      XDG_CONFIG_HOME: path.join(input.homeDir, ".config"),
      CODEX_HOME: path.join(input.homeDir, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(input.homeDir, ".claude"),
      GROK_HOME: path.join(input.homeDir, ".grok"),
      WAM_CANARY_PROVIDER: input.provider,
      WAM_CANARY_STEP: input.step,
      WAM_CANARY_EXPECTED_VERSION: input.expectedVersion,
      WAM_CANARY_TIMEOUT_MS: String(input.timeoutMs),
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    if (input.candidateCommand) environment.WAM_CANARY_CANDIDATE_COMMAND = input.candidateCommand;
    for (const directory of [environment.TMPDIR, environment.XDG_CONFIG_HOME, environment.CODEX_HOME, environment.CLAUDE_CONFIG_DIR, environment.GROK_HOME]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const child = spawn(command, args, { cwd: input.workspaceDir, shell: false, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let forceTimer: NodeJS.Timeout | undefined;
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    }, input.timeoutMs);
    timer.unref();
    child.once("error", (error) => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (code !== 0) { resolve({ state: "failed", reportedVersion: null, evidence: { code: stderr ? "harness_stderr" : "harness_exit" } }); return; }
      try {
        const parsed = JSON.parse(stdout) as ProviderCanaryProbeResult;
        resolve(parsed);
      } catch { resolve({ state: "blocked", reportedVersion: null, evidence: { code: "harness_invalid_json" } }); }
    });
  });
}

// 운영에서 실제 공급자별 harness를 연결하는 opt-in 경로다. harness/credential 위치는 서버 시작 환경만
// 정하며 HTTP 입력은 실행 파일이나 credential 경로로 사용되지 않는다.
export function createConfiguredProviderCanaryRunner(harnessRootInput: string, credentialsRootInput?: string, candidateRootInput?: string): ProviderCanaryRunner {
  const harnessRoot = path.resolve(harnessRootInput);
  assertPrivateDirectory(harnessRoot, "canary harness root");
  const credentialsRoot = credentialsRootInput ? path.resolve(credentialsRootInput) : undefined;
  if (credentialsRoot) assertPrivateDirectory(credentialsRoot, "canary credential root");
  const candidateRoot = candidateRootInput ? path.resolve(candidateRootInput) : undefined;
  if (candidateRoot) {
    const stat = fs.lstatSync(candidateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error("candidate CLI root가 안전한 디렉터리가 아닙니다.");
  }
  const runners = new Map<Provider, ProviderCanaryRunner>();
  for (const provider of ["codex", "claude", "grok"] as const) {
    const command = path.join(harnessRoot, provider);
    if (path.dirname(path.resolve(command)) !== harnessRoot) throw new Error("canary harness 경로가 root를 벗어났습니다.");
    if (!fs.existsSync(command)) continue;
    const stat = fs.lstatSync(command);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${provider} canary harness가 안전한 일반 파일이 아닙니다.`);
    fs.accessSync(command, fs.constants.X_OK);
    runners.set(provider, createProcessProviderCanaryRunner(command));
  }
  return async (input) => {
    const runner = runners.get(input.provider);
    if (!runner) return { state: "blocked", reportedVersion: null, evidence: { code: "candidate_harness_unavailable" } };
    if (credentialsRoot) {
      const seed = path.join(credentialsRoot, input.provider);
      const marker = path.join(input.homeDir, ".wam-canary-seeded");
      if (!fs.existsSync(marker)) {
        assertPrivateDirectory(seed, `${input.provider} canary credential seed`);
        copyPrivateSeed(seed, input.homeDir);
        fs.writeFileSync(marker, "seeded\n", { mode: 0o600, flag: "wx" });
      }
    }
    let candidateCommand: string | undefined;
    if (candidateRoot) {
      candidateCommand = path.join(candidateRoot, input.provider);
      const stat = fs.lstatSync(candidateCommand);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error(`${input.provider} candidate CLI가 안전한 일반 파일이 아닙니다.`);
      fs.accessSync(candidateCommand, fs.constants.X_OK);
    }
    const hashBefore = candidateCommand ? crypto.createHash("sha256").update(fs.readFileSync(candidateCommand)).digest("hex") : undefined;
    const result = await runner({ ...input, candidateCommand });
    const hashAfter = candidateCommand ? crypto.createHash("sha256").update(fs.readFileSync(candidateCommand)).digest("hex") : undefined;
    if (hashBefore && hashAfter && hashBefore !== hashAfter) {
      return { state: "blocked", reportedVersion: result.reportedVersion, evidence: { code: "candidate_binary_changed" }, candidateSha256: hashAfter };
    }
    return { ...result, candidateSha256: hashAfter };
  };
}

export class ProviderCanaryService {
  constructor(
    private readonly database: AppDatabase,
    private readonly dataDir: string,
    private readonly runner: ProviderCanaryRunner = async () => ({ state: "blocked", reportedVersion: null, evidence: { code: "candidate_harness_unavailable" } }),
    private readonly stepTimeoutMs = 30_000,
  ) {}

  async run(input: {
    provider: Provider;
    adapter: ProviderAdapter;
    currentVersion: string | null;
    candidateVersion: string;
    idempotencyKey: string;
    userId: number;
    accountId?: number | null;
  }): Promise<Record<string, unknown>> {
    const candidateVersion = safeVersion(input.candidateVersion);
    if (!candidateVersion) throw new Error("후보 CLI 버전이 올바르지 않습니다.");
    if (!input.idempotencyKey || input.idempotencyKey.length > 200 || /[\r\n\0]/.test(input.idempotencyKey)) {
      throw new Error("유효한 멱등 키가 필요합니다.");
    }
    const existing = this.database.prepare("SELECT id, candidate_version FROM provider_canary_runs WHERE provider = ? AND idempotency_key = ?")
      .get(input.provider, input.idempotencyKey) as { id: string; candidate_version: string } | undefined;
    if (existing) {
      if (existing.candidate_version !== candidateVersion) throw Object.assign(new Error("멱등 키가 다른 후보 버전에 사용되었습니다."), { statusCode: 409 });
      return this.get(existing.id);
    }
    const runId = crypto.randomUUID();
    const currentCapabilities = capabilitiesForAdapter(input.adapter, input.currentVersion);
    const root = path.join(this.dataDir, "provider-canaries", runId);
    const homeDir = path.join(root, "home");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO provider_canary_runs(id, provider, account_id, idempotency_key, suite_version, current_version, candidate_version, state, current_capabilities_json, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(runId, input.provider, input.accountId ?? null, input.idempotencyKey, SUITE_VERSION, input.currentVersion, candidateVersion, JSON.stringify(currentCapabilities), input.userId);
      const insert = this.database.prepare("INSERT INTO provider_canary_steps(id, run_id, ordinal, name) VALUES (?, ?, ?, ?)");
      PROVIDER_CANARY_STEPS.forEach((name, index) => insert.run(crypto.randomUUID(), runId, index + 1, name));
    })();
    this.database.prepare("UPDATE provider_canary_runs SET state = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(runId);

    let finalState: "passed" | "failed" | "blocked" = "passed";
    let reason = "canary_passed";
    let reportedVersion: string | null = null;
    let candidateCapabilities: Record<string, unknown> | null = null;
    let candidateSha256: string | null = null;
    try {
      for (let index = 0; index < PROVIDER_CANARY_STEPS.length; index += 1) {
        const name = PROVIDER_CANARY_STEPS[index]!;
        const step = this.database.prepare("SELECT id FROM provider_canary_steps WHERE run_id = ? AND ordinal = ?").get(runId, index + 1) as { id: string };
        this.database.prepare("UPDATE provider_canary_steps SET state = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?").run(step.id);
        const started = Date.now();
        let result: ProviderCanaryProbeResult;
        try { result = await this.runner({ provider: input.provider, step: name, expectedVersion: candidateVersion, homeDir, workspaceDir, timeoutMs: this.stepTimeoutMs }); }
        catch { result = { state: "blocked", reportedVersion: null, evidence: { code: "candidate_harness_error" } }; }
        const actualVersion = safeVersion(result.reportedVersion);
        const evidence = safeEvidence(result.evidence);
        let state: ProviderCanaryProbeResult["state"] = isProbeState(result.state) ? result.state : "blocked";
        if (!isProbeState(result.state)) evidence.code = "harness_invalid_state";
        if (!actualVersion && state === "passed") {
          state = "blocked";
          evidence.code = "candidate_version_unreported";
        } else if (actualVersion && actualVersion !== candidateVersion) {
          state = "blocked";
          evidence.code = "candidate_version_mismatch";
        }
        if (reportedVersion && actualVersion && reportedVersion !== actualVersion) {
          state = "blocked";
          evidence.code = "candidate_version_changed_during_suite";
        }
        if (actualVersion) reportedVersion = actualVersion;
        const actualSha256 = typeof result.candidateSha256 === "string" && /^[0-9a-f]{64}$/.test(result.candidateSha256) ? result.candidateSha256 : null;
        if (candidateSha256 && actualSha256 && candidateSha256 !== actualSha256) {
          state = "blocked";
          evidence.code = "candidate_binary_changed_during_suite";
        }
        if (actualSha256) candidateSha256 = actualSha256;
        if (result.capabilities) {
          const safeCandidate = safeCapabilities(input.provider, candidateVersion, result.capabilities);
          if (hasMinimumCapabilities(safeCandidate)) candidateCapabilities = safeCandidate;
          else {
            state = "blocked";
            evidence.code = "candidate_capabilities_incomplete";
          }
        }
        this.database.prepare("UPDATE provider_canary_steps SET state = ?, evidence_json = ?, duration_ms = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(state, JSON.stringify(evidence), Date.now() - started, step.id);
        if (state !== "passed") {
          finalState = state === "failed" ? "failed" : "blocked";
          reason = String(evidence.code ?? (state === "failed" ? "canary_step_failed" : "canary_step_blocked"));
          this.database.prepare("UPDATE provider_canary_steps SET state = 'skipped', finished_at = CURRENT_TIMESTAMP WHERE run_id = ? AND state = 'pending'").run(runId);
          break;
        }
      }
      if (finalState === "passed" && !candidateCapabilities) {
        finalState = "blocked";
        reason = "candidate_capabilities_unreported";
      }
      const diff = candidateCapabilities ? diffProviderCapabilities(currentCapabilities as unknown as Record<string, unknown>, candidateCapabilities) : [];
      this.database.prepare(`
        UPDATE provider_canary_runs SET state = ?, reported_version = ?, candidate_sha256 = ?, candidate_capabilities_json = ?, capability_diff_json = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(finalState, reportedVersion, candidateSha256, candidateCapabilities ? JSON.stringify(candidateCapabilities) : null, JSON.stringify(diff), JSON.stringify({ reason, isolatedHome: true, isolatedWorkspace: true }), runId);
    } finally {
      if (path.dirname(path.resolve(root)) === path.resolve(this.dataDir, "provider-canaries")) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 완료 원장은 임시 디렉터리 정리 실패와 분리한다. */ }
      }
    }
    return this.get(runId);
  }

  recoverInterruptedRuns(): number {
    const result = this.database.prepare("UPDATE provider_canary_runs SET state = 'blocked', summary_json = '{\"reason\":\"server_restart_reconciliation_required\"}', finished_at = CURRENT_TIMESTAMP WHERE state IN ('pending', 'running')").run();
    this.database.prepare("UPDATE provider_canary_steps SET state = 'blocked', evidence_json = '{\"code\":\"server_restart_reconciliation_required\"}', finished_at = CURRENT_TIMESTAMP WHERE state IN ('pending', 'running')").run();
    return result.changes;
  }

  authorizeUpdate(provider: Provider, runId: string, currentVersion: string | null): { canaryRunId: string; candidateVersion: string; candidateSha256: string | null } {
    const row = this.database.prepare(`
      SELECT id, current_version, candidate_version, candidate_sha256, reported_version, state,
             finished_at >= datetime('now', '-24 hours') AS fresh,
             (SELECT COUNT(*) FROM provider_canary_steps WHERE run_id = provider_canary_runs.id AND state = 'passed') AS passed_steps,
             (SELECT COUNT(*) FROM provider_canary_steps WHERE run_id = provider_canary_runs.id) AS total_steps
      FROM provider_canary_runs WHERE id = ? AND provider = ?
    `).get(runId, provider) as {
      id: string;
      current_version: string | null;
      candidate_version: string;
      candidate_sha256: string | null;
      reported_version: string | null;
      state: string;
      fresh: number;
      passed_steps: number;
      total_steps: number;
    } | undefined;
    if (!row) throw Object.assign(new Error("이 공급자의 canary 실행을 찾을 수 없습니다."), { statusCode: 404 });
    if (row.state !== "passed" || !row.fresh || row.candidate_version !== row.reported_version
      || row.current_version !== currentVersion || row.passed_steps !== PROVIDER_CANARY_STEPS.length || row.total_steps !== PROVIDER_CANARY_STEPS.length) {
      throw Object.assign(new Error("현재 버전에 대해 최근 24시간 내 전체 통과한 canary가 필요합니다."), { statusCode: 409 });
    }
    return { canaryRunId: row.id, candidateVersion: row.candidate_version, candidateSha256: row.candidate_sha256 };
  }

  list(provider?: Provider, limit = 20): Record<string, unknown>[] {
    const rows = provider
      ? this.database.prepare("SELECT id FROM provider_canary_runs WHERE provider = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(provider, Math.min(100, Math.max(1, limit)))
      : this.database.prepare("SELECT id FROM provider_canary_runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(Math.min(100, Math.max(1, limit)));
    return (rows as Array<{ id: string }>).map((row) => this.get(row.id));
  }

  latest(): Record<string, unknown>[] {
    const rows = this.database.prepare(`
      SELECT id FROM provider_canary_runs r WHERE rowid = (
        SELECT newer.rowid FROM provider_canary_runs newer WHERE newer.provider = r.provider ORDER BY newer.created_at DESC, newer.rowid DESC LIMIT 1
      ) ORDER BY provider
    `).all() as Array<{ id: string }>;
    return rows.map((row) => this.get(row.id));
  }

  get(runId: string): Record<string, unknown> {
    const run = this.database.prepare(`
      SELECT id, provider, account_id, suite_version, current_version, candidate_version, candidate_sha256, reported_version, state,
             current_capabilities_json, candidate_capabilities_json, capability_diff_json, summary_json,
             created_by, started_at, finished_at, created_at FROM provider_canary_runs WHERE id = ?
    `).get(runId) as Record<string, unknown> | undefined;
    if (!run) throw Object.assign(new Error("canary 실행을 찾을 수 없습니다."), { statusCode: 404 });
    const steps = this.database.prepare(`
      SELECT ordinal, name, state, evidence_json, duration_ms, started_at, finished_at
      FROM provider_canary_steps WHERE run_id = ? ORDER BY ordinal
    `).all(runId);
    return {
      run: {
        id: run.id,
        provider: run.provider,
        accountId: run.account_id,
        suiteVersion: run.suite_version,
        currentVersion: run.current_version,
        candidateVersion: run.candidate_version,
        candidateSha256: run.candidate_sha256,
        reportedVersion: run.reported_version,
        state: run.state,
        currentCapabilities: parseJson(run.current_capabilities_json, {}),
        candidateCapabilities: parseJson(run.candidate_capabilities_json, null),
        capabilityDiff: parseJson(run.capability_diff_json, []),
        summary: parseJson(run.summary_json, {}),
        createdBy: run.created_by,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        createdAt: run.created_at,
      },
      steps: (steps as Array<Record<string, unknown>>).map((step) => ({
        ordinal: step.ordinal,
        name: step.name,
        state: step.state,
        evidence: parseJson(step.evidence_json, {}),
        durationMs: step.duration_ms,
        startedAt: step.started_at,
        finishedAt: step.finished_at,
      })),
    };
  }
}
