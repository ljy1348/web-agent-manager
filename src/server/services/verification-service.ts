import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AppDatabase } from "../core/database";

const OUTPUT_LIMIT = 1024 * 1024;
const AUTOMATED_KINDS = new Set(["static", "focused_test", "full_test", "build", "ui", "contract"]);
const VALID_KINDS = new Set([...AUTOMATED_KINDS, "live", "human_review"]);

export interface VerificationExecutorResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  durationMs: number;
}

export type VerificationExecutor = (argv: string[], cwd: string, timeoutMs: number) => Promise<VerificationExecutorResult>;
export interface WorkspaceVerificationSnapshot { commitHash: string; diffHash: string; changedFiles?: string[]; clean?: boolean }
export type WorkspaceSnapshotter = (cwd: string) => Promise<WorkspaceVerificationSnapshot> | WorkspaceVerificationSnapshot;

export interface PullRequestCheckSnapshot {
  number: number;
  headSha: string;
  state: "passed" | "failed" | "pending" | "unavailable";
  totalCount: number;
  passedCount: number;
  failedCount: number;
  pendingCount: number;
  unavailableCount: number;
}

export type PullRequestCheckReader = (cwd: string, pullRequestNumber: number) => Promise<PullRequestCheckSnapshot>;

interface RecipeStep {
  ordinal: number;
  kind: string;
  argv: string[];
  timeoutMs: number;
  required: boolean;
  includePaths?: string[];
  excludePaths?: string[];
}

interface RecipeSelection {
  selected: RecipeStep[];
  summary: {
    changedFileCount: number;
    selected: Array<{ ordinal: number; kind: string; reason: string }>;
    skipped: Array<{ ordinal: number; kind: string; reason: string }>;
  };
  error?: string;
}

function defaultExecutor(argv: string[], cwd: string, timeoutMs: number): Promise<VerificationExecutorResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const allowedEnvironment = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "NODE_ENV", "CI"];
    const environment = Object.fromEntries(allowedEnvironment.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

export function classifyPullRequestCheckRollup(number: number, headSha: string, value: unknown): PullRequestCheckSnapshot {
  const rows = Array.isArray(value) ? value : [];
  let passedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let unavailableCount = 0;
  for (const value of rows) {
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const status = String(row.status ?? "").toUpperCase();
    const conclusion = String(row.conclusion ?? "").toUpperCase();
    const state = String(row.state ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(conclusion || state)) failedCount += 1;
    else if (state === "SUCCESS" || (status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion))) passedCount += 1;
    else if (["PENDING", "EXPECTED"].includes(state) || (status && status !== "COMPLETED") || (status === "COMPLETED" && !conclusion)) pendingCount += 1;
    else unavailableCount += 1;
  }
  const totalCount = rows.length;
  const state = failedCount > 0
    ? "failed"
    : pendingCount > 0
      ? "pending"
      : !totalCount || unavailableCount > 0
        ? "unavailable"
        : passedCount === totalCount
          ? "passed"
          : "unavailable";
  return { number, headSha, state, totalCount, passedCount, failedCount, pendingCount, unavailableCount };
}

// GitHub에는 쓰지 않고 PR head와 check rollup만 읽는다. check 이름·URL·본문은 원장에 복제하지 않는다.
export function readPullRequestChecks(cwd: string, pullRequestNumber: number): Promise<PullRequestCheckSnapshot> {
  return new Promise((resolve, reject) => {
    const allowedEnvironment = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "GH_HOST", "GH_CONFIG_DIR"];
    const environment = Object.fromEntries(allowedEnvironment.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
    const child = spawn("gh", ["pr", "view", String(pullRequestNumber), "--json", "number,headRefOid,statusCheckRollup"], {
      cwd, shell: false, env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string => (current + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    }, 30_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (code !== 0) { reject(new Error(stderr.trim() || "GitHub PR check를 읽지 못했습니다.")); return; }
      try {
        const payload = JSON.parse(stdout) as Record<string, unknown>;
        const number = Number(payload.number);
        const headSha = String(payload.headRefOid ?? "");
        if (number !== pullRequestNumber || !/^[0-9a-f]{40,64}$/i.test(headSha)) throw new Error("GitHub PR check 응답이 올바르지 않습니다.");
        resolve(classifyPullRequestCheckRollup(number, headSha, payload.statusCheckRollup));
      } catch (error) { reject(error); }
    });
  });
}

export function snapshotGitWorkspace(cwd: string): WorkspaceVerificationSnapshot {
  const runGit = (args: string[]): string => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("검증 작업공간의 Git snapshot을 만들 수 없습니다.");
    return result.stdout;
  };
  const commitHash = runGit(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commitHash)) throw new Error("검증 작업공간의 commit hash가 올바르지 않습니다.");
  const diff = runGit(["diff", "--binary", "HEAD", "--", "."]);
  const status = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const trackedChanged = runGit(["diff", "--name-only", "-z", "HEAD", "--", "."]).split("\0").filter(Boolean);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  if (untracked.length > 10_000) throw new Error("검증 snapshot의 untracked 파일이 너무 많습니다.");
  const digest = crypto.createHash("sha256").update(commitHash).update("\0").update(diff).update("\0").update(status);
  for (const relative of untracked.sort()) {
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error("검증 snapshot 파일 경로가 올바르지 않습니다.");
    digest.update("\0").update(relative).update("\0").update(runGit(["hash-object", "--", relative]).trim());
  }
  const changedFiles = [...new Set([...trackedChanged, ...untracked])].map((relative) => relative.replaceAll(path.sep, "/")).sort();
  return { commitHash, diffHash: digest.digest("hex"), changedFiles, clean: status.length === 0 };
}

function pullRequestChecksRequired(snapshot: unknown): boolean {
  const config = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
  const verification = config.verification && typeof config.verification === "object" ? config.verification as Record<string, unknown> : {};
  const policy = verification.pullRequestChecks && typeof verification.pullRequestChecks === "object" ? verification.pullRequestChecks as Record<string, unknown> : {};
  return policy.required === true;
}

export function redactVerificationOutput(value: string, homeDir: string): { text: string; status: "safe" | "blocked" } {
  let text = value.slice(0, OUTPUT_LIMIT);
  let blocked = false;
  text = text.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, () => {
    blocked = true;
    return "[REDACTED PRIVATE KEY]";
  });
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]");
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED CREDENTIAL]");
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  text = text.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|set-cookie)\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]");
  text = text.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|KEY))=([^\s]+)/g, "$1=[REDACTED]");
  if (homeDir) text = text.replaceAll(homeDir, "$HOME");
  const stillSensitive = /authorization\s*[:=]\s*bearer\s+(?!\[REDACTED\])/i.test(text)
    || /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|KEY)=(?!\[REDACTED\])/i.test(text);
  return { text, status: blocked || stillSensitive ? "blocked" : "safe" };
}

function recipeFromSnapshot(snapshot: unknown): RecipeStep[] {
  const config = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : {};
  const verification = config.verification && typeof config.verification === "object" ? config.verification as Record<string, unknown> : {};
  const rows = Array.isArray(verification.steps) ? verification.steps : [];
  return rows.map((row, index) => {
    if (!row || typeof row !== "object") throw new Error(`검증 단계 ${index + 1}이 올바르지 않습니다.`);
    const step = row as Record<string, unknown>;
    const kind = String(step.kind ?? "");
    if (!VALID_KINDS.has(kind)) throw new Error(`지원하지 않는 검증 종류입니다: ${kind}`);
    let argv: string[] = [];
    if (Array.isArray(step.argv) && step.argv.every((value) => typeof value === "string" && value.length > 0)) argv = step.argv as string[];
    else if (typeof step.command === "string" && !/[;&|<>`$\n\r]/.test(step.command)) argv = step.command.trim().split(/\s+/).filter(Boolean);
    if (AUTOMATED_KINDS.has(kind) && !argv.length) throw new Error(`검증 단계 ${index + 1}에 안전한 argv가 필요합니다.`);
    const timeoutMs = Number(step.timeoutMs ?? 10 * 60_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) throw new Error("검증 timeout 범위가 올바르지 않습니다.");
    const parsePatterns = (key: "includePaths" | "excludePaths"): string[] | undefined => {
      if (step[key] === undefined) return undefined;
      if (!Array.isArray(step[key]) || !step[key].length || step[key].length > 100) throw new Error(`검증 단계 ${index + 1}의 ${key}가 올바르지 않습니다.`);
      return (step[key] as unknown[]).map((value) => {
        if (typeof value !== "string" || !value.length || value.length > 200 || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || value.split("/").includes("..")) {
          throw new Error(`검증 단계 ${index + 1}의 ${key} 경로 패턴이 올바르지 않습니다.`);
        }
        return value;
      });
    };
    return { ordinal: index + 1, kind, argv, timeoutMs, required: step.required !== false, includePaths: parsePatterns("includePaths"), excludePaths: parsePatterns("excludePaths") };
  });
}

function pathPatternMatches(pattern: string, relativePath: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(relativePath);
}

function selectRecipe(recipe: RecipeStep[], changedFiles: string[] | undefined): RecipeSelection {
  const hasConditionalSteps = recipe.some((step) => step.includePaths || step.excludePaths);
  if (hasConditionalSteps && !changedFiles) {
    return { selected: [], summary: { changedFileCount: 0, selected: [], skipped: [] }, error: "workspace_changed_files_unavailable" };
  }
  const files = changedFiles ?? [];
  const selected: RecipeStep[] = [];
  const summary: RecipeSelection["summary"] = { changedFileCount: files.length, selected: [], skipped: [] };
  for (const step of recipe) {
    if (!step.includePaths && !step.excludePaths) {
      selected.push(step);
      summary.selected.push({ ordinal: step.ordinal, kind: step.kind, reason: "unconditional" });
      continue;
    }
    const matching = files.filter((file) => {
      const included = !step.includePaths || step.includePaths.some((pattern) => pathPatternMatches(pattern, file));
      const excluded = step.excludePaths?.some((pattern) => pathPatternMatches(pattern, file)) ?? false;
      return included && !excluded;
    });
    if (matching.length) {
      selected.push(step);
      summary.selected.push({ ordinal: step.ordinal, kind: step.kind, reason: "changed_path_matched" });
    } else {
      summary.skipped.push({ ordinal: step.ordinal, kind: step.kind, reason: files.length ? "no_changed_path_matched" : "no_changed_files" });
    }
  }
  return { selected, summary };
}

export class VerificationService {
  constructor(
    private readonly database: AppDatabase,
    private readonly dataDir: string,
    private readonly homeDir: string,
    private readonly executor: VerificationExecutor = defaultExecutor,
    private readonly snapshotter: WorkspaceSnapshotter = snapshotGitWorkspace,
    private readonly retentionDays = 30,
    private readonly pullRequestReader: PullRequestCheckReader = readPullRequestChecks,
  ) {}

  async run(taskId: string, idempotencyKey: string, userId: number | null, options: { pullRequestNumber?: number } = {}): Promise<Record<string, unknown>> {
    if (options.pullRequestNumber !== undefined && (!Number.isSafeInteger(options.pullRequestNumber) || options.pullRequestNumber < 1)) throw new Error("PR 번호가 올바르지 않습니다.");
    const existing = this.database.prepare("SELECT id, pull_request_number FROM verification_runs WHERE task_id = ? AND idempotency_key = ?").get(taskId, idempotencyKey) as { id: string; pull_request_number: number | null } | undefined;
    if (existing) {
      if ((existing.pull_request_number ?? undefined) !== options.pullRequestNumber) throw Object.assign(new Error("멱등 키가 다른 PR 검증 요청에 사용되었습니다."), { statusCode: 409 });
      return this.getRun(existing.id);
    }
    return this.createRun(taskId, idempotencyKey, userId, { trigger: "manual", allowTerminalTask: false, pullRequestNumber: options.pullRequestNumber });
  }

  async rerun(sourceRunId: string, idempotencyKey: string, userId: number): Promise<Record<string, unknown>> {
    const source = this.database.prepare(`
      SELECT r.task_id, r.profile_version_id, r.state, r.commit_hash, r.diff_hash, r.pull_request_number,
             c.worktree_path, p.path AS project_path, t.profile_version_id AS task_profile_version_id
      FROM verification_runs r JOIN agent_tasks t ON t.id = r.task_id JOIN chats c ON c.id = t.chat_id
      JOIN projects p ON p.id = t.project_id WHERE r.id = ?
    `).get(sourceRunId) as {
      task_id: string; profile_version_id: string | null; task_profile_version_id: string | null; state: string;
      commit_hash: string | null; diff_hash: string | null; pull_request_number: number | null; worktree_path: string | null; project_path: string;
    } | undefined;
    if (!source) throw Object.assign(new Error("원본 검증 실행을 찾을 수 없습니다."), { statusCode: 404 });
    const existing = this.database.prepare("SELECT id, source_run_id FROM verification_runs WHERE task_id = ? AND idempotency_key = ?")
      .get(source.task_id, idempotencyKey) as { id: string; source_run_id: string | null } | undefined;
    if (existing) {
      if (existing.source_run_id !== sourceRunId) throw Object.assign(new Error("멱등 키가 다른 검증 요청에 사용되었습니다."), { statusCode: 409 });
      return this.getRun(existing.id);
    }
    if (!["passed", "failed", "blocked"].includes(source.state)) throw Object.assign(new Error("종료된 검증 실행만 다시 검증할 수 있습니다."), { statusCode: 409 });
    if (!source.profile_version_id || source.profile_version_id !== source.task_profile_version_id) {
      throw Object.assign(new Error("원본 검증의 profile version이 현재 task와 일치하지 않습니다."), { statusCode: 409 });
    }
    if (!source.commit_hash || !source.diff_hash) throw Object.assign(new Error("원본 검증에 workspace 증거가 없습니다."), { statusCode: 409 });
    const cwd = path.resolve(source.worktree_path || source.project_path);
    let current: WorkspaceVerificationSnapshot;
    try { current = await this.snapshotter(cwd); }
    catch { throw Object.assign(new Error("현재 workspace snapshot을 만들 수 없습니다."), { statusCode: 409 }); }
    if (current.commitHash !== source.commit_hash || current.diffHash !== source.diff_hash) {
      throw Object.assign(new Error("동일 commit과 diff에서만 다시 검증할 수 있습니다."), { statusCode: 409 });
    }
    return this.createRun(source.task_id, idempotencyKey, userId, {
      trigger: "reverification", allowTerminalTask: true, sourceRunId, workspaceSnapshot: current,
      pullRequestNumber: source.pull_request_number ?? undefined,
    });
  }

  private async createRun(
    taskId: string,
    idempotencyKey: string,
    userId: number | null,
    options: { trigger: "manual" | "reverification"; allowTerminalTask: boolean; sourceRunId?: string; workspaceSnapshot?: WorkspaceVerificationSnapshot; pullRequestNumber?: number },
  ): Promise<Record<string, unknown>> {
    const task = this.database.prepare(`
      SELECT t.id, t.state, t.profile_version_id, c.preset_config_json, c.worktree_path, p.path AS project_path
      FROM agent_tasks t JOIN chats c ON c.id = t.chat_id JOIN projects p ON p.id = t.project_id WHERE t.id = ?
    `).get(taskId) as { id: string; state: string; profile_version_id: string | null; preset_config_json: string | null; worktree_path: string | null; project_path: string } | undefined;
    if (!task) throw Object.assign(new Error("작업을 찾을 수 없습니다."), { statusCode: 404 });
    if (!options.allowTerminalTask && ["completed", "cancelled", "budget_exceeded"].includes(task.state)) throw new Error("종료된 작업은 검증을 시작할 수 없습니다.");
    if (options.allowTerminalTask && ["cancelled", "budget_exceeded"].includes(task.state)) throw new Error("취소되거나 예산을 초과한 작업은 다시 검증할 수 없습니다.");
    const snapshot = task.preset_config_json ? JSON.parse(task.preset_config_json) : null;
    const recipe = recipeFromSnapshot(snapshot);
    const requirePullRequestChecks = pullRequestChecksRequired(snapshot);
    const cwd = path.resolve(task.worktree_path || task.project_path);
    const runId = crypto.randomUUID();
    let workspaceSnapshot: WorkspaceVerificationSnapshot | null = options.workspaceSnapshot ?? null;
    let snapshotError: string | null = null;
    if (!workspaceSnapshot) {
      try {
        workspaceSnapshot = await this.snapshotter(cwd);
      } catch {
        snapshotError = "workspace_snapshot_failed";
      }
    }
    const selection = selectRecipe(recipe, workspaceSnapshot?.changedFiles);
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO verification_runs(id, task_id, profile_version_id, source_run_id, idempotency_key, state, trigger, commit_hash, diff_hash, pull_request_number, summary_json, created_by) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
        .run(runId, taskId, task.profile_version_id, options.sourceRunId ?? null, idempotencyKey, options.trigger, workspaceSnapshot?.commitHash ?? null, workspaceSnapshot?.diffHash ?? null, options.pullRequestNumber ?? null, JSON.stringify({ snapshot: snapshotError ?? "captured", selection: selection.summary, gate: { pullRequestChecksRequired: requirePullRequestChecks } }), userId);
      this.appendTaskEvent(taskId, `verification:${runId}:created`, "verification.created", { runId, trigger: options.trigger, sourceRunId: options.sourceRunId ?? null, stepCount: recipe.length });
      this.appendTaskEvent(taskId, `verification:${runId}:recipe-selected`, "verification.recipe_selected", { runId, ...selection.summary });
    })();
    if (snapshotError) return this.block(runId, taskId, snapshotError);
    if (requirePullRequestChecks && !options.pullRequestNumber) return this.block(runId, taskId, "pull_request_number_required");
    if (selection.error) return this.block(runId, taskId, selection.error);
    if (!recipe.length) return this.block(runId, taskId, "verification_recipe_missing");
    if (!selection.selected.length) return this.block(runId, taskId, "verification_no_steps_selected");
    if (selection.selected.some((step) => !AUTOMATED_KINDS.has(step.kind))) return this.block(runId, taskId, "explicit_approval_required");
    return this.executeRecipe(runId, taskId, cwd, selection.selected, workspaceSnapshot!);
  }

  async decideBlockedRun(runId: string, decision: "approve" | "decline", idempotencyKey: string, userId: number): Promise<Record<string, unknown>> {
    const context = this.database.prepare(`
      SELECT r.state, r.summary_json, r.commit_hash, r.diff_hash, r.approval_idempotency_key,
             r.pull_request_number,
             t.id AS task_id, c.preset_config_json, c.worktree_path, p.path AS project_path
      FROM verification_runs r JOIN agent_tasks t ON t.id = r.task_id JOIN chats c ON c.id = t.chat_id
      JOIN projects p ON p.id = t.project_id WHERE r.id = ?
    `).get(runId) as { state: string; summary_json: string; commit_hash: string | null; diff_hash: string | null; approval_idempotency_key: string | null; pull_request_number: number | null; task_id: string; preset_config_json: string | null; worktree_path: string | null; project_path: string } | undefined;
    if (!context) throw Object.assign(new Error("검증 실행을 찾을 수 없습니다."), { statusCode: 404 });
    if (context.approval_idempotency_key === idempotencyKey) return this.getRun(runId);
    if (context.approval_idempotency_key) throw Object.assign(new Error("검증 승인 결정이 이미 처리되었습니다."), { statusCode: 409 });
    const reason = (JSON.parse(context.summary_json) as { reason?: unknown }).reason;
    if (context.state !== "blocked" || reason !== "explicit_approval_required") throw new Error("명시적 승인 대기 중인 검증만 결정할 수 있습니다.");
    if (decision === "decline") {
      this.database.transaction(() => {
        this.database.prepare("UPDATE verification_runs SET state = 'failed', approval_idempotency_key = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(idempotencyKey, userId, runId);
        this.mergeRunSummary(runId, { reason: "explicit_approval_declined" });
        this.database.prepare("UPDATE agent_tasks SET state = 'failed', state_reason = 'verification_approval_declined', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(context.task_id);
        this.appendTaskEvent(context.task_id, `verification:${runId}:approval:${idempotencyKey}`, "verification.approval_declined", { runId });
      })();
      return this.getRun(runId);
    }
    const cwd = path.resolve(context.worktree_path || context.project_path);
    let current: WorkspaceVerificationSnapshot;
    try { current = await this.snapshotter(cwd); } catch { return this.block(runId, context.task_id, "workspace_snapshot_failed_after_approval"); }
    if (current.commitHash !== context.commit_hash || current.diffHash !== context.diff_hash) return this.block(runId, context.task_id, "workspace_changed_after_approval_request");
    const recipe = recipeFromSnapshot(context.preset_config_json ? JSON.parse(context.preset_config_json) : null);
    const selection = selectRecipe(recipe, current.changedFiles);
    if (selection.error) return this.block(runId, context.task_id, selection.error);
    if (!selection.selected.length) return this.block(runId, context.task_id, "verification_no_steps_selected");
    this.database.prepare("UPDATE verification_runs SET approval_idempotency_key = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, finished_at = NULL WHERE id = ?")
      .run(idempotencyKey, userId, runId);
    this.appendTaskEvent(context.task_id, `verification:${runId}:approval:${idempotencyKey}`, "verification.approved", { runId });
    return this.executeRecipe(runId, context.task_id, cwd, selection.selected, current);
  }

  list(taskId: string, limit = 100): Record<string, unknown>[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
    const runs = this.database.prepare(`
      SELECT id, task_id, profile_version_id, source_run_id, state, trigger, commit_hash, diff_hash,
             pull_request_number, pull_request_head_sha, pull_request_checks_json, summary_json,
             created_by, approved_by, approved_at, started_at, finished_at, created_at
      FROM verification_runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(taskId, safeLimit) as Array<Record<string, unknown>>;
    if (!runs.length) return [];
    const ids = runs.map((run) => String(run.id));
    const placeholders = ids.map(() => "?").join(",");
    const steps = this.database.prepare(`
      SELECT id, run_id, ordinal, kind, timeout_ms, state, exit_code, duration_ms, started_at, finished_at
      FROM verification_steps WHERE run_id IN (${placeholders}) ORDER BY run_id, ordinal
    `).all(...ids) as Array<Record<string, unknown>>;
    const artifacts = this.database.prepare(`
      SELECT id, run_id, step_id, sha256, mime_type, size_bytes, redaction_status, created_at
      FROM verification_artifacts WHERE run_id IN (${placeholders}) ORDER BY run_id, created_at
    `).all(...ids) as Array<Record<string, unknown>>;
    const stepsByRun = new Map<string, Array<Record<string, unknown>>>();
    const artifactsByRun = new Map<string, Array<Record<string, unknown>>>();
    for (const step of steps) {
      const key = String(step.run_id);
      const bucket = stepsByRun.get(key) ?? [];
      bucket.push(step);
      stepsByRun.set(key, bucket);
    }
    for (const artifact of artifacts) {
      const key = String(artifact.run_id);
      const bucket = artifactsByRun.get(key) ?? [];
      bucket.push(artifact);
      artifactsByRun.set(key, bucket);
    }
    return runs.map((run) => ({ run, steps: stepsByRun.get(String(run.id)) ?? [], artifacts: artifactsByRun.get(String(run.id)) ?? [] }));
  }

  currentForChat(chatId: number): { task: Record<string, unknown> | null; verifications: Record<string, unknown>[]; hasMore: boolean } {
    const task = this.database.prepare(`
      SELECT t.id, t.chat_id, t.project_id, t.profile_version_id, t.state, t.state_reason,
             t.started_at, t.finished_at, t.created_at, t.updated_at,
             pv.version AS profile_version, preset.name AS profile_name
      FROM agent_tasks t
      LEFT JOIN agent_preset_versions pv ON pv.id = t.profile_version_id
      LEFT JOIN agent_presets preset ON preset.id = pv.preset_id
      WHERE t.chat_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1
    `).get(chatId) as Record<string, unknown> | undefined;
    if (!task) return { task: null, verifications: [], hasMore: false };
    const count = (this.database.prepare("SELECT COUNT(*) AS count FROM verification_runs WHERE task_id = ?").get(String(task.id)) as { count: number }).count;
    return { task, verifications: this.list(String(task.id), 20), hasMore: count > 20 };
  }

  getRun(runId: string): Record<string, unknown> {
    const run = this.database.prepare(`
      SELECT id, task_id, profile_version_id, source_run_id, state, trigger, commit_hash, diff_hash,
             pull_request_number, pull_request_head_sha, pull_request_checks_json, summary_json,
             created_by, approved_by, approved_at, started_at, finished_at, created_at
      FROM verification_runs WHERE id = ?
    `).get(runId) as Record<string, unknown> | undefined;
    if (!run) throw new Error("검증 실행을 찾을 수 없습니다.");
    const steps = this.database.prepare(`
      SELECT id, run_id, ordinal, kind, timeout_ms, state, exit_code, duration_ms, started_at, finished_at
      FROM verification_steps WHERE run_id = ? ORDER BY ordinal
    `).all(runId);
    const artifacts = this.database.prepare(`
      SELECT id, run_id, step_id, sha256, mime_type, size_bytes, redaction_status, created_at
      FROM verification_artifacts WHERE run_id = ? ORDER BY created_at
    `).all(runId);
    return { run, steps, artifacts };
  }

  artifactForDownload(artifactId: string): { path: string; filename: string; mimeType: string } {
    const artifact = this.database.prepare(`
      SELECT path, sha256, mime_type, redaction_status FROM verification_artifacts WHERE id = ?
    `).get(artifactId) as { path: string; sha256: string; mime_type: string; redaction_status: string } | undefined;
    if (!artifact) throw Object.assign(new Error("검증 artifact를 찾을 수 없습니다."), { statusCode: 404 });
    if (artifact.redaction_status !== "safe") throw Object.assign(new Error("redaction이 확인되지 않은 artifact는 제공할 수 없습니다."), { statusCode: 409 });
    const root = path.resolve(this.dataDir, "verification-artifacts");
    const resolved = path.resolve(artifact.path);
    if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw Object.assign(new Error("검증 artifact 경로가 올바르지 않습니다."), { statusCode: 409 });
    }
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
    if (actualHash !== artifact.sha256) throw Object.assign(new Error("검증 artifact hash가 일치하지 않습니다."), { statusCode: 409 });
    return { path: resolved, filename: `${artifactId}.log`, mimeType: artifact.mime_type };
  }

  recoverInterruptedRuns(): number {
    const runs = this.database.prepare("SELECT id, task_id FROM verification_runs WHERE state IN ('pending', 'running')").all() as Array<{ id: string; task_id: string }>;
    if (!runs.length) return 0;
    this.database.transaction(() => {
      for (const run of runs) {
        this.database.prepare("UPDATE verification_steps SET state = 'blocked', finished_at = CURRENT_TIMESTAMP WHERE run_id = ? AND state IN ('pending', 'running')").run(run.id);
        this.database.prepare("UPDATE verification_runs SET state = 'blocked', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(run.id);
        this.mergeRunSummary(run.id, { reason: "server_restart_reconciliation_required" });
        this.database.prepare("UPDATE agent_tasks SET state = 'needs_input', state_reason = 'verification_restart_reconciliation_required', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'verifying'").run(run.task_id);
        this.appendTaskEvent(run.task_id, `verification:${run.id}:restart-recovery`, "verification.blocked", { runId: run.id, reason: "server_restart_reconciliation_required" });
      }
    })();
    return runs.length;
  }

  cleanupExpiredArtifacts(now = new Date()): { deleted: number; skipped: number } {
    const cutoff = new Date(now.getTime() - Math.max(1, this.retentionDays) * 24 * 60 * 60 * 1_000).toISOString();
    const rows = this.database.prepare("SELECT id, path FROM verification_artifacts WHERE created_at < ? ORDER BY created_at").all(cutoff) as Array<{ id: string; path: string }>;
    const roots = [
      path.resolve(this.dataDir, "verification-artifacts"),
      path.resolve(this.dataDir, "verification-artifacts-quarantine"),
    ];
    let deleted = 0;
    let skipped = 0;
    for (const row of rows) {
      const resolved = path.resolve(row.path);
      if (!roots.some((root) => resolved.startsWith(`${root}${path.sep}`))) { skipped += 1; continue; }
      try {
        if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
        this.database.prepare("DELETE FROM verification_artifacts WHERE id = ?").run(row.id);
        deleted += 1;
      } catch {
        skipped += 1;
      }
    }
    return { deleted, skipped };
  }

  private async executeRecipe(runId: string, taskId: string, cwd: string, recipe: RecipeStep[], workspaceSnapshot: WorkspaceVerificationSnapshot): Promise<Record<string, unknown>> {
    this.database.transaction(() => {
      this.database.prepare("UPDATE verification_runs SET state = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = NULL WHERE id = ?").run(runId);
      this.database.prepare("UPDATE agent_tasks SET state = 'verifying', state_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
      this.appendTaskEvent(taskId, `verification:${runId}:started`, "verification.started", { runId });
    })();
    let failed = false;
    let blocked = false;
    for (const step of recipe) {
      const stepId = crypto.randomUUID();
      if (step.kind === "human_review") {
        this.database.prepare(`INSERT INTO verification_steps(id, run_id, ordinal, kind, command_json, cwd, timeout_ms, state, started_at, finished_at, duration_ms) VALUES (?, ?, ?, ?, NULL, ?, ?, 'passed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0)`)
          .run(stepId, runId, step.ordinal, step.kind, cwd, step.timeoutMs);
        this.appendTaskEvent(taskId, `verification:${runId}:step:${step.ordinal}`, "verification.step_finished", { runId, ordinal: step.ordinal, kind: step.kind, state: "passed", evidenceType: "explicit_human_approval" });
        continue;
      }
      this.database.prepare(`INSERT INTO verification_steps(id, run_id, ordinal, kind, command_json, cwd, timeout_ms, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', CURRENT_TIMESTAMP)`)
        .run(stepId, runId, step.ordinal, step.kind, JSON.stringify(step.argv), cwd, step.timeoutMs);
      let result: VerificationExecutorResult;
      try { result = await this.executor(step.argv, cwd, step.timeoutMs); }
      catch (error) { result = { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: 0 }; }
      const redacted = redactVerificationOutput(`${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`, this.homeDir);
      const state = redacted.status === "blocked" ? "blocked" : result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed";
      const artifact = this.storeArtifact(runId, stepId, redacted.text, redacted.status);
      this.database.prepare("UPDATE verification_steps SET state = ?, exit_code = ?, duration_ms = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(state, result.exitCode, result.durationMs, stepId);
      this.appendTaskEvent(taskId, `verification:${runId}:step:${step.ordinal}`, "verification.step_finished", { runId, ordinal: step.ordinal, kind: step.kind, state, artifactId: artifact.id });
      if (state === "blocked") { blocked = true; break; }
      if (state !== "passed" && step.required) { failed = true; break; }
    }
    let pullRequestGate: { state: "passed" | "failed" | "blocked"; reason: string } | null = null;
    if (!blocked && !failed) pullRequestGate = await this.evaluatePullRequestGate(runId, taskId, cwd, workspaceSnapshot);
    this.database.transaction(() => {
      const runState = blocked ? "blocked" : failed ? "failed" : pullRequestGate?.state ?? "passed";
      const taskState = runState === "blocked" ? "needs_input" : runState === "failed" ? "failed" : "completed";
      const reason = blocked ? "verification_artifact_redaction_blocked" : failed ? "verification_failed" : pullRequestGate?.reason ?? "verification_passed";
      this.database.prepare("UPDATE verification_runs SET state = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(runState, runId);
      this.mergeRunSummary(runId, { result: runState, reason, local: { state: blocked ? "blocked" : failed ? "failed" : "passed" } });
      this.database.prepare(`UPDATE agent_tasks SET state = ?, state_reason = ?,
        finished_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE finished_at END,
        last_verified_checkpoint = CASE WHEN ? = 'completed' THEN ? ELSE last_verified_checkpoint END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(taskState, reason, taskState, taskState, taskState === "completed" ? JSON.stringify({ runId, commitHash: workspaceSnapshot.commitHash, diffHash: workspaceSnapshot.diffHash, verifiedAt: new Date().toISOString() }) : null, taskId);
      this.appendTaskEvent(taskId, `verification:${runId}:${runState}`, `verification.${runState}`, { runId, reason });
    })();
    return this.getRun(runId);
  }

  private async evaluatePullRequestGate(
    runId: string,
    taskId: string,
    cwd: string,
    expectedWorkspace: WorkspaceVerificationSnapshot,
  ): Promise<{ state: "passed" | "failed" | "blocked"; reason: string } | null> {
    const run = this.database.prepare("SELECT pull_request_number, commit_hash, diff_hash FROM verification_runs WHERE id = ?").get(runId) as {
      pull_request_number: number | null; commit_hash: string | null; diff_hash: string | null;
    };
    if (!run.pull_request_number) return null;
    const number = run.pull_request_number;
    let currentWorkspace: WorkspaceVerificationSnapshot;
    try { currentWorkspace = await this.snapshotter(cwd); }
    catch { return this.recordPullRequestGate(runId, taskId, { number, state: "unavailable", reason: "workspace_snapshot_failed_after_verification" }, "blocked"); }
    if (currentWorkspace.commitHash !== expectedWorkspace.commitHash || currentWorkspace.diffHash !== expectedWorkspace.diffHash) {
      return this.recordPullRequestGate(runId, taskId, { number, state: "unavailable", reason: "workspace_changed_during_verification" }, "blocked");
    }
    if (currentWorkspace.clean !== true) {
      return this.recordPullRequestGate(runId, taskId, { number, state: "unavailable", reason: "pull_request_workspace_not_clean" }, "blocked");
    }
    let checks: PullRequestCheckSnapshot;
    try { checks = await this.pullRequestReader(cwd, number); }
    catch { return this.recordPullRequestGate(runId, taskId, { number, state: "unavailable", reason: "pull_request_checks_unavailable" }, "blocked"); }
    const summary = {
      number,
      state: checks.state,
      headSha: checks.headSha,
      totalCount: checks.totalCount,
      passedCount: checks.passedCount,
      failedCount: checks.failedCount,
      pendingCount: checks.pendingCount,
      unavailableCount: checks.unavailableCount,
      reason: checks.headSha !== run.commit_hash
        ? "pull_request_head_mismatch"
        : checks.state === "passed"
          ? "pull_request_checks_passed"
          : checks.state === "failed"
            ? "pull_request_checks_failed"
            : checks.state === "pending"
              ? "pull_request_checks_pending"
              : "pull_request_checks_unavailable",
    };
    const state = summary.reason === "pull_request_checks_passed" ? "passed" : summary.reason === "pull_request_checks_failed" ? "failed" : "blocked";
    return this.recordPullRequestGate(runId, taskId, summary, state);
  }

  private recordPullRequestGate(
    runId: string,
    taskId: string,
    summary: Record<string, unknown> & { number: number; state: string; reason: string },
    state: "passed" | "failed" | "blocked",
  ): { state: "passed" | "failed" | "blocked"; reason: string } {
    this.database.prepare("UPDATE verification_runs SET pull_request_head_sha = ?, pull_request_checks_json = ? WHERE id = ?")
      .run(typeof summary.headSha === "string" ? summary.headSha : null, JSON.stringify(summary), runId);
    this.mergeRunSummary(runId, { pullRequest: summary });
    this.appendTaskEvent(taskId, `verification:${runId}:pull-request`, "verification.pull_request_checked", {
      runId,
      number: summary.number,
      state: summary.state,
      reason: summary.reason,
      totalCount: summary.totalCount ?? 0,
      passedCount: summary.passedCount ?? 0,
      failedCount: summary.failedCount ?? 0,
      pendingCount: summary.pendingCount ?? 0,
      unavailableCount: summary.unavailableCount ?? 0,
    });
    return { state, reason: summary.reason };
  }

  private block(runId: string, taskId: string, reason: string): Record<string, unknown> {
    this.database.transaction(() => {
      this.database.prepare("UPDATE verification_runs SET state = 'blocked', finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(runId);
      this.mergeRunSummary(runId, { reason });
      this.database.prepare("UPDATE agent_tasks SET state = 'needs_input', state_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reason, taskId);
      this.appendTaskEvent(taskId, `verification:${runId}:blocked:${reason}`, "verification.blocked", { runId, reason });
    })();
    return this.getRun(runId);
  }

  private mergeRunSummary(runId: string, patch: Record<string, unknown>): void {
    const row = this.database.prepare("SELECT summary_json FROM verification_runs WHERE id = ?").get(runId) as { summary_json: string } | undefined;
    const current = row ? JSON.parse(row.summary_json) as Record<string, unknown> : {};
    this.database.prepare("UPDATE verification_runs SET summary_json = ? WHERE id = ?").run(JSON.stringify({ ...current, ...patch }), runId);
  }

  private storeArtifact(runId: string, stepId: string, output: string, redactionStatus: "safe" | "blocked"): { id: string } {
    const id = crypto.randomUUID();
    const rootName = redactionStatus === "safe" ? "verification-artifacts" : "verification-artifacts-quarantine";
    const directory = path.join(this.dataDir, rootName, runId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(directory, `${stepId}.log`);
    fs.writeFileSync(filePath, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const hash = crypto.createHash("sha256").update(output).digest("hex");
    this.database.prepare(`INSERT INTO verification_artifacts(id, run_id, step_id, path, sha256, mime_type, size_bytes, redaction_status) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?)`)
      .run(id, runId, stepId, filePath, hash, Buffer.byteLength(output), redactionStatus);
    return { id };
  }

  private appendTaskEvent(taskId: string, idempotencyKey: string, type: string, payload: Record<string, unknown>): void {
    const sequence = (this.database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM agent_task_events WHERE task_id = ?").get(taskId) as { value: number }).value;
    this.database.prepare("INSERT OR IGNORE INTO agent_task_events(id, task_id, sequence, idempotency_key, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, sequence, idempotencyKey, type, JSON.stringify(payload));
  }
}
